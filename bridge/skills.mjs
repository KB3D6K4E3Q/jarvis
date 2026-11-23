import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROMPT_ROUTINES, routineTools, startRoutines } from './routines.mjs'

/**
 * The `jarvis_skills` tools — everyday abilities that live in this process.
 *
 *   Mac control   open / quit apps, volume, music, lock the screen, battery.
 *                 A fixed list of actions with fixed arguments — never a shell.
 *   Timers        countdowns and reminders that survive a restart and speak
 *                 when they go off (a macOS notification if the face is closed).
 *   Routines      repeating and unprompted things, with quiet hours — see
 *                 routines.mjs.
 *   Memory        things the user asks JARVIS to remember, in a JSON file.
 *   Weather       Open-Meteo, which needs no account or key.
 *
 * Plus customSkillsPrompt(): plain-text routines the user writes themselves in
 * ~/.jarvis/skills/*.md, folded into the system prompt on every connection.
 *
 * Everything persistent sits in the JARVIS workspace, never elsewhere on disk.
 */

const run = promisify(execFile)
const IS_MAC = platform() === 'darwin'

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Numbers arrive as strings as often as numbers; nothing here rejects. */
const looseNumber = (note) =>
  z.union([z.number(), z.string()]).optional().catch(undefined).describe(note)
const looseText = (note) => z.string().optional().catch(undefined).describe(note)

function num(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : undefined
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** Write-then-rename, so a crash mid-write never leaves half a file. */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

const newId = () => Math.random().toString(36).slice(2, 8)

function localStamp(date = new Date()) {
  return date.toLocaleString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function spokenDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts = []
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`)
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`)
  if (s && !h) parts.push(`${s} second${s === 1 ? '' : 's'}`)
  return parts.join(' ') || 'a moment'
}

/** AppleScript with its input as argv, so no user text is ever spliced into code. */
async function osa(lines, args = []) {
  const flags = lines.flatMap((l) => ['-e', l])
  const { stdout } = await run('osascript', [...flags, ...args], { timeout: 8000 })
  return stdout.trim()
}

// ---------------------------------------------------------------------------
// Mac control
// ---------------------------------------------------------------------------

const APP_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  '/System/Applications',
  '/System/Applications/Utilities',
  join(homedir(), 'Applications'),
]

function installedApps() {
  const apps = new Map()
  for (const dir of APP_DIRS) {
    let entries = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (extname(entry) !== '.app') continue
      const name = basename(entry, '.app')
      if (!apps.has(name.toLowerCase())) apps.set(name.toLowerCase(), { name, path: join(dir, entry) })
    }
  }
  return apps
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

/** Best installed match for a spoken app name: exact, then prefix, then contains. */
export function findApp(spoken, apps = installedApps()) {
  const want = norm(String(spoken ?? ''))
  if (!want) return null
  const all = [...apps.values()]
  return (
    all.find((a) => norm(a.name) === want) ??
    all.find((a) => norm(a.name).startsWith(want)) ??
    all.find((a) => norm(a.name).includes(want)) ??
    null
  )
}

async function musicPlayer() {
  for (const app of ['Spotify', 'Music']) {
    try {
      const running = await osa(['on run argv', 'return application (item 1 of argv) is running', 'end run'], [app])
      if (running === 'true') return app
    } catch {}
  }
  return installedApps().has('spotify') ? 'Spotify' : 'Music'
}

function macTools() {
  if (!IS_MAC) return []
  return [
    tool(
      'mac_open_app',
      'Open (or bring to the front) an app on this Mac by name, e.g. "Safari", "spotify", "system settings". Fuzzy-matched against the installed apps.',
      { app: z.string().describe('The app name as the user said it.') },
      async ({ app }) => {
        const found = findApp(app)
        if (!found) return fail(`No installed app matches "${app}".`)
        await run('open', ['-a', found.path], { timeout: 8000 })
        return ok(`Opened ${found.name}.`)
      },
    ),
    tool(
      'mac_quit_app',
      'Quit an app on this Mac by name. The app may ask to save unsaved work.',
      { app: z.string().describe('The app name as the user said it.') },
      async ({ app }) => {
        const found = findApp(app)
        if (!found) return fail(`No installed app matches "${app}".`)
        await osa(['on run argv', 'tell application (item 1 of argv) to quit', 'end run'], [found.name])
        return ok(`Asked ${found.name} to quit.`)
      },
    ),
    tool(
      'mac_volume',
      'Read or change the Mac output volume. Give level 0-100, or change e.g. +10 / -20, or mute true/false. With nothing, just reports the volume.',
      {
        level: looseNumber('Absolute volume, 0-100.'),
        change: looseNumber('Relative change, e.g. 10 or -10.'),
        mute: z.union([z.boolean(), z.string()]).optional().catch(undefined).describe('true to mute, false to unmute.'),
      },
      async ({ level, change, mute }) => {
        const current = Number(await osa(['output volume of (get volume settings)'])) || 0
        let target = num(level)
        if (target === undefined && num(change) !== undefined) target = current + num(change)
        if (target !== undefined) {
          target = Math.round(Math.min(100, Math.max(0, target)))
          await osa(['on run argv', 'set volume output volume (item 1 of argv as integer)', 'end run'], [String(target)])
        }
        if (mute !== undefined) {
          const on = mute === true || /^(true|yes|on|1)$/i.test(String(mute))
          await osa([on ? 'set volume with output muted' : 'set volume without output muted'])
        }
        const now = await osa(['output volume of (get volume settings)'])
        const muted = await osa(['output muted of (get volume settings)'])
        return ok(`Volume is ${now}%${muted === 'true' ? ', muted' : ''}.`)
      },
    ),
    tool(
      'mac_music',
      'Control music in Spotify or Apple Music (whichever is running): play, pause, toggle, next, previous, or now_playing to hear what is on.',
      {
        action: z
          .enum(['play', 'pause', 'toggle', 'next', 'previous', 'now_playing'])
          .catch('now_playing')
          .describe('What to do.'),
      },
      async ({ action }) => {
        const app = await musicPlayer()
        const verb = {
          play: 'play',
          pause: 'pause',
          toggle: 'playpause',
          next: 'next track',
          previous: 'previous track',
        }[action]
        if (verb) {
          const named = app === 'Spotify' || app === 'Music' ? app : null
          if (named) await osa([`tell application "${named}" to ${verb}`])
          else await osa(['on run argv', `tell application (item 1 of argv) to ${verb}`, 'end run'], [app])
        }
        try {
          const info = await osa(
            [
              'on run argv',
              'tell application (item 1 of argv)',
              'if player state is playing then',
              'return (name of current track) & " by " & (artist of current track)',
              'else',
              'return "paused"',
              'end if',
              'end tell',
              'end run',
            ],
            [app],
          )
          return ok(`${app}: ${info}.`)
        } catch {
          return ok(`${app}: done.`)
        }
      },
    ),
    tool(
      'mac_lock_screen',
      'Turn off the display now, which locks the Mac if it requires a password after sleep. Only when the user asks.',
      {},
      async () => {
        await run('pmset', ['displaysleepnow'], { timeout: 5000 })
        return ok('Screen is off.')
      },
    ),
    tool(
      'mac_status',
      'Battery level, charging state and the current time on this Mac.',
      {},
      async () => {
        let battery = 'unknown'
        try {
          const { stdout } = await run('pmset', ['-g', 'batt'], { timeout: 5000 })
          const m = stdout.match(/(\d+)%;\s*([^;]+);\s*([^\n]*)/)
          if (m) battery = `${m[1]}%, ${m[2].trim()}${m[3] && !/present/.test(m[3]) ? `, ${m[3].trim()}` : ''}`
          else if (/AC Power/.test(stdout)) battery = 'on mains power, no battery'
        } catch {}
        return ok(`Battery: ${battery}. Time: ${localStamp()}.`)
      },
    ),
  ]
}

// ---------------------------------------------------------------------------
// Spotify — play exactly what they ask for, not just play/pause
// ---------------------------------------------------------------------------

/** An open.spotify.com link or a spotify: URI, to a spotify: URI — or null. */
export function spotifyUri(input) {
  const s = String(input ?? '').trim()
  const uri = s.match(/^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]{10,40})$/)
  if (uri) return s
  const url = s.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:embed\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{10,40})/)
  return url ? `spotify:${url[1]}:${url[2]}` : null
}

const SPOTIFY = (body) => ['on run argv', 'tell application "Spotify"', ...body, 'end tell', 'end run']

async function spotifyReady() {
  if (!installedApps().has('spotify')) throw new Error('Spotify is not installed')
  const running = await osa(['return application "Spotify" is running'])
  if (running !== 'true') {
    await run('open', ['-a', 'Spotify'], { timeout: 8000 })
    await new Promise((r) => setTimeout(r, 2500))
  }
}

async function nowPlaying() {
  try {
    return await osa(
      SPOTIFY([
        'if player state is playing then',
        'return (name of current track) & " by " & (artist of current track) & " — " & (album of current track)',
        'else',
        'return "nothing playing"',
        'end if',
      ]),
    )
  } catch {
    return 'unknown'
  }
}

// Spotify search — resolve a name to a real spotify: URI directly, instead of
// detouring through a web search and hoping a link turns up. Tries app
// credentials first, then the token the web player hands to anyone.
let spotifyToken = { value: null, expires: 0 }

async function spotifyAccessToken() {
  if (spotifyToken.value && Date.now() < spotifyToken.expires - 30000) return spotifyToken.value
  const id = process.env.SPOTIFY_CLIENT_ID
  const secret = process.env.SPOTIFY_CLIENT_SECRET
  if (id && secret) {
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
    if (res.ok) {
      const json = await res.json()
      spotifyToken = { value: json.access_token, expires: Date.now() + (json.expires_in ?? 3600) * 1000 }
      return spotifyToken.value
    }
  }
  // A token dropped here by hand (or by the web player) is honoured next.
  try {
    const { readFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const raw = JSON.parse(readFileSync(`${homedir()}/.jarvis/state/spotify-token.json`, 'utf8'))
    const value = raw.accessToken ?? raw.access_token ?? raw.token
    const expires = raw.accessTokenExpirationTimestampMs ?? raw.expires ?? 0
    if (value && (!expires || Date.now() < expires - 30000)) {
      spotifyToken = { value, expires: expires || Date.now() + 1800000 }
      return spotifyToken.value
    }
  } catch {}
  // Spotify retired the anonymous web-player token in 2025, so there is no
  // third source. Say so plainly rather than opening windows.
  throw new Error('no Spotify API credentials (set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET)')
}

const SPOTIFY_KINDS = ['track', 'album', 'playlist', 'artist', 'show', 'episode']

async function spotifySearch(query, kind, limit) {
  const token = await spotifyAccessToken()
  const url =
    `https://api.spotify.com/v1/search?type=${kind}&limit=${limit}` +
    `&q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8000),
    headers: { authorization: `Bearer ${token}` },
  })
  if (res.status === 401 || res.status === 403) {
    spotifyToken = { value: null, expires: 0 }
    throw new Error(`Spotify rejected the token (${res.status})`)
  }
  if (!res.ok) throw new Error(`Spotify search answered ${res.status}`)
  const json = await res.json()
  return (json[`${kind}s`]?.items ?? []).filter(Boolean).map((item) => ({
    name: item.name,
    uri: item.uri,
    by:
      item.artists?.map((a) => a.name).join(', ') ||
      item.owner?.display_name ||
      item.publisher ||
      '',
    note: item.album?.name || (item.tracks?.total ? `${item.tracks.total} tracks` : '') || '',
  }))
}

function spotifyTools() {
  if (!IS_MAC || !installedApps().has('spotify')) return []
  return [
    tool(
      'spotify_play',
      'Play a specific song, album, playlist, artist or podcast in Spotify. Needs its Spotify link or URI: when they name something ("play Bohemian Rhapsody", "play lofi beats playlist"), ' +
        'first WebSearch for it with "site:open.spotify.com", take the best open.spotify.com/track|album|playlist|artist link, and pass it here. ' +
        'If no link turns up, pass search instead to open Spotify\'s search for them.',
      {
        link: looseText('An open.spotify.com link or spotify: URI.'),
        search: looseText('Fallback: words to search for in the Spotify app.'),
      },
      async ({ link, search }) => {
        try {
          await spotifyReady()
          const uri = spotifyUri(link)
          if (uri) {
            await osa(SPOTIFY(['play track (item 1 of argv)']), [uri])
            await new Promise((r) => setTimeout(r, 1200))
            return ok(`Playing. Now: ${await nowPlaying()}.`)
          }
          if (search) {
            return fail(
              `No link given. WebSearch "site:open.spotify.com ${search}" and call again with the link — ` +
                `opening the Spotify window is not acceptable.`,
            )
          }
          return fail('Give a Spotify link (search the web for it first) or search words.')
        } catch (err) {
          return fail(`Spotify: ${err.message}`)
        }
      },
    ),
    tool(
      'spotify_search',
      'Search Spotify by name and get real spotify: URIs back. Use this FIRST for "play <song/album/playlist/artist>" — it replaces the old detour through a web search. ' +
        'Set play true to start the best match straight away; leave it off to offer them a choice, then pass the chosen uri to spotify_play.',
      {
        query: looseText('What to look for, e.g. "bohemian rhapsody", "lofi beats".'),
        kind: looseText('track (default), album, playlist, artist, show or episode.'),
        limit: looseNumber('How many results, 1-10. Default 6.'),
        play: onOff('true to play the top result immediately.'),
      },
      async ({ query, kind, limit, play }) => {
        const words = String(query ?? '').trim()
        if (!words) return fail('Give something to search for.')
        const type = SPOTIFY_KINDS.includes(String(kind ?? '').toLowerCase())
          ? String(kind).toLowerCase()
          : 'track'
        const count = Math.min(10, Math.max(1, Math.round(num(limit) ?? 6)))
        let hits
        try {
          hits = await spotifySearch(words, type, count)
        } catch (err) {
          return fail(
            `Spotify's API is unavailable (${err.message}). Do NOT open the Spotify app's search. ` +
              `Instead WebSearch "site:open.spotify.com ${words}", take the best ` +
              `open.spotify.com/track|album|playlist|artist link, and call spotify_play with it — ` +
              `that plays in the background without changing the user's windows.`,
          )
        }
        if (!hits.length) return fail(`Nothing on Spotify matches "${words}".`)
        const lines = hits
          .map((h, i) => `${i + 1}. ${h.name}${h.by ? ` — ${h.by}` : ''}${h.note ? ` (${h.note})` : ''} ${h.uri}`)
          .join('\n')
        if (!wantOn(play, false)) return ok(`${type} results for "${words}":\n${lines}`)
        try {
          await spotifyReady()
          await osa(SPOTIFY(['play track (item 1 of argv)']), [hits[0].uri])
          await new Promise((r) => setTimeout(r, 1200))
          return ok(`Playing. Now: ${await nowPlaying()}.\nOther matches:\n${lines}`)
        } catch (err) {
          return fail(`Found it, but playback failed: ${err.message}\n${lines}`)
        }
      },
    ),
    tool(
      'spotify_control',
      'Spotify settings while playing: shuffle on/off, repeat on/off, Spotify\'s own volume 0-100, skip forward/back by seconds, or now_playing.',
      {
        shuffle: onOff('true / false.'),
        repeat: onOff('true / false.'),
        volume: looseNumber('Spotify volume 0-100 (not the Mac volume).'),
        seek: looseNumber('Seconds to jump: 30 forward, -15 back.'),
      },
      async ({ shuffle, repeat, volume, seek }) => {
        try {
          await spotifyReady()
          const sh = wantOn(shuffle, false)
          const rp = wantOn(repeat, false)
          if (sh !== undefined) await osa(SPOTIFY([`set shuffling to ${sh}`]))
          if (rp !== undefined) await osa(SPOTIFY([`set repeating to ${rp}`]))
          if (num(volume) !== undefined) {
            await osa(SPOTIFY(['set sound volume to (item 1 of argv as integer)']), [String(Math.round(Math.min(100, Math.max(0, num(volume)))))])
          }
          if (num(seek) !== undefined) {
            await osa(SPOTIFY(['set player position to (player position + (item 1 of argv as real))']), [String(num(seek))])
          }
          const state = await osa(SPOTIFY(['return "shuffle " & shuffling & ", repeat " & repeating & ", volume " & sound volume']))
          return ok(`${await nowPlaying()}. (${state})`)
        } catch (err) {
          return fail(`Spotify: ${err.message}`)
        }
      },
    ),
  ]
}

// ---------------------------------------------------------------------------
// Phone alerts — push notifications through ntfy (https://ntfy.sh)
// ---------------------------------------------------------------------------
//
// Free, no account. The phone runs the ntfy app subscribed to one topic; a
// POST to that topic pops up on the phone with a sound. The topic name is the
// only secret, so it is long and random, and kept in the state folder.

let settingsDir = null
const settingsFile = () => join(settingsDir, 'settings.json')
const NTFY = (process.env.JARVIS_NTFY_SERVER || 'https://ntfy.sh').replace(/\/+$/, '')

export function phoneTopic({ create = false } = {}) {
  if (process.env.JARVIS_NTFY_TOPIC) return process.env.JARVIS_NTFY_TOPIC
  if (!settingsDir) return null
  const settings = readJson(settingsFile(), {})
  if (settings.phoneTopic || !create) return settings.phoneTopic ?? null
  const topic = `jarvis-${Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join('')}`
  writeJson(settingsFile(), { ...settings, phoneTopic: topic })
  return topic
}

/** Send one alert to the phone. Throws if it could not be delivered. */
export async function sendPhoneAlert(message, { title = 'JARVIS', urgent = true } = {}) {
  const topic = phoneTopic()
  if (!topic) throw new Error('the phone is not set up yet (phone_setup)')
  const res = await fetch(`${NTFY}/${encodeURIComponent(topic)}`, {
    method: 'POST',
    body: String(message).slice(0, 1000),
    headers: {
      Title: String(title).replace(/[^\x20-\x7e]/g, '').slice(0, 100) || 'JARVIS',
      // 5 = max: long vibration and sound. 3 = an ordinary notification.
      Priority: urgent ? '5' : '3',
      Tags: urgent ? 'rotating_light' : 'robot',
    },
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`ntfy answered ${res.status}`)
}

function phoneTools() {
  return [
    tool(
      'phone_setup',
      'Set up (or show) alerts to the user\'s phone. Returns the topic name to subscribe to in the free ntfy app. Show it on screen, never read the topic letters aloud.',
      {},
      async () => {
        const topic = phoneTopic({ create: true })
        return ok(
          `Phone topic: ${topic}\nOn the phone: install "ntfy" from the App Store or Google Play, tap +, enter the topic exactly, Subscribe, and allow notifications. ` +
            `Subscribe link: ${NTFY}/${topic}\nThen send a test with phone_alert.`,
        )
      },
    ),
    tool(
      'phone_alert',
      '"Call me", "ping my phone", "alert my phone": push a loud alert with a short message to the user\'s phone, wherever they are. It is a notification, not a ringing phone call. Not set up yet? Use phone_setup.',
      {
        message: z.string().describe('What the alert says, e.g. "Leave for the airport now."'),
        urgent: z.union([z.boolean(), z.string()]).optional().catch(undefined).describe('Default true (loud). false for a quiet one.'),
      },
      async ({ message, urgent }) => {
        try {
          await sendPhoneAlert(message, { urgent: !(urgent === false || /^(false|no|0)$/i.test(String(urgent ?? ''))) })
          return ok('Alert sent to the phone.')
        } catch (err) {
          return fail(`Couldn't alert the phone: ${err.message}.`)
        }
      },
    ),
  ]
}

// ---------------------------------------------------------------------------
// Timers and reminders
// ---------------------------------------------------------------------------

/** Every connected face. A timer that fires speaks on all of them. */
const listeners = new Set()

/** Register a face; returns the function that unregisters it. */
export function onAnnounce(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

let timerFile = null
let timers = []
let ticking = null

function saveTimers() {
  if (timerFile) writeJson(timerFile, timers)
}

async function notifyMac(title, text) {
  if (!IS_MAC) return
  try {
    await osa(
      ['on run argv', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', 'end run'],
      [title, text],
    )
  } catch {}
}

function fire(t) {
  const text =
    t.kind === 'timer'
      ? `Sir, your ${t.label ? `${t.label} ` : ''}timer is done.`
      : `Sir, a reminder: ${t.label}.`
  console.log(`[jarvis] ${t.kind} fired: ${t.label || t.id}`)
  if (listeners.size) for (const fn of listeners) fn({ text, kind: t.kind, label: t.label })
  else void notifyMac('JARVIS', text.replace(/^Sir, /, ''))
  // Asked for on this one, or nobody is at the Mac to hear it: the phone too.
  if (t.phone || (!listeners.size && phoneTopic())) {
    sendPhoneAlert(text.replace(/^Sir, /, ''), { title: t.kind === 'timer' ? 'Timer' : 'Reminder' }).catch((err) =>
      console.warn(`[jarvis] phone alert failed: ${err.message}`),
    )
  }
}

function tick() {
  const now = Date.now()
  const due = timers.filter((t) => t.at <= now)
  if (!due.length) return
  timers = timers.filter((t) => t.at > now)
  saveTimers()
  // One missed by more than a day (the bridge was off) is reported, not spoken as if fresh.
  for (const t of due) {
    if (now - t.at > 24 * 3600_000) continue
    fire(t)
  }
}

function startTimers(stateDir) {
  if (ticking) return
  timerFile = join(stateDir, 'timers.json')
  timers = readJson(timerFile, []).filter((t) => t && typeof t.at === 'number')
  ticking = setInterval(tick, 1000)
  ticking.unref?.()
  tick()
}

/**
 * When a reminder is for. `at` is "17:30", "5pm", "5:30 pm" (today, or
 * tomorrow if that time has passed) or a full ISO date-time.
 */
export function parseWhen({ seconds, minutes, hours, at }, now = new Date()) {
  const offset = (num(seconds) ?? 0) * 1000 + (num(minutes) ?? 0) * 60_000 + (num(hours) ?? 0) * 3600_000
  if (offset > 0) return now.getTime() + offset
  if (!at) return null
  const s = String(at).trim().toLowerCase()
  const clock = s.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/)
  if (clock) {
    let h = Number(clock[1])
    const m = Number(clock[2] ?? 0)
    if (clock[3] === 'pm' && h < 12) h += 12
    if (clock[3] === 'am' && h === 12) h = 0
    if (h > 23 || m > 59) return null
    const d = new Date(now)
    d.setHours(h, m, 0, 0)
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const parsed = Date.parse(String(at))
  return Number.isFinite(parsed) ? parsed : null
}

function describeTimer(t, now = Date.now()) {
  const when =
    t.kind === 'timer'
      ? `${spokenDuration(t.at - now)} left`
      : new Date(t.at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  return `[${t.id}] ${t.kind}${t.label ? ` "${t.label}"` : ''} — ${when}`
}

function timerTools() {
  const when = {
    seconds: looseNumber('Seconds from now.'),
    minutes: looseNumber('Minutes from now.'),
    hours: looseNumber('Hours from now.'),
    at: looseText('A clock time like "17:30" or "5pm" (next occurrence), or an ISO date-time.'),
  }
  return [
    tool(
      'timer_set',
      'Start a countdown timer, e.g. "10 minute pasta timer". Give the duration in seconds/minutes/hours. When it ends JARVIS says so out loud.',
      { ...when, label: looseText('Short name, e.g. "pasta". Optional.'), phone: looseText('"true" to also alert their phone.') },
      async (args) => {
        const at = parseWhen({ ...args, at: undefined })
        if (!at) return fail('Give the timer a duration.')
        const t = { id: newId(), kind: 'timer', label: (args.label ?? '').slice(0, 80), at, set: Date.now(), phone: /^(true|yes|1)$/i.test(String(args.phone ?? '')) }
        timers.push(t)
        saveTimers()
        return ok(`Timer set: ${spokenDuration(at - Date.now())}. ${describeTimer(t)}`)
      },
    ),
    tool(
      'reminder_set',
      'Remind the user of something later, e.g. "remind me at 5 to call mom" or "in 2 hours to stretch". JARVIS speaks the reminder when it is due.',
      {
        ...when,
        text: z.string().describe('What to remind them of, in a few words.'),
        phone: looseText('"true" to also alert their phone ("remind me on my phone…", or they will be away from the Mac).'),
      },
      async (args) => {
        const at = parseWhen(args)
        if (!at) return fail('I need a time ("17:30") or a delay (minutes/hours).')
        const t = { id: newId(), kind: 'reminder', label: String(args.text).slice(0, 200), at, set: Date.now(), phone: /^(true|yes|1)$/i.test(String(args.phone ?? '')) }
        timers.push(t)
        saveTimers()
        return ok(`Reminder set for ${new Date(at).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit' })}. ${describeTimer(t)}`)
      },
    ),
    tool(
      'timer_list',
      'List running timers and upcoming reminders, soonest first.',
      {},
      async () => {
        if (!timers.length) return ok('No timers or reminders.')
        const now = Date.now()
        return ok([...timers].sort((a, b) => a.at - b.at).map((t) => describeTimer(t, now)).join('\n'))
      },
    ),
    tool(
      'timer_cancel',
      'Cancel a timer or reminder by its id, or by words from its label. "all" cancels everything.',
      { which: z.string().describe('An id from timer_list, words from the label, or "all".') },
      async ({ which }) => {
        const w = String(which).trim().toLowerCase()
        const before = timers.length
        if (w === 'all') timers = []
        else timers = timers.filter((t) => t.id !== w && !(t.label && t.label.toLowerCase().includes(w)))
        const removed = before - timers.length
        saveTimers()
        return removed ? ok(`Cancelled ${removed}.`) : fail(`Nothing matches "${which}".`)
      },
    ),
  ]
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

const MAX_MEMORIES = 500

export function searchMemories(memories, query, limit = 15) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
  if (!words.length) return memories.slice(-limit).reverse()
  return memories
    .map((m) => {
      const hay = `${m.text} ${m.topic ?? ''}`.toLowerCase()
      return { m, score: words.filter((w) => hay.includes(w)).length }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.saved - a.m.saved)
    .slice(0, limit)
    .map((x) => x.m)
}

function memoryTools(stateDir) {
  const file = join(stateDir, 'memory.json')
  const load = () => readJson(file, [])
  const line = (m) => `[${m.id}] ${m.topic ? `(${m.topic}) ` : ''}${m.text}`
  return [
    tool(
      'memory_save',
      'Remember a fact the user tells you to remember, or a lasting preference they state ("I take my coffee black"). One fact per call, in the third person.',
      {
        text: z.string().describe('The fact, e.g. "Spare house key is under the blue pot."'),
        topic: looseText('One or two words to file it under, e.g. "home", "family".'),
      },
      async ({ text, topic }) => {
        const memories = load()
        const m = { id: newId(), text: String(text).slice(0, 500), topic: topic?.slice(0, 40), saved: Date.now() }
        memories.push(m)
        writeJson(file, memories.slice(-MAX_MEMORIES))
        return ok(`Saved. ${line(m)}`)
      },
    ),
    tool(
      'memory_search',
      'Look up what the user asked you to remember. Use it before saying you do not know something personal about them. An empty query lists the most recent.',
      { query: looseText('Words to look for. Empty lists recent memories.') },
      async ({ query }) => {
        const found = searchMemories(load(), query)
        return ok(found.length ? found.map(line).join('\n') : 'Nothing remembered about that.')
      },
    ),
    tool(
      'memory_forget',
      'Forget a remembered fact, by its id from memory_search, or by words in it.',
      { which: z.string().describe('An id, or words from the memory.') },
      async ({ which }) => {
        const memories = load()
        const w = String(which).trim().toLowerCase()
        const keep = memories.filter((m) => m.id !== w && !m.text.toLowerCase().includes(w))
        const removed = memories.length - keep.length
        if (!removed) return fail(`Nothing remembered matches "${which}".`)
        writeJson(file, keep)
        return ok(`Forgot ${removed}.`)
      },
    ),
  ]
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

const WMO = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'freezing fog', 51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle',
  56: 'freezing drizzle', 57: 'freezing drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain',
  66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow',
  77: 'snow grains', 80: 'rain showers', 81: 'rain showers', 82: 'violent rain showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail',
  99: 'thunderstorm with hail',
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'jarvis-assistant' } })
  if (!res.ok) throw new Error(`weather service answered ${res.status}`)
  return res.json()
}

async function geocode(place) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(place)}`
  const hit = (await getJson(url)).results?.[0]
  if (!hit) return null
  return {
    name: [hit.name, hit.admin1, hit.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', '),
    lat: hit.latitude,
    lon: hit.longitude,
  }
}

export async function weatherReport(place, { imperial = false, days = 3 } = {}) {
  const where = await geocode(place)
  if (!where) throw new Error(`could not find a place called "${place}"`)
  const units = imperial ? '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch' : ''
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${where.lat}&longitude=${where.lon}` +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    `&timezone=auto&forecast_days=${Math.min(7, Math.max(1, days))}${units}`
  const w = await getJson(url)
  const deg = imperial ? '°F' : '°C'
  const wind = imperial ? 'mph' : 'km/h'
  const c = w.current ?? {}
  const lines = [
    `${where.name} now: ${Math.round(c.temperature_2m)}${deg}, feels like ${Math.round(c.apparent_temperature)}${deg}, ` +
      `${WMO[c.weather_code] ?? 'unknown'}, wind ${Math.round(c.wind_speed_10m)} ${wind}, humidity ${c.relative_humidity_2m}%.`,
  ]
  const d = w.daily ?? {}
  ;(d.time ?? []).forEach((day, i) => {
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(day).toLocaleDateString('en-GB', { weekday: 'long' })
    lines.push(
      `${label}: ${WMO[d.weather_code[i]] ?? 'unknown'}, ${Math.round(d.temperature_2m_min[i])} to ${Math.round(d.temperature_2m_max[i])}${deg}, ` +
        `${d.precipitation_probability_max?.[i] ?? 0}% chance of rain.`,
    )
  })
  return lines.join('\n')
}

function weatherTools(stateDir) {
  const file = join(stateDir, 'settings.json')
  const settings = () => readJson(file, {})
  const home = () => settings().homeCity || process.env.JARVIS_HOME_CITY || null
  const imperial = () => (settings().units || process.env.JARVIS_UNITS) === 'imperial'

  return [
    tool(
      'weather',
      'Current weather and the forecast for a place. Leave place empty for the user\'s home city.',
      {
        place: looseText('City or town. Empty means their home city.'),
        days: looseNumber('Forecast days, 1-7. Default 3.'),
      },
      async ({ place, days }) => {
        const where = place?.trim() || home()
        if (!where) return fail('No home city set. Ask which city they live in, then call weather_set_home.')
        try {
          return ok(await weatherReport(where, { imperial: imperial(), days: num(days) ?? 3 }))
        } catch (err) {
          return fail(`Weather unavailable: ${err.message}.`)
        }
      },
    ),
    tool(
      'weather_set_home',
      'Save the user\'s home city (and optionally metric or imperial units) for weather and the daily brief.',
      {
        city: z.string().describe('Their home city, e.g. "Prague".'),
        units: z.enum(['metric', 'imperial']).optional().catch(undefined),
      },
      async ({ city, units }) => {
        const where = await geocode(city).catch(() => null)
        if (!where) return fail(`Could not find "${city}".`)
        writeJson(file, { ...settings(), homeCity: city, ...(units ? { units } : {}) })
        return ok(`Home city set to ${where.name}.`)
      },
    ),
    tool(
      'daily_brief',
      'Everything for a morning or daily briefing in one call: date and time, home weather, today\'s reminders and running timers. Follow it with a WebSearch for two or three top headlines if they want news.',
      {},
      async () => {
        const parts = [`It is ${localStamp()}.`]
        const where = home()
        if (where) {
          try {
            parts.push(await weatherReport(where, { imperial: imperial(), days: 1 }))
          } catch (err) {
            parts.push(`Weather unavailable: ${err.message}.`)
          }
        } else parts.push('No home city set, so no weather (use weather_set_home).')
        const endOfDay = new Date()
        endOfDay.setHours(23, 59, 59, 999)
        const today = timers.filter((t) => t.at <= endOfDay.getTime()).sort((a, b) => a.at - b.at)
        parts.push(today.length ? `Today:\n${today.map((t) => describeTimer(t)).join('\n')}` : 'No reminders for the rest of today.')
        return ok(parts.join('\n'))
      },
    ),
  ]
}

// ---------------------------------------------------------------------------
// Power and the microphone — JARVIS turning himself off, muting the user
// ---------------------------------------------------------------------------

let micStateDir = null
const micFile = () => join(micStateDir, 'mic.json')

/** Mute the Mac's microphone, remembering the level to put back. */
export async function muteMic() {
  const level = Number(await osa(['input volume of (get volume settings)'])) || 0
  const saved = readJson(micFile(), {})
  writeJson(micFile(), { muted: true, level: level > 0 ? level : saved.level || 60 })
  await osa(['set volume input volume 0'])
}

/** Put the microphone back where it was. Safe to call when it isn't muted. */
export async function unmuteMic() {
  if (!micStateDir) return false
  const saved = readJson(micFile(), {})
  if (!saved.muted) return false
  const level = Math.round(Math.min(100, Math.max(1, Number(saved.level) || 60)))
  await osa(['on run argv', 'set volume input volume (item 1 of argv as integer)', 'end run'], [String(level)])
  writeJson(micFile(), { muted: false, level })
  return true
}

function powerTools({ power, mic }) {
  const tools = [
    tool(
      'jarvis_power',
      'Turn yourself off. mode "sleep" (go to sleep, stand by, be quiet, that is all) closes your ears until they say "Hey Jarvis" again. ' +
        'mode "shutdown" (shut down, turn yourself off, quit, power off) fully quits JARVIS; they restart it with the Jarvis app or "Hey Siri, open Jarvis". ' +
        'Say your one-line goodbye in the same turn; it is spoken before you go.',
      { mode: z.enum(['sleep', 'shutdown']).catch('sleep') },
      async ({ mode }) => {
        power?.(mode)
        return ok(mode === 'shutdown' ? 'Shutting down after this answer.' : 'Going to sleep after this answer.')
      },
    ),
  ]
  if (IS_MAC) {
    tools.push(
      tool(
        'mic_mute',
        '"Mute me" / "unmute me": mute or unmute the Mac\'s microphone for every app. While muted you cannot hear them at all, ' +
          'so tell them how to unmute: press M on your screen, or open the Jarvis app ("Hey Siri, open Jarvis").',
        { mute: z.union([z.boolean(), z.string()]).catch(true).describe('true to mute, false to unmute.') },
        async ({ mute }) => {
          const on = mute === true || /^(true|yes|on|1|mute)$/i.test(String(mute))
          try {
            if (on) await muteMic()
            else await unmuteMic()
          } catch (err) {
            return fail(`Couldn't change the microphone: ${err.message}`)
          }
          mic?.(on)
          return ok(on ? 'Microphone muted. Unmute: press M on the JARVIS screen, or open the Jarvis app.' : 'Microphone back on.')
        },
      ),
    )
  }
  return tools
}

// ---------------------------------------------------------------------------
// Mac settings
// ---------------------------------------------------------------------------

const onOff = (v) =>
  z.union([z.boolean(), z.string()]).optional().catch(undefined).describe(v)

function wantOn(value, current) {
  if (value === undefined || value === null || value === '') return undefined
  const s = String(value).trim().toLowerCase()
  if (s === 'toggle') return !current
  return value === true || /^(true|yes|on|1|enable|dark)$/.test(s)
}

function settingsTools({ allowWrites }) {
  if (!IS_MAC) return []
  const tools = [
    tool(
      'mac_dark_mode',
      'Switch the Mac between dark and light mode, toggle it, or report which it is in.',
      { dark: onOff('true for dark, false for light, "toggle". Empty just reports.') },
      async ({ dark }) => {
        const script = (body) => ['tell application "System Events"', 'tell appearance preferences', ...body, 'end tell', 'end tell']
        // Reading needs no permission; changing it goes through System Events.
        const isDark = async () => {
          try {
            return /dark/i.test((await run('defaults', ['read', '-g', 'AppleInterfaceStyle'], { timeout: 5000 })).stdout)
          } catch {
            return false // the key is absent in light mode
          }
        }
        const now = await isDark()
        const want = wantOn(dark, now)
        if (want === undefined || want === now) return ok(`${now ? 'Dark' : 'Light'} mode.`)
        try {
          await osa(script([`set dark mode to ${want}`]))
        } catch (err) {
          return fail(
            `macOS hasn't let JARVIS change the appearance yet. Allow it once in System Settings → Privacy & Security → Automation (System Events). ${err.message}`,
          )
        }
        return ok(`${(await isDark()) ? 'Dark' : 'Light'} mode.`)
      },
    ),
    tool(
      'mac_wifi',
      'Turn Wi-Fi on or off, or report its state. Warn first that turning it off also cuts JARVIS off from Claude, so he cannot answer again until it is back on.',
      { on: onOff('true to turn on, false to turn off. Empty reports.') },
      async ({ on }) => {
        const { stdout } = await run('networksetup', ['-listallhardwareports'], { timeout: 5000 })
        const dev = stdout.match(/Hardware Port: Wi-Fi\nDevice: (\S+)/)?.[1] ?? 'en0'
        const state = async () => /On$/.test((await run('networksetup', ['-getairportpower', dev], { timeout: 5000 })).stdout.trim())
        const now = await state()
        const want = wantOn(on, now)
        if (want !== undefined && want !== now) {
          await run('networksetup', ['-setairportpower', dev, want ? 'on' : 'off'], { timeout: 8000 })
        }
        return ok(`Wi-Fi is ${(await state()) ? 'on' : 'off'}.`)
      },
    ),
    tool(
      'mac_sleep',
      'Put the whole Mac to sleep. Only when they clearly ask for the computer (not you) to sleep.',
      {},
      async () => {
        setTimeout(() => run('pmset', ['sleepnow']).catch(() => {}), 4000).unref?.()
        return ok('The Mac will sleep in a few seconds.')
      },
    ),
    tool(
      'mac_shortcuts_list',
      'List the user\'s Shortcuts (from the Shortcuts app). They can make shortcuts for anything JARVIS has no tool for — Do Not Disturb, brightness, Bluetooth, smart-home — and you run them with mac_shortcut_run.',
      {},
      async () => {
        const { stdout } = await run('shortcuts', ['list'], { timeout: 10000 })
        const names = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
        return ok(names.length ? names.join('\n') : 'No shortcuts yet.')
      },
    ),
  ]
  if (allowWrites) {
    tools.push(
      tool(
        'mac_shortcut_run',
        'Run one of the user\'s Shortcuts by its exact name (see mac_shortcuts_list), optionally with text input.',
        { name: z.string(), input: looseText('Text to pass in. Optional.') },
        async ({ name, input }) => {
          const { stdout } = await run('shortcuts', ['list'], { timeout: 10000 })
          const names = stdout.split('\n').map((l) => l.trim()).filter(Boolean)
          const match = names.find((n) => n.toLowerCase() === String(name).trim().toLowerCase()) ?? names.find((n) => norm(n).includes(norm(name)))
          if (!match) return fail(`No shortcut called "${name}".`)
          const args = ['run', match]
          let tmp = null
          if (input) {
            tmp = join(micStateDir ?? homedir(), 'shortcut-input.txt')
            writeFileSync(tmp, String(input))
            args.push('--input-path', tmp)
          }
          const out = await run('shortcuts', args, { timeout: 60000 })
          return ok(`Ran "${match}".${out.stdout.trim() ? ` Output: ${out.stdout.trim().slice(0, 500)}` : ''}`)
        },
      ),
    )
  }
  return tools
}

// ---------------------------------------------------------------------------
// Websites and files
// ---------------------------------------------------------------------------

const SITES = {
  youtube: 'https://www.youtube.com', google: 'https://www.google.com', gmail: 'https://mail.google.com',
  netflix: 'https://www.netflix.com', spotify: 'https://open.spotify.com', maps: 'https://maps.google.com',
  wikipedia: 'https://www.wikipedia.org', github: 'https://github.com', chatgpt: 'https://chatgpt.com',
  claude: 'https://claude.ai', facebook: 'https://www.facebook.com', instagram: 'https://www.instagram.com',
  x: 'https://x.com', twitter: 'https://x.com', reddit: 'https://www.reddit.com', amazon: 'https://www.amazon.com',
  calendar: 'https://calendar.google.com', drive: 'https://drive.google.com', translate: 'https://translate.google.com',
}

const SEARCH = {
  google: 'https://www.google.com/search?q=',
  youtube: 'https://www.youtube.com/results?search_query=',
  maps: 'https://www.google.com/maps/search/',
  wikipedia: 'https://en.wikipedia.org/w/index.php?search=',
  amazon: 'https://www.amazon.com/s?k=',
  images: 'https://www.google.com/search?tbm=isch&q=',
}

/** A site name, a bare domain or a full URL, to an https URL — or null. */
export function siteUrl(input) {
  const s = String(input ?? '').trim()
  if (!s) return null
  const known = SITES[s.toLowerCase().replace(/\s+|\.com$/g, '')]
  if (known) return known
  const withScheme = /^[a-z]+:\/\//i.test(s) ? s : /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) ? `https://${s}` : null
  if (!withScheme) return null
  try {
    const u = new URL(withScheme)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
  } catch {
    return null
  }
}

async function openInBrowser(url) {
  const chrome = '/Applications/Google Chrome.app'
  await run('open', existsSync(chrome) ? ['-a', chrome, url] : [url], { timeout: 8000 })
}

const FOLDERS = {
  home: '', downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures',
  photos: 'Pictures', music: 'Music', movies: 'Movies', videos: 'Movies', applications: 'Applications',
}

function webFileTools() {
  if (!IS_MAC) return []
  return [
    tool(
      'open_website',
      'Open a website in Chrome: a name ("youtube", "gmail"), a domain ("bbc.co.uk") or a full URL. Or search a site: give search plus on (google, youtube, maps, wikipedia, amazon, images).',
      {
        site: looseText('Site name, domain or URL.'),
        search: looseText('What to search for.'),
        on: looseText('Where to search. Default google.'),
      },
      async ({ site, search, on }) => {
        let url = null
        if (search) {
          const where = String(on ?? site ?? 'google').toLowerCase().replace(/\.com$/, '')
          url = (SEARCH[where] ?? SEARCH.google) + encodeURIComponent(search)
        } else url = siteUrl(site)
        if (!url) return fail(`I don't know a site called "${site}". Give a domain, or search instead.`)
        await openInBrowser(url)
        return ok(`Opened ${new URL(url).hostname}${search ? ` (search: ${search})` : ''}.`)
      },
    ),
    tool(
      'open_folder',
      'Show a folder in Finder: downloads, documents, desktop, pictures, music, movies, applications, home — or a path inside the home folder.',
      { folder: z.string() },
      async ({ folder }) => {
        const key = String(folder).trim().toLowerCase().replace(/^my\s+|\s+folder$/g, '')
        const rel = FOLDERS[key]
        const path = rel !== undefined ? join(homedir(), rel) : String(folder).replace(/^~(?=\/|$)/, homedir())
        if (!path.startsWith(homedir()) || !existsSync(path)) return fail(`No folder "${folder}" in your home folder.`)
        await run('open', [path], { timeout: 8000 })
        return ok(`Opened ${basename(path) || 'your home folder'}.`)
      },
    ),
    tool(
      'take_screenshot',
      'Take a screenshot of the whole screen and save it to the Desktop. Only when asked.',
      {},
      async () => {
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
        const file = join(homedir(), 'Desktop', `JARVIS Screenshot ${stamp}.png`)
        await run('screencapture', ['-x', file], { timeout: 15000 })
        return existsSync(file) ? ok('Screenshot saved to the Desktop.') : fail('macOS did not allow the screenshot (Screen Recording permission).')
      },
    ),
  ]
}

// ---------------------------------------------------------------------------
// Write and send — drafts only; the user always presses Send themselves
// ---------------------------------------------------------------------------

/** Apps JARVIS will not type into: a typed line there is a command run. */
const NO_TYPING = /terminal|iterm|warp|alacritty|kitty|hyper|ghostty|console|script editor|keychain|system settings|claude/i

function writeTools({ allowWrites }) {
  if (!IS_MAC) return []
  const pb = (text) =>
    new Promise((resolve, reject) => {
      const child = execFile('pbcopy', [], (err) => (err ? reject(err) : resolve()))
      child.stdin.end(String(text))
    })
  const tools = [
    tool(
      'clipboard_copy',
      'Put text on the clipboard so they can paste it anywhere.',
      { text: z.string() },
      async ({ text }) => {
        await pb(text)
        return ok('Copied to the clipboard.')
      },
    ),
    tool(
      'clipboard_read',
      'Read what is on the clipboard right now (to summarise, translate or fix it). Only when they ask about their clipboard.',
      {},
      async () => {
        const { stdout } = await run('pbpaste', [], { timeout: 5000 })
        return ok(stdout ? stdout.slice(0, 4000) : 'The clipboard is empty.')
      },
    ),
    tool(
      'email_draft',
      'Open a new email in their mail app, filled in, for them to check and send. You never send it.',
      { to: looseText('Address, if known.'), subject: looseText('Subject.'), body: looseText('Body text.') },
      async ({ to, subject, body }) => {
        const q = new URLSearchParams()
        if (subject) q.set('subject', subject)
        if (body) q.set('body', body)
        const url = `mailto:${encodeURIComponent(to ?? '').replace(/%40/g, '@')}?${q.toString().replace(/\+/g, '%20')}`
        await run('open', [url], { timeout: 8000 })
        return ok('Draft is open. They press Send.')
      },
    ),
    tool(
      'message_draft',
      'Start an iMessage/text: opens Messages (to a number or address if given) with the text on the clipboard, ready to paste and send. You never send it.',
      { to: looseText('Phone number or address, if known.'), text: z.string() },
      async ({ to, text }) => {
        await pb(text)
        const addr = String(to ?? '').replace(/[^\w@.+-]/g, '')
        await run('open', [addr ? `sms:${addr}` : '-a', ...(addr ? [] : ['Messages'])], { timeout: 8000 })
        return ok('Messages is open and the text is on the clipboard — paste with Command-V, then send.')
      },
    ),
  ]
  if (allowWrites) {
    tools.push(
      tool(
        'type_text',
        'Type text into whatever app and text field is in front, as if from the keyboard. Refused in terminals and settings.',
        { text: z.string(), press_return: z.union([z.boolean(), z.string()]).optional().catch(false) },
        async ({ text, press_return }) => {
          let front = ''
          try {
            front = await osa(['tell application "System Events" to get name of first application process whose frontmost is true'])
          } catch (err) {
            return fail(`macOS has not allowed JARVIS to control the keyboard yet. Turn it on in System Settings → Privacy & Security → Accessibility (and Automation). ${err.message}`)
          }
          if (NO_TYPING.test(front)) return fail(`Not typing into ${front}: text there could run as a command.`)
          await pb(text)
          const enter = press_return === true || /^(true|yes|1)$/i.test(String(press_return))
          await osa(['tell application "System Events"', 'keystroke "v" using command down', ...(enter ? ['delay 0.2', 'key code 36'] : []), 'end tell'])
          return ok(`Typed into ${front}.`)
        },
      ),
    )
  }
  return tools
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

function clockTool() {
  return tool(
    'time_now',
    'The current local date, time and day of the week. Use it before working out "tomorrow", "in an hour", or a clock time.',
    {},
    async () => ok(`It is ${localStamp()} (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`),
  )
}

/**
 * Build the skills server. `stateDir` is where timers, memories and settings
 * live; `disabled` is the JARVIS_DISABLE set, honouring mac / timers / memory /
 * weather.
 */
export function skillsServer({ stateDir, disabled = new Set(), allowWrites = false, power, mic }) {
  mkdirSync(stateDir, { recursive: true })
  micStateDir = stateDir
  settingsDir = stateDir
  const tools = [clockTool(), ...powerTools({ power, mic })]
  if (!disabled.has('phone')) tools.push(...phoneTools())
  if (!disabled.has('mac') && !disabled.has('spotify')) tools.push(...spotifyTools())
  if (!disabled.has('mac')) tools.push(...macTools(), ...settingsTools({ allowWrites }), ...webFileTools(), ...writeTools({ allowWrites }))
  if (!disabled.has('timers')) {
    startTimers(stateDir)
    tools.push(...timerTools())
  }
  if (!disabled.has('timers') && !disabled.has('routines')) {
    const routines = startRoutines({ stateDir, notify: (text) => notifyMac('JARVIS', text) })
    tools.push(...routineTools(routines))
  }
  if (!disabled.has('memory')) tools.push(...memoryTools(stateDir))
  if (!disabled.has('weather')) tools.push(...weatherTools(stateDir))
  return createSdkMcpServer({ name: 'jarvis_skills', version: '1.0.0', tools })
}

export const PROMPT_SKILLS = `Your everyday skills (the jarvis_skills tools):
- Mac: open or quit apps, set the volume, control the music, lock the screen,
  battery. Do it, then confirm in a few words: "Spotify's open."
- Timers and reminders: set them without asking for confirmation. Repeat the
  time back once, briefly. When one fires you will hear about it and say it.
  Call time_now first if you need today's date or the time to work it out.
${PROMPT_ROUTINES}- Memory: when they say "remember…" save it; when they ask something personal
  ("where did I put…", "what's my…") search memory before saying you don't know.
  Never read every memory aloud unless asked.
- Weather: lead with what matters ("Cold and wet, eight degrees"), not every number.
  If no home city is set, ask once and save it with weather_set_home.
- Daily brief: call daily_brief, then give it in three or four short sentences.
- "Go to sleep" / "that's all": jarvis_power sleep. "Shut down" / "turn yourself
  off": jarvis_power shutdown. Either way one short goodbye, nothing more.
- Spotify: "play <song/artist/playlist>" → WebSearch site:open.spotify.com, then
  spotify_play with the link. Pause, skip, next: mac_music. Shuffle, repeat,
  Spotify volume, jump ahead: spotify_control. Confirm with the track name only.
- "Call me" / "ping my phone": phone_alert with a short message. It is a loud
  notification, not a phone call; say "Sent to your phone", never "calling".
  For reminders while they're out, set phone true on the reminder.
- "Mute me": mic_mute, then tell them once how to unmute (press M on the screen).
- Websites, folders, screenshots, dark mode, Wi-Fi: just do it and confirm.
- Anything else on the Mac: check mac_shortcuts_list; their own Shortcuts may do it.
- Writing: email_draft and message_draft only prepare it. Never claim you sent
  anything. Read the draft's gist back in one sentence.

`

// ---------------------------------------------------------------------------
// DIY skills — plain-text routines the user writes
// ---------------------------------------------------------------------------

const MAX_SKILL_FILES = 20
const MAX_SKILL_CHARS = 2000
const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'examples')

/** First run only: give the user an example to copy from. */
export function seedSkills(dir) {
  if (existsSync(dir)) return
  mkdirSync(dir, { recursive: true })
  try {
    for (const f of readdirSync(EXAMPLES)) {
      if (f.endsWith('.md')) copyFileSync(join(EXAMPLES, f), join(dir, f))
    }
  } catch {}
}

/** Read ~/.jarvis/skills/*.md into a prompt section. Empty string if none. */
export function customSkillsPrompt(dir) {
  let files = []
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('.'))
      .sort()
      .slice(0, MAX_SKILL_FILES)
  } catch {
    return ''
  }
  const blocks = []
  for (const f of files) {
    let text = ''
    try {
      text = readFileSync(join(dir, f), 'utf8').trim()
    } catch {
      continue
    }
    if (!text) continue
    if (text.length > MAX_SKILL_CHARS) text = `${text.slice(0, MAX_SKILL_CHARS)}…`
    blocks.push(`### ${basename(f, '.md')}\n${text}`)
  }
  if (!blocks.length) return ''
  return `\n\nYour custom routines. The user wrote these. When what they say matches
one, follow its steps with your tools, then confirm in one short sentence:

${blocks.join('\n\n')}
`
}
