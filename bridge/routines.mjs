import { tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Routines — the things JARVIS does without being asked, set up by voice.
 *
 * `reminder_set` fires once. A routine repeats, or waits for a moment that is
 * not a clock time:
 *
 *   time     once, weekly (pick the days), monthly (31 = the month's last day),
 *            or every N minutes inside a window
 *   startup  once per run of the bridge, as soon as a face can speak
 *   idle     after the user has been quiet for N minutes, at most every M
 *
 * and does one of two things when it fires:
 *
 *   say      speaks fixed words ("Drink some water, sir.")
 *   prompt   hands JARVIS an instruction as an unprompted turn ("brief me on
 *            the news"), so he uses his tools and says the result
 *
 * WHEN IT CANNOT RUN RIGHT NOW
 *   A due routine waits while JARVIS is mid-answer or the user has just
 *   spoken, but only for as long as it still makes sense: fixed words are
 *   still worth hearing two hours late, an instruction forty-five minutes
 *   late. Past that it is skipped and moved to its next time, which is also
 *   what happens to one that fell due while the bridge was off. With no face
 *   connected at all, fixed words go to a macOS notification instead.
 *
 * QUIET HOURS
 *   One window, off by default. Routines marked `quiet` — idle check-ins by
 *   default — are held back inside it. One set for an exact time is not:
 *   06:30 inside 23:00-07:00 was chosen on purpose.
 *
 * Ported from Mark-LVII's core/routines (rules.py + engine.py), cut down to
 * what this bridge can deliver. The engine knows nothing about sockets; it
 * talks to a host — see hostFromFaces() — so the tests can drive it by hand.
 */

const MIN = 60_000
const HOUR = 60 * MIN
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7]
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const KINDS = ['say', 'prompt']
/** How late a routine may still run. */
const GRACE_MS = { say: 2 * HOUR, prompt: 45 * MIN }
/** A startup routine that could not speak by then is skipped. */
const STARTUP_WINDOW_MS = 3 * MIN
/** A timed routine does not cut into what the user has only just said. */
const CALM_MS = 10_000
const MIN_INTERVAL_MINUTES = 5
const DEFAULT_IDLE_MINUTES = 15
const DEFAULT_COOLDOWN_MINUTES = 60
const MAX_TEXT = 1000
const MAX_NAME = 80
const TICK_MS = 5_000

// ---------------------------------------------------------------------------
// Time rules — every answer is "the first moment strictly after this one"
// ---------------------------------------------------------------------------

/** "8:30", "8.30", "17", "5pm", "12:15 am" → [hour, minute]. */
export function parseHhmm(value) {
  const text = String(value ?? '').trim().toLowerCase()
  const m = text.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/)
  let hour = m ? Number(m[1]) : NaN
  const minute = m ? Number(m[2] ?? 0) : NaN
  if (m?.[3] === 'pm' && hour < 12) hour += 12
  if (m?.[3] === 'am' && hour === 12) hour = 0
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    throw new Error(`"${value}" is not a time of day (HH:MM)`)
  }
  return [hour, minute]
}

export function hhmm(value) {
  const [h, m] = parseHhmm(value)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

const DAY_GROUPS = {
  daily: ALL_DAYS,
  everyday: ALL_DAYS,
  weekdays: [1, 2, 3, 4, 5],
  weekday: [1, 2, 3, 4, 5],
  weekends: [6, 7],
  weekend: [6, 7],
}

function dayToken(token) {
  if (/^[1-7]$/.test(token)) return [Number(token)]
  if (DAY_GROUPS[token]) return DAY_GROUPS[token]
  const i = DAY_NAMES.findIndex((d) => token.length >= 3 && d.toLowerCase() === token.slice(0, 3))
  return i >= 0 ? [i + 1] : null
}

/**
 * ISO day numbers, 1 = Monday. Accepts numbers, day names ("mon, friday") and
 * groups ("weekdays", "weekends"). Nothing given means every day.
 */
export function parseDays(value) {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) {
    return [...ALL_DAYS]
  }
  const tokens = (Array.isArray(value) ? value : String(value).split(/[\s,;/&+]+|\band\b/i))
    .map((t) => String(t).trim().toLowerCase().replace(/^every\s*/, ''))
    .filter(Boolean)
  const days = new Set()
  for (const token of tokens) {
    const found = dayToken(token)
    if (!found) throw new Error('days are numbers 1-7 (1 is Monday), day names, "weekdays" or "weekends"')
    for (const d of found) days.add(d)
  }
  return [...days].sort((a, b) => a - b)
}

const isoDay = (date) => date.getDay() || 7

function atClock(date, [hour, minute]) {
  const d = new Date(date)
  d.setHours(hour, minute, 0, 0)
  return d
}

function addDays(date, n) {
  const d = new Date(date)
  d.setDate(d.getDate() + n)
  return d
}

function nextWeekly(rule, after) {
  const clock = parseHhmm(rule.time)
  const days = new Set(rule.days?.length ? rule.days : ALL_DAYS)
  for (let i = 0; i <= 7; i++) {
    const cand = atClock(addDays(after, i), clock)
    if (cand > after && days.has(isoDay(cand))) return cand
  }
  return null
}

function nextMonthly(rule, after) {
  const [hour, minute] = parseHhmm(rule.time)
  let year = after.getFullYear()
  let month = after.getMonth()
  for (let i = 0; i < 14; i++) {
    const lastDay = new Date(year, month + 1, 0).getDate()
    const cand = new Date(year, month, Math.min(Number(rule.day), lastDay), hour, minute, 0, 0)
    if (cand > after) return cand
    month += 1
    if (month === 12) {
      month = 0
      year += 1
    }
  }
  return null
}

function nextInterval(rule, after) {
  const stepMs = Math.max(MIN_INTERVAL_MINUTES, Number(rule.minutes)) * MIN
  const days = new Set(rule.days?.length ? rule.days : ALL_DAYS)
  for (let i = 0; i <= 7; i++) {
    const base = addDays(after, i)
    if (!days.has(isoDay(base))) continue
    const start = atClock(base, parseHhmm(rule.start ?? '00:00'))
    const end = atClock(base, parseHhmm(rule.end ?? '23:59'))
    const steps = after >= start ? Math.floor((after - start) / stepMs) + 1 : 0
    const cand = new Date(start.getTime() + steps * stepMs)
    if (cand <= end && cand > after) return cand
  }
  return null
}

/** The first moment strictly after `after` (a Date) that `rule` fires, or null. */
export function nextFire(rule, after) {
  switch (rule?.type) {
    case 'once':
      return Number(rule.at) > after.getTime() ? new Date(Number(rule.at)) : null
    case 'weekly':
      return nextWeekly(rule, after)
    case 'monthly':
      return nextMonthly(rule, after)
    case 'interval':
      return nextInterval(rule, after)
    default:
      return null
  }
}

function describeDays(days) {
  const list = days?.length ? days : ALL_DAYS
  const key = list.join(',')
  if (key === ALL_DAYS.join(',')) return ''
  if (key === '1,2,3,4,5') return 'weekdays'
  if (key === '6,7') return 'weekends'
  return list.map((d) => DAY_NAMES[d - 1]).join(', ')
}

export function describeRule(rule) {
  const on = describeDays(rule.days)
  switch (rule.type) {
    case 'once':
      return `once at ${new Date(Number(rule.at)).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    case 'weekly':
      return `at ${rule.time} ${on ? `on ${on}` : 'every day'}`
    case 'monthly':
      return `on day ${rule.day} of every month at ${rule.time}`
    case 'interval':
      return `every ${rule.minutes} min, ${rule.start}-${rule.end}${on ? ` on ${on}` : ''}`
    default:
      return String(rule.type)
  }
}

function num(value) {
  if (value === undefined || value === null || value === '') return undefined
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : undefined
}

/** "09:00-17:00", "9-17", "9am to 5pm" → ['09:00', '17:00']. */
function parseWindow(text) {
  const parts = String(text).trim().split(/\s*(?:-|–|\bto\b)\s*/i).filter(Boolean)
  if (parts.length !== 2) throw new Error('a window is "HH:MM-HH:MM"')
  return [hhmm(parts[0]), hhmm(parts[1])]
}

/** "2026-11-24 07:15" in local time, or any ISO date-time. */
function parseAt(text) {
  const m = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime()
  const parsed = Date.parse(String(text))
  if (!Number.isFinite(parsed)) throw new Error('"at" must be "YYYY-MM-DD HH:MM"')
  return parsed
}

function idleTrigger(a) {
  const minutes = Math.round(num(a.idle_minutes) ?? DEFAULT_IDLE_MINUTES)
  const cooldown = Math.round(num(a.cooldown_minutes) ?? DEFAULT_COOLDOWN_MINUTES)
  if (minutes < 1 || cooldown < 1) throw new Error('idle_minutes and cooldown_minutes must be at least 1')
  return { type: 'idle', minutes, cooldown }
}

const given = (v) => v !== undefined && v !== null && v !== ''

function timeRule(a, now) {
  if (given(a.every_minutes)) {
    const minutes = Math.round(num(a.every_minutes) ?? 0)
    if (minutes < MIN_INTERVAL_MINUTES) throw new Error(`every_minutes must be at least ${MIN_INTERVAL_MINUTES}`)
    const [start, end] = a.between ? parseWindow(a.between) : ['00:00', '23:59']
    // HH:MM strings compare in clock order.
    if (start >= end) throw new Error('an every_minutes window must start before it ends, within one day')
    return { type: 'interval', minutes, start, end, days: parseDays(a.days) }
  }
  if (given(a.monthly_day)) {
    const day = Math.round(num(a.monthly_day) ?? 0)
    if (day < 1 || day > 31) throw new Error('monthly_day is 1-31')
    if (!a.time) throw new Error('a monthly routine needs a time (HH:MM)')
    return { type: 'monthly', day, time: hhmm(a.time) }
  }
  if (a.time) return { type: 'weekly', time: hhmm(a.time), days: parseDays(a.days) }
  if (a.at) {
    const when = parseAt(a.at)
    if (when <= now.getTime()) throw new Error('that time has already passed')
    return { type: 'once', at: when }
  }
  return null
}

/**
 * A tool call's WHEN fields as a trigger. Throws with a sentence the model can
 * pass on.
 */
export function triggerFromArgs(a = {}, now = new Date()) {
  const on = String(a.on ?? '').trim().toLowerCase()
  if (on === 'startup' || on === 'start') return { type: 'startup' }
  if (on === 'idle') return idleTrigger(a)
  const rule = timeRule(a, now)
  if (rule) return { type: 'time', rule }
  throw new Error(
    'say when: "at" for once, "time" (+ "days") to repeat, "monthly_day" + "time", ' +
      '"every_minutes" (+ "between"), or on = startup | idle',
  )
}

/** Is `date` inside "HH:MM-HH:MM"? The window may wrap past midnight. */
export function inQuiet(window, date) {
  if (!window) return false
  const toMinutes = (t) => {
    const [h, m] = parseHhmm(t)
    return h * 60 + m
  }
  const [start, end] = parseWindow(window).map(toMinutes)
  const now = date.getHours() * 60 + date.getMinutes()
  return start < end ? now >= start && now < end : now >= start || now < end
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function load(file, log) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    return {
      quietHours: typeof doc.quietHours === 'string' ? doc.quietHours : '',
      routines: Array.isArray(doc.routines) ? doc.routines.filter((r) => r?.id && KINDS.includes(r.kind) && r.trigger) : [],
    }
  } catch (err) {
    if (err.code !== 'ENOENT') log(`[jarvis] routines: could not read ${file}, starting empty (${err.message})`)
    return { quietHours: '', routines: [] }
  }
}

/** Write-then-rename, so a crash mid-write never leaves half a file. */
function save(file, doc) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(doc, null, 2))
  renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const newId = () => `r${Math.random().toString(36).slice(2, 7)}`
const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function checkTrigger(trigger) {
  if (trigger?.type === 'startup') return { type: 'startup' }
  if (trigger?.type === 'idle') return idleTrigger({ idle_minutes: trigger.minutes, cooldown_minutes: trigger.cooldown })
  if (trigger?.type === 'time' && trigger.rule) return { type: 'time', rule: { ...trigger.rule } }
  throw new Error('a trigger is a time rule, startup or idle')
}

/**
 * The routine store and scheduler. `host` is:
 *   connected()  → is any face open
 *   ready()      → can JARVIS take a turn now (a face that is not mid-answer)
 *   idleMs()     → how long since the user last spoke
 *   say(text)    → speak fixed words on the face
 *   prompt(text) → start an unprompted turn with this instruction
 *   notify(text) → a desktop notification, for when no face is open
 */
export function createRoutineEngine({ file, host, now = Date.now, log = console.log }) {
  let doc = load(file, log)
  let startedAt = null
  const startupDone = new Set()
  const idleLast = new Map()

  const persist = (next) => {
    doc = next
    save(file, doc)
  }
  const byId = (id) => doc.routines.find((r) => r.id === id) ?? null
  const replace = (id, patch) =>
    persist({ ...doc, routines: doc.routines.map((r) => (r.id === id ? { ...r, ...patch } : r)) })
  const drop = (id) => persist({ ...doc, routines: doc.routines.filter((r) => r.id !== id) })

  const nextFromNow = (trigger) => {
    if (trigger.type !== 'time') return 0
    const next = nextFire(trigger.rule, new Date(now()))
    if (!next) throw new Error('that time has already passed')
    return next.getTime()
  }

  function describe(r) {
    const t = r.trigger
    if (t.type === 'startup') return 'when JARVIS starts'
    if (t.type === 'idle') return `after ${t.minutes} min of quiet, at most every ${t.cooldown} min`
    return describeRule(t.rule)
  }

  function promptText(r) {
    const stamp = new Date(now()).toLocaleString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    return (
      `[ROUTINE "${r.name}" — set up by the user earlier; nobody asked just now]\n` +
      `It is ${stamp}.\n${r.text}\n` +
      'Do it now, using your tools if it needs them, then tell the user in one to three short sentences.'
    )
  }

  function record(id, result) {
    const r = byId(id)
    if (r) replace(id, { lastRun: now(), runs: (r.runs ?? 0) + 1, lastResult: result })
  }

  function fire(r) {
    let result = 'ran'
    try {
      if (r.kind === 'say') host.say(r.text)
      else host.prompt(promptText(r))
    } catch (err) {
      result = `failed: ${err?.message ?? err}`
    }
    log(`[jarvis] routine fired: ${r.name} (${result})`)
    record(r.id, result)
    return result
  }

  /** Move a timed routine to its next moment; a one-off that has happened goes. */
  function advance(id, at, note = '') {
    const r = byId(id)
    if (!r) return
    if (note) log(`[jarvis] routine "${r.name}" skipped: ${note}`)
    const next = nextFire(r.trigger.rule, at)
    if (!next) return drop(id)
    replace(id, { next: next.getTime(), ...(note ? { lastResult: `skipped: ${note}` } : {}) })
  }

  function tickTime(r, t, at, connected, canSpeak) {
    if (!r.next) return advance(r.id, at)
    if (t < r.next) return
    const late = t - r.next
    if (r.quiet && inQuiet(doc.quietHours, at)) return advance(r.id, at, 'held back by quiet hours')
    if (late > GRACE_MS[r.kind]) return advance(r.id, at, `missed by ${Math.round(late / MIN)} min`)
    if (r.kind !== 'say' || connected) {
      if (!canSpeak) return // wait, within grace
      // Moved on first: if anything after this throws, it must not fire again
      // on the next tick.
      advance(r.id, at)
      fire(r)
      return
    }
    advance(r.id, at)
    let result = 'sent as a notification'
    try {
      host.notify(r.text)
    } catch (err) {
      result = `failed: ${err?.message ?? err}`
    }
    record(r.id, result)
  }

  function tickStartup(r, t, ready) {
    if (startedAt === null || startupDone.has(r.id)) return
    if (ready) {
      startupDone.add(r.id)
      fire(r)
    } else if (t - startedAt > STARTUP_WINDOW_MS) {
      startupDone.add(r.id)
      log(`[jarvis] routine "${r.name}" skipped: JARVIS was not ready after start`)
    }
  }

  function tickIdle(r, t, at, ready, idle) {
    if (!ready || (r.quiet && inQuiet(doc.quietHours, at))) return
    if (idle < r.trigger.minutes * MIN) return
    const last = idleLast.get(r.id)
    if (last !== undefined && t - last < r.trigger.cooldown * MIN) return
    idleLast.set(r.id, t)
    fire(r)
  }

  function tick() {
    const t = now()
    const at = new Date(t)
    const connected = Boolean(host.connected())
    // Asked again for every routine: one that starts a turn makes the face
    // busy, and the next one due in the same tick has to see that and wait.
    const ready = () => connected && Boolean(host.ready())
    const idle = Number(host.idleMs()) || 0
    // Snapshot: firing and advancing replace `doc`, never the array being walked.
    for (const r of doc.routines) {
      if (!r.enabled) continue
      try {
        if (r.trigger.type === 'startup') tickStartup(r, t, ready())
        else if (r.trigger.type === 'idle') tickIdle(r, t, at, ready(), idle)
        else tickTime(r, t, at, connected, ready() && idle >= CALM_MS)
      } catch (err) {
        log(`[jarvis] routine "${r.name}" tick failed: ${err?.message ?? err}`)
      }
    }
  }

  function add({ name, kind, text, trigger, quiet }) {
    if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(', ')}`)
    const body = String(text ?? '').trim().slice(0, MAX_TEXT)
    if (!body) throw new Error('a routine needs the words it says or the instruction it carries out')
    const checked = checkTrigger(trigger)
    const r = {
      id: newId(),
      name: clean(name || body, MAX_NAME),
      kind,
      text: body,
      trigger: checked,
      quiet: quiet === undefined ? checked.type === 'idle' : Boolean(quiet),
      enabled: true,
      created: now(),
      next: nextFromNow(checked),
      lastRun: 0,
      runs: 0,
      lastResult: '',
    }
    persist({ ...doc, routines: [...doc.routines, r] })
    skipStartupThisRun(r)
    return { ...r }
  }

  /** A startup routine set up after JARVIS has started belongs to the next start. */
  function skipStartupThisRun(r) {
    if (r.trigger.type === 'startup' && startedAt !== null) startupDone.add(r.id)
  }

  function update(id, fields) {
    const r = byId(id)
    if (!r) throw new Error('no routine with that id')
    const trigger = fields.trigger ? checkTrigger(fields.trigger) : r.trigger
    const resumed = fields.enabled === true && !r.enabled
    replace(id, {
      ...(fields.name ? { name: clean(fields.name, MAX_NAME) } : {}),
      ...(fields.text ? { text: String(fields.text).trim().slice(0, MAX_TEXT) } : {}),
      ...(KINDS.includes(fields.kind) ? { kind: fields.kind } : {}),
      ...(typeof fields.quiet === 'boolean' ? { quiet: fields.quiet } : {}),
      ...(typeof fields.enabled === 'boolean' ? { enabled: fields.enabled } : {}),
      trigger,
      ...(fields.trigger || resumed ? { next: nextFromNow(trigger) } : {}),
    })
    if (fields.trigger || resumed) skipStartupThisRun(byId(id))
    return { ...byId(id) }
  }

  function find(which) {
    const w = String(which ?? '').trim().toLowerCase()
    if (!w) return null
    const hit =
      byId(w) ??
      doc.routines.find((r) => r.name.toLowerCase().includes(w)) ??
      doc.routines.find((r) => r.text.toLowerCase().includes(w))
    return hit ? { ...hit } : null
  }

  function setQuietHours(between) {
    const text = String(between ?? '').trim()
    const value = !text || /^(off|none|no|clear)$/i.test(text) ? '' : parseWindow(text).join('-')
    persist({ ...doc, quietHours: value })
    return value
  }

  function remove(id) {
    if (!byId(id)) return false
    drop(id)
    return true
  }

  function runNow(id) {
    const r = byId(id)
    if (!r) throw new Error('no routine with that id')
    return fire(r)
  }

  return {
    add,
    update,
    find,
    remove,
    runNow,
    describe,
    tick,
    setQuietHours,
    list: () => doc.routines.map((r) => ({ ...r })),
    get: (id) => {
      const r = byId(id)
      return r ? { ...r } : null
    },
    quietHours: () => doc.quietHours,
    /** The bridge has a face for the first time this run. A reconnect is not a new morning. */
    started: () => {
      if (startedAt === null) startedAt = now()
    },
  }
}

// ---------------------------------------------------------------------------
// The bridge's engine, and the faces it speaks through
// ---------------------------------------------------------------------------

/**
 * Each connected face registers itself with:
 *   busy()       → is a turn in flight on it
 *   lastHeard()  → when the user last spoke to it (ms)
 *   say(text)    → speak fixed words
 *   prompt(text) → start an unprompted turn
 */
const faces = new Set()
let engine = null

function hostFromFaces(notify) {
  const free = () => [...faces].find((f) => !f.busy())
  return {
    connected: () => faces.size > 0,
    ready: () => Boolean(free()),
    idleMs: () => Date.now() - Math.max(0, ...[...faces].map((f) => f.lastHeard())),
    say: (text) => {
      for (const f of faces) f.say(text)
    },
    prompt: (text) => {
      const face = free()
      if (!face) throw new Error('no face is free to take the turn')
      face.prompt(text)
    },
    notify,
  }
}

/**
 * The same faces, for anything else in the bridge that needs to speak
 * unprompted — background jobs reporting back. One shared set, so a job and a
 * routine cannot both seize the same face at once.
 */
export function faceHost(notify = () => {}) {
  return hostFromFaces(notify)
}

/** Start the scheduler once per process. `notify` is the no-face fallback. */
export function startRoutines({ stateDir, notify = () => {} }) {
  if (engine) return engine
  engine = createRoutineEngine({ file: join(stateDir, 'routines.json'), host: hostFromFaces(notify) })
  if (faces.size) engine.started()
  const timer = setInterval(() => engine.tick(), TICK_MS)
  timer.unref?.()
  return engine
}

/** Register a face; returns the function that unregisters it. */
export function attachFace(face) {
  faces.add(face)
  engine?.started()
  return () => faces.delete(face)
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })
const looseText = (note) => z.string().optional().catch(undefined).describe(note)
const looseNumber = (note) => z.union([z.number(), z.string()]).optional().catch(undefined).describe(note)
const truthy = (v) => /^(true|yes|1|on)$/i.test(String(v ?? '').trim())
const falsy = (v) => /^(false|no|0|off)$/i.test(String(v ?? '').trim())
const flag = (v) => (truthy(v) ? true : falsy(v) ? false : undefined)

const WHEN_FIELDS = {
  at: looseText('Once: "YYYY-MM-DD HH:MM". Use time_now first to work out the date.'),
  time: looseText('Repeat at this time of day, "HH:MM". With days for a weekly pattern, or with monthly_day.'),
  days: looseText('Which days for time or every_minutes: "weekdays", "weekends", "mon,wed,fri" or "1,3,5" (1 = Monday). Default every day.'),
  monthly_day: looseNumber('Day of the month, 1-31 (31 = the last day). Needs time.'),
  every_minutes: looseNumber('Repeat every N minutes (at least 5).'),
  between: looseText('With every_minutes: the window, "09:00-17:00". Default all day.'),
  on: looseText('"startup" (when JARVIS starts) or "idle" (after the user has been quiet a while) instead of a time.'),
  idle_minutes: looseNumber('With on="idle": minutes of quiet first. Default 15.'),
  cooldown_minutes: looseNumber('With on="idle": at most once every N minutes. Default 60.'),
}
const hasWhen = (args) => Object.keys(WHEN_FIELDS).some((k) => given(args[k]))

function nextLabel(r) {
  if (!r.enabled) return 'paused'
  if (r.trigger.type !== 'time' || !r.next) return ''
  return `next ${new Date(r.next).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
}

function row(eng, r) {
  const what = r.kind === 'say' ? `says "${r.text}"` : `does: ${r.text}`
  const state = [nextLabel(r), r.quiet ? 'quiet' : '', r.lastResult ? `last: ${r.lastResult}` : ''].filter(Boolean).join(' · ')
  return `[${r.id}] ${r.name} — ${eng.describe(r)}; ${what}${state ? ` (${state})` : ''}`
}

/** Run a handler, turning a thrown sentence into a tool error the model can read out. */
const guarded = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (err) {
    return fail(String(err?.message ?? err))
  }
}

function pick(eng, which) {
  const r = eng.find(which)
  if (!r) throw new Error(`No routine matches "${which}". routine_list shows them.`)
  return r
}

/** Exactly one of say / do, as { kind, text }. */
function action(args, { required }) {
  const say = String(args.say ?? '').trim()
  const instruction = String(args.do ?? '').trim()
  if (say && instruction) throw new Error('Give say (words to speak) or do (an instruction), not both.')
  if (say) return { kind: 'say', text: say }
  if (instruction) return { kind: 'prompt', text: instruction }
  if (required) throw new Error('Give say (words to speak) or do (an instruction to carry out).')
  return {}
}

function addTool(eng) {
  return tool(
    'routine_add',
    'Set up something JARVIS does on his own, again and again or at a moment that is not a clock time: ' +
      '"every weekday at 8:30 brief me on the news", "every hour between 9 and 5 remind me to drink water", ' +
      '"on the first of the month remind me to pay rent", "when I start you up, tell me the weather". ' +
      'Give either say (fixed words to speak) or do (an instruction you carry out with your tools when it fires), and the when fields. ' +
      'A single one-off reminder is reminder_set instead.',
    {
      name: looseText('Short name, e.g. "Morning briefing".'),
      say: looseText('Fixed words to speak when it fires.'),
      do: looseText('An instruction for yourself to carry out when it fires, e.g. "Brief me on today\'s weather and top headlines."'),
      quiet: looseText('"true" to hold it back during quiet hours. Default: true only for on="idle".'),
      ...WHEN_FIELDS,
    },
    guarded(async (args) => {
      const r = eng.add({
        name: args.name,
        ...action(args, { required: true }),
        trigger: triggerFromArgs(args),
        quiet: flag(args.quiet),
      })
      return ok(`Routine set: ${row(eng, r)}`)
    }),
  )
}

function updateTool(eng) {
  return tool(
    'routine_update',
    'Change a routine: move its time ("move the briefing to 8:30"), change what it says or does, rename it, ' +
      'or pause/resume it. Only the fields given change; giving any when field replaces its schedule.',
    {
      which: z.string().describe('Its id from routine_list, or words from its name.'),
      name: looseText('New name.'),
      say: looseText('New fixed words to speak.'),
      do: looseText('New instruction to carry out.'),
      enabled: looseText('"false" to pause it, "true" to resume.'),
      quiet: looseText('"true" or "false": hold it back during quiet hours.'),
      ...WHEN_FIELDS,
    },
    guarded(async (args) => {
      const r = pick(eng, args.which)
      const updated = eng.update(r.id, {
        name: args.name,
        ...action(args, { required: false }),
        ...(hasWhen(args) ? { trigger: triggerFromArgs(args) } : {}),
        enabled: flag(args.enabled),
        quiet: flag(args.quiet),
      })
      return ok(`Updated: ${row(eng, updated)}`)
    }),
  )
}

function removeTool(eng) {
  return tool(
    'routine_remove',
    'Delete a routine for good ("stop the water reminders"). To stop it for a while, routine_update with enabled false.',
    { which: z.string().describe('Its id from routine_list, words from its name, or "all".') },
    guarded(async ({ which }) => {
      if (String(which).trim().toLowerCase() === 'all') {
        const all = eng.list()
        for (const r of all) eng.remove(r.id)
        return ok(`Removed ${all.length} routine${all.length === 1 ? '' : 's'}.`)
      }
      const r = pick(eng, which)
      eng.remove(r.id)
      return ok(`Removed "${r.name}".`)
    }),
  )
}

function listTool(eng) {
  return tool(
    'routine_list',
    'List the routines (repeating and unprompted things JARVIS does) and the quiet hours.',
    {},
    guarded(async () => {
      const all = eng.list()
      const quiet = eng.quietHours()
      const head = quiet ? `Quiet hours: ${quiet}.` : 'No quiet hours set.'
      return ok(all.length ? `${head}\n${all.map((r) => row(eng, r)).join('\n')}` : `${head}\nNo routines.`)
    }),
  )
}

function runNowTool(eng) {
  return tool(
    'routine_run_now',
    'Run a routine straight away, e.g. to try one out ("do the morning briefing now").',
    { which: z.string().describe('Its id from routine_list, or words from its name.') },
    guarded(async ({ which }) => {
      const r = pick(eng, which)
      // An instruction run now belongs to this very turn — starting a second
      // turn while this one is still answering would only queue behind it.
      if (r.kind === 'prompt') return ok(`Carry it out now, in this turn: ${r.text}`)
      const result = eng.runNow(r.id)
      return result === 'ran' ? ok(`Ran "${r.name}".`) : fail(`"${r.name}" ${result}.`)
    }),
  )
}

function quietTool(eng) {
  return tool(
    'quiet_hours',
    'Set the window in which JARVIS says nothing unprompted ("don\'t talk to me between 11pm and 7am"). ' +
      'Routines set for an exact time still run; idle check-ins and anything marked quiet wait. "off" clears it.',
    { between: looseText('"23:00-07:00", or "off". Leave out to hear the current setting.') },
    guarded(async ({ between }) => {
      if (!given(between)) {
        const q = eng.quietHours()
        return ok(q ? `Quiet hours are ${q}.` : 'No quiet hours set.')
      }
      const value = eng.setQuietHours(between)
      return ok(value ? `Quiet hours set: ${value}.` : 'Quiet hours cleared.')
    }),
  )
}

export function routineTools(eng) {
  return [addTool(eng), listTool(eng), updateTool(eng), removeTool(eng), runNowTool(eng), quietTool(eng)]
}

export const PROMPT_ROUTINES = `- Routines: anything that repeats ("every weekday at 8:30 brief me", "every
  hour between 9 and 5 remind me to drink water"), or happens when you start up
  or after a quiet spell, is routine_add — say for fixed words, do for an
  instruction you carry out then. A single one-off stays reminder_set. "Move
  the briefing to 8:30" is routine_update; "don't talk to me after 11" is
  quiet_hours. Read the schedule back once, briefly.
- A message that starts with [ROUTINE …] is one of those firing: nobody just
  spoke. Do what it says and give the result in one to three sentences.
`
