import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, renameSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The `jarvis_skills` tools — everyday abilities that live in this process.
 *
 *   Mac control   open / quit apps, volume, music, lock the screen, battery.
 *                 A fixed list of actions with fixed arguments — never a shell.
 *   Timers        countdowns and reminders that survive a restart and speak
 *                 when they go off (a macOS notification if the face is closed).
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
        if (verb) await osa(['on run argv', `tell application (item 1 of argv) to ${verb}`, 'end run'], [app])
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
      { ...when, label: looseText('Short name, e.g. "pasta". Optional.') },
      async (args) => {
        const at = parseWhen({ ...args, at: undefined })
        if (!at) return fail('Give the timer a duration.')
        const t = { id: newId(), kind: 'timer', label: (args.label ?? '').slice(0, 80), at, set: Date.now() }
        timers.push(t)
        saveTimers()
        return ok(`Timer set: ${spokenDuration(at - Date.now())}. ${describeTimer(t)}`)
      },
    ),
    tool(
      'reminder_set',
      'Remind the user of something later, e.g. "remind me at 5 to call mom" or "in 2 hours to stretch". JARVIS speaks the reminder when it is due.',
      { ...when, text: z.string().describe('What to remind them of, in a few words.') },
      async (args) => {
        const at = parseWhen(args)
        if (!at) return fail('I need a time ("17:30") or a delay (minutes/hours).')
        const t = { id: newId(), kind: 'reminder', label: String(args.text).slice(0, 200), at, set: Date.now() }
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
export function skillsServer({ stateDir, disabled = new Set() }) {
  mkdirSync(stateDir, { recursive: true })
  const tools = [clockTool()]
  if (!disabled.has('mac')) tools.push(...macTools())
  if (!disabled.has('timers')) {
    startTimers(stateDir)
    tools.push(...timerTools())
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
- Memory: when they say "remember…" save it; when they ask something personal
  ("where did I put…", "what's my…") search memory before saying you don't know.
  Never read every memory aloud unless asked.
- Weather: lead with what matters ("Cold and wet, eight degrees"), not every number.
  If no home city is set, ask once and save it with weather_set_home.
- Daily brief: call daily_brief, then give it in three or four short sentences.

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
