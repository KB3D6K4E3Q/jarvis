import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { faceHost } from './routines.mjs'

/**
 * Background tasks and deep research — the long jobs.
 *
 * A voice turn has to end in a sentence or two, which rules out anything that
 * takes minutes: reading twenty pages, comparing six products, writing a
 * brief. So those run somewhere else. `task_start` hands the instruction to a
 * second, separate `query()` with its own context and its own tools, returns
 * an id immediately, and the conversation carries on. When the job finishes
 * JARVIS says so on whatever face is free, unprompted, the way a routine does.
 *
 * TWO KINDS
 *   task      one job, one pass. "Summarise this repo's README", "find the
 *             cheapest flight to Vienna on Friday".
 *   research  the same engine in fixed stages — plan, investigate, review,
 *             write. The review stage exists so the report is not the
 *             investigation's first draft with a confident tone on it: every
 *             claim is checked against the page it came from first.
 *
 * ON DISK
 *   Every stage is written to `tasks.json` as it completes, so a bridge
 *   restarted mid-job picks up at the stage it had reached rather than at the
 *   beginning. A job that was running when the process died is resumed on the
 *   next start; one that had already finished waits, and is announced when a
 *   face connects.
 *
 * WHAT IT MAY DO
 *   Reads only — web search, fetch, and the file tools inside JARVIS's own
 *   workspace. A background job is unsupervised by definition: the user is
 *   talking about something else while it runs, so it is not the place to let
 *   a shell loose. Writes stay with the foreground turn, where they can be
 *   announced before they happen.
 *
 * Ported from Mark-LVII's core/tasks (engine.py + research.py).
 */

const MIN = 60_000
const TICK_MS = 5_000
const MAX_ACTIVE = 2
const MAX_INSTRUCTION = 2000
const MAX_TITLE = 80
const MAX_KEPT = 40
/** A finished job is still worth hearing about this long after the fact. */
const ANNOUNCE_GRACE_MS = 6 * 60 * MIN
/** One stage of one job cannot run forever. */
const STAGE_TIMEOUT_MS = 10 * MIN

export const STAGES = ['plan', 'investigate', 'review', 'write']
const STAGE_LABEL = {
  plan: 'planning',
  investigate: 'investigating',
  review: 'checking the sources',
  write: 'writing it up',
  work: 'working',
}

// ---------------------------------------------------------------------------
// The stage prompts
// ---------------------------------------------------------------------------

const RESEARCH_SYSTEM = `You are the research half of JARVIS, working in the background while the
conversation carries on elsewhere. Nobody hears you think: write for a
colleague who will read this, in plain prose, with no persona and no address.

Rules that matter:
- Search and open real pages. Never answer from memory alone.
- Quote nothing you have not fetched. Every figure, date and claim must come
  from a page you actually opened in this job, and must carry its source.
- Where sources disagree, say so rather than picking the tidier one.
- Say plainly when something could not be established.`

const stagePrompt = {
  plan: (job) => `Research task: ${job.instruction}

Write the plan. List the specific questions that must be answered for this to
be useful, and the kind of source that would answer each. No searching yet.
Under two hundred words.`,

  investigate: (job, carry) => `Research task: ${job.instruction}

The plan:
${carry}

Now do the work. Search, open the pages, and gather what the plan asks for.
Report findings as notes, each with the page title and URL it came from.
Facts, not prose.`,

  review: (job, carry) => `Research task: ${job.instruction}

The findings:
${carry}

Check them. For each claim decide whether the source given actually supports
it, re-fetching anything you are unsure of. List what stands, what does not,
and what is still missing. Do not write the report yet.`,

  write: (job, carry) => `Research task: ${job.instruction}

The checked findings:
${carry}

Write the report. Lead with the answer in one paragraph, then the detail, then
the sources as a short list of titles and URLs. Drop anything the review could
not stand up. Under six hundred words.`,

  work: (job) => `${job.instruction}

Do this now, end to end, using search and the web where you need it. Answer in
prose, under four hundred words, leading with the result.`,
}

// ---------------------------------------------------------------------------
// The runner — a second query(), separate from the conversation
// ---------------------------------------------------------------------------

/** Drive one query() to its final text, or throw a sentence. */
async function runQuery({ prompt, model, cwd, controller }) {
  const session = query({
    prompt,
    options: {
      systemPrompt: RESEARCH_SYSTEM,
      model,
      cwd,
      // Reads only. See the note at the top of the file.
      tools: ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch'],
      settingSources: [],
      maxTurns: 40,
      persistSession: false,
      ...(controller ? { abortController: controller } : {}),
    },
  })
  let text = ''
  for await (const msg of session) {
    if (msg.type === 'assistant') {
      const parts = msg.message?.content ?? msg.content ?? []
      for (const part of parts) if (part?.type === 'text' && part.text) text = part.text
    }
    if (msg.type === 'result') {
      if (msg.subtype !== 'success') throw new Error(`stopped at ${msg.subtype}`)
      return String(msg.result ?? text ?? '').trim()
    }
  }
  return text.trim()
}

/** The real runner. Tests pass their own, which resolves without a model. */
export function sdkRunner({ model, cwd }) {
  return async (job, { onStage, cancelled }) => {
    const stages = job.kind === 'research' ? STAGES : ['work']
    let carry = job.carry ?? ''
    for (const stage of stages) {
      if (cancelled()) throw new Error('cancelled')
      // Resume: a stage already on disk is not run a second time.
      if (job.done?.includes(stage)) continue
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), STAGE_TIMEOUT_MS)
      try {
        carry = await runQuery({ prompt: stagePrompt[stage](job, carry), model, cwd, controller })
      } finally {
        clearTimeout(timer)
      }
      onStage(stage, carry)
    }
    return carry
  }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

const newId = () => Math.random().toString(36).slice(2, 8)
const clip = (text, max) => String(text ?? '').trim().slice(0, max)

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2))
  renameSync(tmp, file)
}

/** One line of a job for reading back — never the whole report. */
export function describeJob(job, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - job.startedAt) / MIN))
  const state =
    job.state === 'running'
      ? `${STAGE_LABEL[job.stage] ?? job.stage}, ${mins} min in`
      : job.state === 'done'
        ? 'finished'
        : job.state === 'failed'
          ? `failed — ${job.error ?? 'unknown'}`
          : job.state
  return `[${job.id}] ${job.title} — ${job.kind}, ${state}`
}

export function createTaskEngine({ file, run, host, now = () => Date.now(), maxActive = MAX_ACTIVE }) {
  const doc = readJson(file, { jobs: [] })
  if (!Array.isArray(doc.jobs)) doc.jobs = []
  const inFlight = new Set()
  const save = () => writeJson(file, doc)
  const byId = (id) => doc.jobs.find((j) => j.id === id)
  const active = () => doc.jobs.filter((j) => j.state === 'running')

  function find(which) {
    const key = clip(which, 120).toLowerCase()
    if (!key || key === 'last' || key === 'latest') return [...doc.jobs].reverse()[0] ?? null
    const recent = [...doc.jobs].reverse()
    return (
      byId(key) ??
      recent.find((j) => j.title.toLowerCase().includes(key)) ??
      recent.find((j) => j.instruction.toLowerCase().includes(key)) ??
      null
    )
  }

  function begin(job) {
    if (inFlight.has(job.id)) return
    inFlight.add(job.id)
    const cancelled = () => byId(job.id)?.state !== 'running'
    const onStage = (stage, text) => {
      const live = byId(job.id)
      if (!live || live.state !== 'running') return
      live.done = [...(live.done ?? []), stage]
      live.carry = text
      live.stage = STAGES[STAGES.indexOf(stage) + 1] ?? live.stage
      save()
    }
    Promise.resolve()
      .then(() => run(byId(job.id) ?? job, { onStage, cancelled }))
      .then(
        (result) => {
          const live = byId(job.id)
          if (!live || live.state !== 'running') return
          live.state = 'done'
          live.result = clip(result, 20_000)
          live.endedAt = now()
          save()
        },
        (err) => {
          const live = byId(job.id)
          if (!live || live.state !== 'running') return
          live.state = 'failed'
          live.error = clip(err?.message ?? err, 200)
          live.endedAt = now()
          save()
        },
      )
      .finally(() => inFlight.delete(job.id))
  }

  function start({ instruction, kind = 'task', title }) {
    const text = clip(instruction, MAX_INSTRUCTION)
    if (!text) throw new Error('Give the instruction to carry out in the background.')
    if (active().length >= maxActive) {
      throw new Error(`${maxActive} background jobs are already running. Wait for one, or cancel it.`)
    }
    const research = String(kind).toLowerCase() === 'research'
    const job = {
      id: newId(),
      title: clip(title, MAX_TITLE) || clip(text.split(/[.?!\n]/)[0], MAX_TITLE),
      kind: research ? 'research' : 'task',
      instruction: text,
      state: 'running',
      stage: research ? 'plan' : 'work',
      done: [],
      carry: '',
      result: '',
      error: null,
      startedAt: now(),
      endedAt: null,
      announced: false,
    }
    doc.jobs = [...doc.jobs, job].slice(-MAX_KEPT)
    save()
    begin(job)
    return { ...job }
  }

  function cancel(id) {
    const job = byId(id)
    if (!job) return null
    if (job.state === 'running') {
      job.state = 'cancelled'
      job.endedAt = now()
      // Asked for by hand, so there is nothing to announce back.
      job.announced = true
      save()
    }
    return { ...job }
  }

  /**
   * Pick up jobs that were running when the process stopped. Their finished
   * stages are on disk, so the runner skips to the one that was interrupted.
   */
  function resume() {
    for (const job of active()) begin(job)
  }

  /** Report whatever has finished, as soon as there is a face free to hear it. */
  function tick() {
    for (const job of doc.jobs) {
      if (job.announced || job.state === 'running') continue
      if (now() - (job.endedAt ?? job.startedAt) > ANNOUNCE_GRACE_MS) {
        job.announced = true
        save()
        continue
      }
      if (!host.ready()) continue
      job.announced = true
      save()
      try {
        host.prompt(report(job))
      } catch {
        // No face took it after all; try again on the next tick.
        job.announced = false
        save()
      }
    }
  }

  return {
    start,
    cancel,
    find,
    resume,
    tick,
    list: () => doc.jobs.map((j) => ({ ...j })),
    get: (id) => {
      const j = byId(id)
      return j ? { ...j } : null
    },
  }
}

/** What a finished job says to the conversation when it reports back. */
export function report(job) {
  if (job.state !== 'done') {
    return `[TASK ${job.id}] The background ${job.kind} "${job.title}" did not finish: ${job.error ?? job.state}. Say so in one sentence.`
  }
  return (
    `[TASK ${job.id}] The background ${job.kind} "${job.title}" has finished. Nobody spoke — this is the job ` +
    `reporting back. Give the headline in one or two sentences and put the detail on a blade. Never read it aloud.` +
    `\n\n${job.result}`
  )
}

// ---------------------------------------------------------------------------
// The bridge's engine
// ---------------------------------------------------------------------------

let engine = null

export function startTasks({ stateDir, model, cwd, run }) {
  if (engine) return engine
  mkdirSync(stateDir, { recursive: true })
  engine = createTaskEngine({
    file: join(stateDir, 'tasks.json'),
    run: run ?? sdkRunner({ model, cwd }),
    host: faceHost(),
  })
  engine.resume()
  const timer = setInterval(() => engine.tick(), TICK_MS)
  timer.unref?.()
  return engine
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const ok = (text) => ({ content: [{ type: 'text', text }] })
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true })
const guarded = (fn) => async (args) => {
  try {
    return await fn(args)
  } catch (err) {
    return fail(String(err?.message ?? err))
  }
}

function pick(eng, which) {
  const job = eng.find(which)
  if (!job) throw new Error(`No background job matches "${which}". task_list shows them.`)
  return job
}

export function taskTools(eng) {
  return [
    tool(
      'task_start',
      'Hand a long job to the background and carry on talking: anything that would take minutes rather than ' +
        'seconds — reading several pages, comparing options, writing a brief. It returns at once with an id, ' +
        'and when it finishes you are handed the result unprompted and tell the user then. ' +
        'kind "research" runs it in stages (plan, investigate, check the sources, write) and is the right one for ' +
        '"research this properly" or "look into it for ten minutes". Never use it for something you can answer now.',
      {
        instruction: z
          .string()
          .describe('What to find out or do, written as an instruction, carrying any detail the job will need.'),
        kind: z.enum(['task', 'research']).optional().describe('"task" for one pass, "research" for the staged version. Default task.'),
        title: z.string().optional().describe('Two to four words naming it, e.g. "Vienna flights".'),
      },
      guarded(async ({ instruction, kind, title }) => {
        const job = eng.start({ instruction, kind, title })
        return ok(`Started: ${describeJob(job)}. It runs in the background; you will be told when it is done.`)
      }),
    ),
    tool(
      'task_list',
      'The background jobs: what is running, how far along it is, and what has finished.',
      {},
      guarded(async () => {
        const all = eng.list()
        return ok(all.length ? all.map((j) => describeJob(j)).join('\n') : 'No background jobs.')
      }),
    ),
    tool(
      'task_result',
      'Read back what a finished background job found — when the user asks about one again, or wants more than the headline.',
      { which: z.string().optional().describe('Its id, words from its title, or leave empty for the most recent.') },
      guarded(async ({ which }) => {
        const job = pick(eng, which)
        if (job.state === 'running') return ok(`${describeJob(job)}. Nothing to read back yet.`)
        if (job.state !== 'done') return fail(`${describeJob(job)}.`)
        return ok(job.result || 'It finished with nothing to show.')
      }),
    ),
    tool(
      'task_cancel',
      'Stop a background job ("forget that research").',
      { which: z.string().describe('Its id, or words from its title.') },
      guarded(async ({ which }) => {
        const job = pick(eng, which)
        eng.cancel(job.id)
        return ok(`Stopped "${job.title}".`)
      }),
    ),
  ]
}

export function tasksServer({ stateDir, model, cwd, run }) {
  const eng = startTasks({ stateDir, model, cwd, run })
  return createSdkMcpServer({ name: 'jarvis_tasks', version: '1.0.0', tools: taskTools(eng) })
}

export const PROMPT_TASKS = `Long jobs (the task_* tools):
- Anything that would take minutes rather than seconds goes to task_start, and
  you carry on talking. One line to say it is running — never a progress
  commentary, never an estimate you cannot keep.
- "Research this properly", "look into it for ten minutes", "dig into it" is
  kind "research": it plans, investigates, checks its own sources, then writes.
- A message starting with [TASK …] is a finished job reporting back. Nobody
  spoke. Give the headline in one or two sentences and put the detail on a
  blade; never read the report aloud.
- task_list for what is running, task_result to read one back later,
  task_cancel to stop one.
`
