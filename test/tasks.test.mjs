import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { STAGES, createTaskEngine, describeJob, report, taskTools } from '../bridge/tasks.mjs'
import { decideTool } from '../bridge/policy.mjs'

const MIN = 60_000
const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jarvis-tasks-')), 'tasks.json')

/** A runner the test drives by hand: resolve or reject when it suits. */
function manualRunner() {
  const calls = []
  const runner = (job, ctx) =>
    new Promise((resolve, reject) => {
      calls.push({ job, ctx, resolve, reject })
    })
  runner.calls = calls
  runner.last = () => calls[calls.length - 1]
  return runner
}

/** A face that is listening, and remembers what it was told. */
function fakeHost({ ready = true } = {}) {
  let listening = ready
  const prompts = []
  return {
    prompts,
    ready: () => listening,
    prompt: (text) => prompts.push(text),
    listen(v) {
      listening = v
    },
  }
}

/** The engine hands a job to the runner off the microtask queue, not inline. */
const settle = () => new Promise((r) => setImmediate(r))

function engineWith({ run, host = fakeHost(), file = tempFile(), now, maxActive } = {}) {
  return createTaskEngine({ file, run, host, now, maxActive })
}

/** Start a job and wait until the runner actually has it. */
async function startJob(eng, args) {
  const job = eng.start(args)
  await settle()
  return job
}

// ---------------------------------------------------------------------------
// Starting a job
// ---------------------------------------------------------------------------

test('a started job comes back at once, running, with an id and a title', async () => {
  const run = manualRunner()
  const eng = engineWith({ run })
  const job = eng.start({ instruction: 'Compare three espresso machines. Budget two hundred euros.' })

  assert.match(job.id, /^[a-z0-9]{1,6}$/)
  assert.equal(job.state, 'running')
  assert.equal(job.kind, 'task')
  assert.equal(job.stage, 'work')
  assert.equal(job.title, 'Compare three espresso machines')

  await settle()
  assert.equal(run.calls.length, 1, 'the runner is handed the job without waiting for the turn')
})

test('a research job runs in stages and a task job does not', () => {
  const run = manualRunner()
  const eng = engineWith({ run })
  assert.equal(eng.start({ instruction: 'Look into the Petrov incident', kind: 'research' }).stage, 'plan')
  assert.equal(eng.start({ instruction: 'Summarise the README' }).stage, 'work')
  assert.deepEqual(STAGES, ['plan', 'investigate', 'review', 'write'])
})

test('an empty instruction is refused and nothing is started', async () => {
  const run = manualRunner()
  const eng = engineWith({ run })
  assert.throws(() => eng.start({ instruction: '   ' }), /instruction/)
  await settle()
  assert.equal(run.calls.length, 0)
  assert.equal(eng.list().length, 0)
})

test('only so many jobs run at once', async () => {
  const run = manualRunner()
  const eng = engineWith({ run, maxActive: 2 })
  await startJob(eng, { instruction: 'one' })
  await startJob(eng, { instruction: 'two' })
  assert.throws(() => eng.start({ instruction: 'three' }), /already running/)

  // Finishing one frees the slot.
  run.calls[0].resolve('done')
  await settle()
  assert.doesNotThrow(() => eng.start({ instruction: 'three' }))
})

test('a spoken title is kept, and a long one is clipped', () => {
  const eng = engineWith({ run: manualRunner() })
  assert.equal(eng.start({ instruction: 'anything', title: 'Vienna flights' }).title, 'Vienna flights')
  const long = eng.start({ instruction: 'x', title: 'a'.repeat(200) })
  assert.equal(long.title.length, 80)
})

// ---------------------------------------------------------------------------
// Finishing, failing, cancelling
// ---------------------------------------------------------------------------

test('a finished job holds its result and is written to disk', async () => {
  const run = manualRunner()
  const file = tempFile()
  const eng = engineWith({ run, file })
  const { id } = await startJob(eng, { instruction: 'Summarise the README' })

  run.last().resolve('The README describes the bridge.')
  await settle()

  const job = eng.get(id)
  assert.equal(job.state, 'done')
  assert.equal(job.result, 'The README describes the bridge.')
  assert.ok(job.endedAt)

  const onDisk = JSON.parse(readFileSync(file, 'utf8')).jobs.find((j) => j.id === id)
  assert.equal(onDisk.state, 'done')
  assert.equal(onDisk.result, 'The README describes the bridge.')
})

test('a failed job keeps the reason as a sentence, not a stack', async () => {
  const run = manualRunner()
  const eng = engineWith({ run })
  const { id } = await startJob(eng, { instruction: 'Fetch something unreachable' })

  run.last().reject(new Error('stopped at error_max_turns'))
  await settle()

  const job = eng.get(id)
  assert.equal(job.state, 'failed')
  assert.equal(job.error, 'stopped at error_max_turns')
})

test('each completed stage is saved, so a restart resumes rather than repeats', async () => {
  const run = manualRunner()
  const file = tempFile()
  const eng = engineWith({ run, file })
  const { id } = await startJob(eng, { instruction: 'Look into it', kind: 'research' })

  run.last().ctx.onStage('plan', 'the plan')
  run.last().ctx.onStage('investigate', 'the notes')

  const job = eng.get(id)
  assert.deepEqual(job.done, ['plan', 'investigate'])
  assert.equal(job.carry, 'the notes')
  assert.equal(job.stage, 'review', 'the stage moves on to the one now running')

  const onDisk = JSON.parse(readFileSync(file, 'utf8')).jobs.find((j) => j.id === id)
  assert.deepEqual(onDisk.done, ['plan', 'investigate'])
})

test('cancelling stops the job and the runner is told', async () => {
  const run = manualRunner()
  const eng = engineWith({ run })
  const { id } = await startJob(eng, { instruction: 'Watch the flight prices all afternoon' })

  assert.equal(run.last().ctx.cancelled(), false)
  const cancelled = eng.cancel(id)
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(run.last().ctx.cancelled(), true, 'the runner can see it was cancelled')

  // A late result from the runner does not revive it.
  run.last().resolve('too late')
  await settle()
  assert.equal(eng.get(id).state, 'cancelled')
})

test('a stage finishing after a cancel is not written back', async () => {
  const run = manualRunner()
  const eng = engineWith({ run })
  const { id } = await startJob(eng, { instruction: 'Look into it', kind: 'research' })
  eng.cancel(id)
  run.last().ctx.onStage('plan', 'the plan')
  assert.deepEqual(eng.get(id).done, [])
})

test('resuming hands back only the jobs that were still running', async () => {
  const file = tempFile()
  writeFileSync(
    file,
    JSON.stringify({
      jobs: [
        {
          id: 'aaaaaa',
          title: 'half done',
          kind: 'research',
          instruction: 'x',
          state: 'running',
          stage: 'review',
          done: ['plan', 'investigate'],
          carry: 'notes',
          startedAt: 1,
          announced: false,
        },
        {
          id: 'bbbbbb',
          title: 'finished',
          kind: 'task',
          instruction: 'y',
          state: 'done',
          result: 'r',
          startedAt: 1,
          endedAt: 2,
          announced: true,
        },
      ],
    }),
  )
  const run = manualRunner()
  const eng = engineWith({ run, file })
  eng.resume()
  await settle()

  assert.equal(run.calls.length, 1)
  const resumed = run.last().job
  assert.equal(resumed.id, 'aaaaaa')
  assert.deepEqual(resumed.done, ['plan', 'investigate'], 'the runner skips the stages already on disk')
  assert.equal(resumed.carry, 'notes')
})

// ---------------------------------------------------------------------------
// Reporting back, unprompted
// ---------------------------------------------------------------------------

test('a finished job is announced once, and only once', async () => {
  const run = manualRunner()
  const host = fakeHost()
  const eng = engineWith({ run, host })
  await startJob(eng, { instruction: 'Summarise the README', title: 'README' })
  run.last().resolve('It describes the bridge.')
  await settle()

  eng.tick()
  eng.tick()
  assert.equal(host.prompts.length, 1)
  assert.match(host.prompts[0], /^\[TASK /)
  assert.match(host.prompts[0], /It describes the bridge\./)
})

test('nothing is announced while no face is listening', async () => {
  const run = manualRunner()
  const host = fakeHost({ ready: false })
  const eng = engineWith({ run, host })
  await startJob(eng, { instruction: 'Summarise the README' })
  run.last().resolve('text')
  await settle()

  eng.tick()
  assert.equal(host.prompts.length, 0)

  host.listen(true)
  eng.tick()
  assert.equal(host.prompts.length, 1, 'it waits for a face rather than dropping the result')
})

test('a result nobody heard for hours is dropped rather than announced stale', async () => {
  const run = manualRunner()
  const host = fakeHost({ ready: false })
  let clock = 1_000_000
  const eng = engineWith({ run, host, now: () => clock })
  await startJob(eng, { instruction: 'Summarise the README' })
  run.last().resolve('text')
  await settle()

  clock += 7 * 60 * MIN
  host.listen(true)
  eng.tick()
  assert.equal(host.prompts.length, 0)
})

test('a cancelled job never reports back', async () => {
  const run = manualRunner()
  const host = fakeHost()
  const eng = engineWith({ run, host })
  const { id } = await startJob(eng, { instruction: 'Watch the prices' })
  eng.cancel(id)
  eng.tick()
  assert.equal(host.prompts.length, 0)
})

test('a failed job still reports back, as a failure', async () => {
  const run = manualRunner()
  const host = fakeHost()
  const eng = engineWith({ run, host })
  await startJob(eng, { instruction: 'Fetch it', title: 'Flights' })
  run.last().reject(new Error('stopped at error_max_turns'))
  await settle()
  eng.tick()

  assert.equal(host.prompts.length, 1)
  assert.match(host.prompts[0], /did not finish/)
})

test('the report tells the conversation nobody spoke, and not to read it aloud', () => {
  const done = report({
    id: 'abc123',
    title: 'Flights',
    kind: 'research',
    state: 'done',
    result: 'Vienna, Friday, ninety euros.',
  })
  assert.match(done, /Nobody spoke/)
  assert.match(done, /Never read it aloud/)
  assert.match(done, /Vienna, Friday, ninety euros\./)

  const bad = report({ id: 'abc123', title: 'Flights', kind: 'task', state: 'failed', error: 'no network' })
  assert.match(bad, /did not finish: no network/)
})

// ---------------------------------------------------------------------------
// Finding one again
// ---------------------------------------------------------------------------

test('a job is found by id, by words from it, or as the latest', () => {
  const eng = engineWith({ run: manualRunner(), maxActive: 9 })
  const first = eng.start({ instruction: 'Compare espresso machines', title: 'Espresso machines' })
  const second = eng.start({ instruction: 'Find flights to Vienna on Friday', title: 'Vienna flights' })

  assert.equal(eng.find(first.id).id, first.id)
  assert.equal(eng.find('espresso').id, first.id)
  assert.equal(eng.find('Vienna').id, second.id)
  assert.equal(eng.find('friday').id, second.id, 'words from the instruction count too')
  assert.equal(eng.find('last').id, second.id)
  assert.equal(eng.find('').id, second.id)
  assert.equal(eng.find('submarines'), null)
})

test('one line of a job reads as something sayable', () => {
  const now = 1_000_000
  const running = describeJob(
    {
      id: 'abc123',
      title: 'Vienna flights',
      kind: 'research',
      state: 'running',
      stage: 'investigate',
      startedAt: now - 3 * MIN,
    },
    now,
  )
  assert.equal(running, '[abc123] Vienna flights — research, investigating, 3 min in')
  assert.match(describeJob({ id: 'x', title: 'T', kind: 'task', state: 'done', startedAt: now }, now), /finished$/)
  assert.match(
    describeJob({ id: 'x', title: 'T', kind: 'task', state: 'failed', error: 'no network', startedAt: now }, now),
    /failed — no network$/,
  )
})

// ---------------------------------------------------------------------------
// The tools, as the model sees them
// ---------------------------------------------------------------------------

const toolset = (eng) => Object.fromEntries(taskTools(eng).map((t) => [t.name, t]))
const text = (res) => res.content.map((c) => c.text).join('\n')

test('the four task tools are offered', () => {
  const names = Object.keys(toolset(engineWith({ run: manualRunner() })))
  assert.deepEqual(names, ['task_start', 'task_list', 'task_result', 'task_cancel'])
})

test('task_start answers with the id and says it is running', async () => {
  const eng = engineWith({ run: manualRunner() })
  const out = text(
    await toolset(eng).task_start.handler({ instruction: 'Look into it', kind: 'research', title: 'Petrov' }),
  )
  assert.match(out, /Started: \[[a-z0-9]{1,6}\] Petrov — research/)
  assert.match(out, /background/)
})

test('task_start reports the limit as a sentence rather than throwing', async () => {
  const eng = engineWith({ run: manualRunner(), maxActive: 1 })
  const tools = toolset(eng)
  await tools.task_start.handler({ instruction: 'one' })
  const res = await tools.task_start.handler({ instruction: 'two' })
  assert.equal(res.isError, true)
  assert.match(text(res), /already running/)
})

test('task_list says so plainly when there is nothing running', async () => {
  const eng = engineWith({ run: manualRunner() })
  assert.match(text(await toolset(eng).task_list.handler({})), /No background jobs/)
})

test('task_result holds back a job that is still going, and reads a finished one', async () => {
  const run = manualRunner()
  const eng = engineWith({ run })
  const tools = toolset(eng)
  await tools.task_start.handler({ instruction: 'Look into it', title: 'Petrov' })
  await settle()

  assert.match(text(await tools.task_result.handler({ which: 'Petrov' })), /Nothing to read back yet/)

  run.last().resolve('Stanislav Petrov, 1983.')
  await settle()
  assert.equal(text(await tools.task_result.handler({ which: 'Petrov' })), 'Stanislav Petrov, 1983.')
})

test('task_result on a job that does not exist is an error with a way forward', async () => {
  const eng = engineWith({ run: manualRunner() })
  const res = await toolset(eng).task_result.handler({ which: 'submarines' })
  assert.equal(res.isError, true)
  assert.match(text(res), /task_list/)
})

test('task_cancel stops it by name', async () => {
  const run = manualRunner()
  const eng = engineWith({ run })
  const tools = toolset(eng)
  await tools.task_start.handler({ instruction: 'Watch the prices', title: 'Flight prices' })
  assert.match(text(await tools.task_cancel.handler({ which: 'flight' })), /Stopped "Flight prices"/)
  assert.equal(eng.list()[0].state, 'cancelled')
})

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

test('the task tools are allowed in the default read-only mode', () => {
  assert.equal(decideTool('mcp__jarvis_tasks__task_start'), true)
  assert.equal(decideTool('mcp__jarvis_tasks__task_cancel'), true)
  assert.equal(decideTool('mcp__jarvis_tasks__task_list'), true)
  assert.equal(decideTool('mcp__jarvis_tasks__task_result'), true)
})
