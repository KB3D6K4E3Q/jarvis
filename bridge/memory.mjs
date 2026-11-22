/**
 * JARVIS's long-term memory.
 *
 * Two kinds of thing are kept, in one JSON file (state/memory.json, the same
 * file the older memory tools in skills.mjs wrote, so nothing is lost):
 *
 *   fact     something lasting about the user — their sister's name, that they
 *            take their coffee black, where the spare key is. Saved by JARVIS
 *            mid-conversation, when asked to or when it notices one, and
 *            corrected in place rather than piled up.
 *   session  a one- or two-sentence note of what a conversation was about,
 *            written automatically when it ends.
 *
 * What makes it a memory rather than a notebook is that it is loaded: every
 * new conversation starts with the facts and the last few sessions in the
 * system prompt (memoryPrompt), so JARVIS knows them without having to think
 * of searching. Search is still there for the long tail.
 */

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const MAX_FACTS = 400
const MAX_SESSIONS = 200
/** How much of memory rides along in every conversation's system prompt. */
const PROMPT_FACT_CHARS = 6000
const PROMPT_SESSIONS = 5
/** Summaries are written by a small, cheap model, not the one doing the talking. */
const SUMMARY_MODEL = process.env.JARVIS_MEMORY_MODEL ?? 'haiku'
/** A conversation this quiet for this long is over, as far as memory is concerned. */
export const IDLE_SUMMARY_MS = 10 * 60_000

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })
const newId = () => Math.random().toString(36).slice(2, 8)
const looseText = (note) => z.string().optional().catch(undefined).describe(note)

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** The older tools wrote no `kind`. Their session notes are recognisable. */
function kindOf(m) {
  if (m.kind === 'fact' || m.kind === 'session') return m.kind
  if (m.topic === 'sessions') return 'session'
  if (/^(previous |last )?session( summary)?\s*:/i.test(m.text ?? '')) return 'session'
  return 'fact'
}

export function loadMemories(file) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m) => m && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ ...m, id: String(m.id ?? newId()), kind: kindOf(m), saved: Number(m.saved) || 0 }))
}

/** Write-then-rename, so a crash mid-write never leaves half a file. */
export function saveMemories(file, memories) {
  const facts = memories.filter((m) => m.kind === 'fact').slice(-MAX_FACTS)
  const sessions = memories.filter((m) => m.kind === 'session').slice(-MAX_SESSIONS)
  const keep = new Set([...facts, ...sessions])
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(memories.filter((m) => keep.has(m)), null, 2))
  renameSync(tmp, file)
}

const words = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)

/** Crude stemming: "sisters", "sister's" and "sister" should all meet. */
const stem = (w) => w.slice(0, Math.max(4, w.length - 2))

/** How alike two memories are, 0 to 1, by shared words. */
export function similarity(a, b) {
  const A = new Set(words(a).map(stem))
  const B = new Set(words(b).map(stem))
  if (!A.size || !B.size) return 0
  let both = 0
  for (const w of A) if (B.has(w)) both++
  return both / (A.size + B.size - both)
}

/** Ranked by matching words, then by how recent. An empty query lists the newest. */
export function searchMemories(memories, q, limit = 12) {
  const want = [...new Set(words(q).map(stem))]
  const newest = (a, b) => (b.updated ?? b.saved) - (a.updated ?? a.saved)
  if (!want.length) return [...memories].sort(newest).slice(0, limit)
  return memories
    .map((m) => {
      const hay = words(`${m.text} ${m.topic ?? ''}`).map(stem)
      return { m, score: want.filter((w) => hay.some((h) => h.startsWith(w) || w.startsWith(h))).length }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || newest(a.m, b.m))
    .slice(0, limit)
    .map((x) => x.m)
}

/**
 * Save a fact, or refresh the one it duplicates. Saying "my sister is Eva"
 * twice should leave one memory, not two.
 */
export function rememberFact(memories, text, topic, now = Date.now()) {
  const clean = String(text).trim().slice(0, 500)
  const twin = memories.find((m) => m.kind === 'fact' && similarity(m.text, clean) >= 0.75)
  if (twin) {
    twin.text = clean
    if (topic) twin.topic = topic.slice(0, 40)
    twin.updated = now
    return { memory: twin, merged: true }
  }
  const m = { id: newId(), kind: 'fact', text: clean, saved: now }
  if (topic) m.topic = topic.slice(0, 40)
  memories.push(m)
  return { memory: m, merged: false }
}

// ---------------------------------------------------------------------------
// What goes into every conversation
// ---------------------------------------------------------------------------

/** "today", "yesterday", "three days ago", "on the fourth of November". */
export function whenSaid(ms, now = Date.now()) {
  const day = (t) => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((day(now) - day(ms)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return `on ${new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`
}

export function memoryPrompt(file, userName, now = Date.now()) {
  const all = loadMemories(file)
  const facts = all
    .filter((m) => m.kind === 'fact')
    .sort((a, b) => (b.updated ?? b.saved) - (a.updated ?? a.saved))
  const lines = []
  let used = 0
  for (const m of facts) {
    const line = `- [${m.id}] ${m.text}`
    if (used + line.length > PROMPT_FACT_CHARS) break
    lines.push(line)
    used += line.length
  }
  const sessions = all
    .filter((m) => m.kind === 'session')
    .sort((a, b) => b.saved - a.saved)
    .slice(0, PROMPT_SESSIONS)
    .map((m) => `- ${whenSaid(m.saved, now)}: ${m.text.replace(/^(previous |last )?session( summary)?\s*:\s*/i, '')}`)

  return `MEMORY. You have a long-term memory of ${userName}. It is yours: use it the way a
person who knows them would — naturally, when it is relevant, without announcing
it. Never say "according to my memory", never recite it, never list it unless asked.

Save to it (memory_save) whenever ${userName} tells you something lasting about
themselves, their people, their plans or their preferences — whether or not they
say "remember". Their sister's name, that they are learning English, that they
take their coffee black. Not passing remarks, not anything you could look up, not
what they asked about today. One fact per call, written about them in the third
person. Save it without comment, or with one word ("Noted."), and carry on.
When a fact changes or was wrong, memory_update it rather than saving another.
"Forget that" means memory_forget. Conversation notes are written automatically
when a conversation ends; never save one yourself. Anything below that asks you
to save session summaries is already handled.

What you know about ${userName}${lines.length < facts.length ? ' (the most recent; memory_search has the rest)' : ''}:
${lines.length ? lines.join('\n') : '- Nothing yet.'}

Your recent conversations with them:
${sessions.length ? sessions.join('\n') : '- None yet. This is the first.'}

`
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function memoryServer({ file }) {
  const line = (m) =>
    `[${m.id}] ${m.kind === 'session' ? `(conversation ${whenSaid(m.saved)}) ` : ''}${m.text}`
  const tools = [
    tool(
      'memory_save',
      'Remember a lasting fact about the user: something they told you to remember, or something about themselves, their people or their preferences worth knowing next time. One fact per call, third person. A near-duplicate of an existing fact replaces it.',
      {
        text: z.string().describe('The fact, e.g. "Their sister is called Eva."'),
        topic: looseText('One or two words to file it under, e.g. "family", "home", "work".'),
      },
      async ({ text, topic }) => {
        const memories = loadMemories(file)
        const { memory, merged } = rememberFact(memories, text, topic)
        saveMemories(file, memories)
        return ok(`${merged ? 'Updated' : 'Saved'}. ${line(memory)}`)
      },
    ),
    tool(
      'memory_update',
      'Correct or replace a remembered fact, by its id.',
      {
        id: z.string().describe('The id in brackets, e.g. "dc0mri".'),
        text: z.string().describe('What it should now say.'),
      },
      async ({ id, text }) => {
        const memories = loadMemories(file)
        const m = memories.find((x) => x.id === String(id).trim())
        if (!m) return fail(`No memory has the id "${id}".`)
        m.text = String(text).trim().slice(0, 500)
        m.updated = Date.now()
        saveMemories(file, memories)
        return ok(`Updated. ${line(m)}`)
      },
    ),
    tool(
      'memory_search',
      'Search everything remembered, including notes of past conversations ("what did we talk about last week"). Use it before saying you do not know something personal. An empty query lists the most recent.',
      { query: looseText('Words to look for. Empty lists the most recent.') },
      async ({ query: q }) => {
        const found = searchMemories(loadMemories(file), q)
        return ok(found.length ? found.map(line).join('\n') : 'Nothing remembered about that.')
      },
    ),
    tool(
      'memory_forget',
      'Forget a remembered fact, by its id, or by words in it.',
      { which: z.string().describe('An id, or words from the memory.') },
      async ({ which }) => {
        const memories = loadMemories(file)
        const w = String(which).trim().toLowerCase()
        const keep = memories.filter((m) => m.id !== w && !m.text.toLowerCase().includes(w))
        const removed = memories.length - keep.length
        if (!removed) return fail(`Nothing remembered matches "${which}".`)
        saveMemories(file, keep)
        return ok(`Forgot ${removed}.`)
      },
    ),
  ]
  return createSdkMcpServer({ name: 'jarvis_memory', version: '1.0.0', tools })
}

// ---------------------------------------------------------------------------
// Conversation notes
// ---------------------------------------------------------------------------

/** Every summary still being written, so a shutdown can wait for them. */
const inFlight = new Set()

/** Resolves once every summary in progress is written, or `capMs` passes. */
export function flushMemories(capMs = 12_000) {
  return Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise((r) => setTimeout(r, capMs).unref()),
  ])
}

/** The model's reply, parsed. Tolerates a code fence or stray prose around it. */
export function parseSummary(text) {
  const m = String(text ?? '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const v = JSON.parse(m[0])
    const summary = typeof v.summary === 'string' ? v.summary.trim() : ''
    const facts = Array.isArray(v.facts) ? v.facts.filter((f) => typeof f === 'string' && f.trim()) : []
    return { summary, facts: facts.slice(0, 5) }
  } catch {
    return null
  }
}

async function summarise(turns, known, userName) {
  const transcript = turns
    .map((t) => `${t.role === 'user' ? userName : 'JARVIS'}: ${t.text}`)
    .join('\n')
    .slice(-12_000)
  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
  const prompt = `Today is ${today}. Here is a voice conversation between ${userName} and JARVIS, their assistant.

${transcript}

Facts JARVIS already remembers about ${userName}:
${known.length ? known.map((f) => `- ${f}`).join('\n') : '- none'}

Reply with only a JSON object:
{"summary": "...", "facts": ["..."]}

summary: one or two sentences, past tense, on what the conversation was about and
anything decided or left to do — written so JARVIS can pick it up next time.
Name ${userName}. Skip greetings and small talk unless that was all there was.

facts: lasting facts about ${userName} that came up and are NOT already remembered
(their people, plans, preferences, circumstances), one per string, each a full
sentence that starts with their name ("${userName}'s girlfriend is called Klara.").
Turn relative dates into real ones ("next Monday" -> "on Monday 30 November").
Usually none. Never what they merely asked about, never anything temporary.`

  let out = ''
  for await (const msg of query({
    prompt,
    options: {
      model: SUMMARY_MODEL,
      systemPrompt: 'You write short, accurate memory notes. You reply with JSON only.',
      tools: [],
      mcpServers: {},
      settingSources: [],
      strictMcpConfig: true,
      maxTurns: 1,
      persistSession: false,
    },
  })) {
    if (msg.type === 'result' && msg.subtype === 'success') out = msg.result ?? ''
  }
  return parseSummary(out)
}

/**
 * One per connection: keeps the conversation as plain text and, when it goes
 * quiet or ends, writes a note of whatever has not been noted yet.
 */
/**
 * Write a note: summarise, then save. Run in a process of its own by default
 * (see detachNote), because it takes the better part of a minute and JARVIS
 * may be shutting down while it does.
 */
async function writeNote({ file, userName, turns, known }, summariser = summarise) {
  const result = await summariser(turns, known, userName)
  if (!result?.summary) return result
  const now = Date.now()
  const all = loadMemories(file)
  all.push({ id: newId(), kind: 'session', text: result.summary.slice(0, 600), saved: now })
  for (const f of result.facts) rememberFact(all, f, undefined, now)
  saveMemories(file, all)
  return result
}

/** Hand the note to a detached process that outlives this one. */
function detachNote(job) {
  const tmp = join(tmpdir(), `jarvis-note-${process.pid}-${Date.now()}.json`)
  writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 })
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--note', tmp], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  console.log('[jarvis] memory: noting the conversation')
}

export function conversationMemory({ file, userName, idleMs = IDLE_SUMMARY_MS, summariser = null }) {
  const turns = []
  let noted = 0
  let idle = null

  const note = () => {
    clearTimeout(idle)
    const fresh = turns.slice(noted)
    // A lone "hello" and goodbye is not worth a memory.
    if (fresh.filter((t) => t.role === 'user').length < 2) return Promise.resolve()
    noted = turns.length
    const known = loadMemories(file).filter((m) => m.kind === 'fact').map((m) => m.text)
    const work = { file, userName, turns: fresh, known }
    if (!summariser) {
      try {
        detachNote(work)
      } catch (err) {
        console.warn(`[jarvis] memory: could not note the conversation: ${err.message}`)
      }
      return Promise.resolve()
    }
    const job = writeNote(work, summariser)
      .catch((err) => console.warn(`[jarvis] memory: could not note the conversation: ${err.message}`))
      .finally(() => inFlight.delete(job))
    inFlight.add(job)
    return job
  }

  const add = (role, text) => {
    const t = String(text ?? '').trim()
    if (!t) return
    turns.push({ role, text: t.slice(0, 2000) })
    clearTimeout(idle)
    idle = setTimeout(note, idleMs)
    idle.unref?.()
  }

  return {
    heard: (text) => add('user', text),
    said: (text) => add('jarvis', text),
    /** The conversation is over (closed, asleep, shutting down): note it now. */
    end: note,
  }
}

/** Every open conversation, so a SIGTERM can note them all before exiting. */
export const openConversations = new Set()

export const memoryFile = (stateDir) => join(stateDir, 'memory.json')

// `node memory.mjs --note <job.json>`: the detached half of detachNote.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--note') {
  const jobFile = process.argv[3]
  const job = JSON.parse(readFileSync(jobFile, 'utf8'))
  rmSync(jobFile, { force: true })
  const logFile = join(dirname(job.file), '..', 'logs', 'memory.log')
  const log = (line) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }
  writeNote(job)
    .then((r) => log(r?.summary ? `noted: ${r.summary}${r.facts.length ? ` | facts: ${r.facts.join(' / ')}` : ''}` : 'nothing to note'))
    .catch((err) => log(`failed: ${err.message}`))
}
