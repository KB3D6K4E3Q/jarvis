import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRoutineEngine,
  describeRule,
  hhmm,
  inQuiet,
  nextFire,
  parseDays,
  triggerFromArgs,
} from '../bridge/routines.mjs'
import { decideTool } from '../bridge/policy.mjs'

const MIN = 60_000
const HOUR = 60 * MIN
const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jarvis-routines-')), 'routines.json')
/** Local wall-clock time, so every assertion reads in the machine's own zone. */
const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0)

// ---------------------------------------------------------------------------
// Time rules
// ---------------------------------------------------------------------------

test('hhmm accepts the ways a time is spoken and rejects nonsense', () => {
  assert.equal(hhmm('8:30'), '08:30')
  assert.equal(hhmm('8.30'), '08:30')
  assert.equal(hhmm('17'), '17:00')
  assert.equal(hhmm('5pm'), '17:00')
  assert.equal(hhmm('12am'), '00:00')
  assert.throws(() => hhmm('25:00'), /time of day/)
  assert.throws(() => hhmm('soon'), /time of day/)
})

test('parseDays understands numbers, names and groups', () => {
  assert.deepEqual(parseDays(undefined), [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(parseDays('weekdays'), [1, 2, 3, 4, 5])
  assert.deepEqual(parseDays('weekends'), [6, 7])
  assert.deepEqual(parseDays('mon, wed, friday'), [1, 3, 5])
  assert.deepEqual(parseDays([7, 1, 1]), [1, 7])
  assert.deepEqual(parseDays('1,2'), [1, 2])
  assert.throws(() => parseDays('someday'), /days/)
})

test('a weekly rule fires on the next allowed day, strictly after now', () => {
  // 2026-11-23 is a Monday.
  const rule = { type: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5] }
  assert.deepEqual(nextFire(rule, at(2026, 11, 23, 8, 0)), at(2026, 11, 23, 8, 30))
  assert.deepEqual(nextFire(rule, at(2026, 11, 23, 8, 30)), at(2026, 11, 24, 8, 30))
  // Friday evening → Monday morning.
  assert.deepEqual(nextFire(rule, at(2026, 11, 27, 20, 0)), at(2026, 11, 30, 8, 30))
})

test('a monthly rule on day 31 lands on the last day of short months', () => {
  const rule = { type: 'monthly', day: 31, time: '09:00' }
  assert.deepEqual(nextFire(rule, at(2026, 11, 2)), at(2026, 11, 30, 9, 0))
  assert.deepEqual(nextFire(rule, at(2026, 11, 30, 10, 0)), at(2026, 12, 31, 9, 0))
  assert.deepEqual(nextFire(rule, at(2027, 2, 1)), at(2027, 2, 28, 9, 0))
})

test('an interval rule stays inside its window and resumes the next day', () => {
  const rule = { type: 'interval', minutes: 30, start: '08:00', end: '10:00', days: [1, 2, 3, 4, 5, 6, 7] }
  assert.deepEqual(nextFire(rule, at(2026, 11, 23, 7, 0)), at(2026, 11, 23, 8, 0))
  assert.deepEqual(nextFire(rule, at(2026, 11, 23, 8, 10)), at(2026, 11, 23, 8, 30))
  assert.deepEqual(nextFire(rule, at(2026, 11, 23, 10, 0)), at(2026, 11, 24, 8, 0))
})

test('a one-off rule fires once and never again', () => {
  const when = at(2026, 11, 23, 12, 0)
  const rule = { type: 'once', at: when.getTime() }
  assert.deepEqual(nextFire(rule, at(2026, 11, 23, 11, 0)), when)
  assert.equal(nextFire(rule, when), null)
})

test('describeRule reads back in plain words', () => {
  assert.equal(describeRule({ type: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5] }), 'at 08:30 on weekdays')
  assert.equal(describeRule({ type: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5, 6, 7] }), 'at 08:30 every day')
  assert.equal(describeRule({ type: 'monthly', day: 1, time: '09:00' }), 'on day 1 of every month at 09:00')
  assert.match(describeRule({ type: 'interval', minutes: 30, start: '08:00', end: '23:00', days: [6, 7] }), /every 30 min, 08:00-23:00 on weekends/)
  assert.match(describeRule({ type: 'weekly', time: '07:00', days: [1, 3] }), /on Mon, Wed/)
})

test('triggerFromArgs turns tool arguments into a trigger', () => {
  const now = at(2026, 11, 23, 9, 0)
  assert.deepEqual(triggerFromArgs({ time: '8:30', days: 'weekdays' }, now), {
    type: 'time',
    rule: { type: 'weekly', time: '08:30', days: [1, 2, 3, 4, 5] },
  })
  assert.deepEqual(triggerFromArgs({ every_minutes: '45', between: '9-17' }, now).rule, {
    type: 'interval', minutes: 45, start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5, 6, 7],
  })
  assert.deepEqual(triggerFromArgs({ monthly_day: 15, time: '10:00' }, now).rule, { type: 'monthly', day: 15, time: '10:00' })
  assert.deepEqual(triggerFromArgs({ on: 'startup' }, now), { type: 'startup' })
  assert.deepEqual(triggerFromArgs({ on: 'idle', idle_minutes: 30 }, now), { type: 'idle', minutes: 30, cooldown: 60 })
  assert.equal(triggerFromArgs({ at: '2026-11-24 07:15' }, now).rule.at, at(2026, 11, 24, 7, 15).getTime())
  assert.throws(() => triggerFromArgs({ every_minutes: 2 }, now), /at least 5/)
  assert.throws(() => triggerFromArgs({ monthly_day: 3 }, now), /needs a time/)
  assert.throws(() => triggerFromArgs({ at: '2026-11-22 07:15' }, now), /passed/)
  assert.throws(() => triggerFromArgs({}, now), /say when/)
})

test('quiet hours can wrap past midnight', () => {
  assert.equal(inQuiet('23:00-07:00', at(2026, 11, 23, 23, 30)), true)
  assert.equal(inQuiet('23:00-07:00', at(2026, 11, 23, 6, 59)), true)
  assert.equal(inQuiet('23:00-07:00', at(2026, 11, 23, 7, 0)), false)
  assert.equal(inQuiet('13:00-14:00', at(2026, 11, 23, 13, 30)), true)
  assert.equal(inQuiet('', at(2026, 11, 23, 3, 0)), false)
})

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/** A host whose state each test sets by hand, recording what it was asked to do. */
function fakeHost() {
  const host = {
    isConnected: true,
    isReady: true,
    quietFor: HOUR,
    said: [],
    prompted: [],
    notified: [],
    connected: () => host.isConnected,
    ready: () => host.isReady,
    idleMs: () => host.quietFor,
    say: (text) => host.said.push(text),
    prompt: (text) => host.prompted.push(text),
    notify: (text) => host.notified.push(text),
  }
  return host
}

function setup(start = at(2026, 11, 23, 8, 0)) {
  const clock = { t: start.getTime() }
  const host = fakeHost()
  const file = tempFile()
  const engine = createRoutineEngine({ file, host, now: () => clock.t, log: () => {} })
  return { clock, host, file, engine }
}

test('a timed say routine speaks when due and moves to its next time', () => {
  const { clock, host, engine } = setup()
  const r = engine.add({ name: 'stand-up', kind: 'say', text: 'Stand-up in five.', trigger: triggerFromArgs({ time: '08:30' }) })
  engine.tick()
  assert.deepEqual(host.said, [])
  clock.t = at(2026, 11, 23, 8, 30).getTime()
  engine.tick()
  assert.deepEqual(host.said, ['Stand-up in five.'])
  assert.equal(engine.get(r.id).next, at(2026, 11, 24, 8, 30).getTime())
  assert.equal(engine.get(r.id).runs, 1)
  engine.tick()
  assert.equal(host.said.length, 1)
})

test('routines persist to disk and load back', () => {
  const { file, engine, host } = setup()
  engine.add({ name: 'water', kind: 'say', text: 'Drink some water.', trigger: triggerFromArgs({ every_minutes: 60 }) })
  engine.setQuietHours('23:00-07:00')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.routines.length, 1)
  assert.equal(saved.quietHours, '23:00-07:00')
  const again = createRoutineEngine({ file, host, now: () => Date.now(), log: () => {} })
  assert.equal(again.list()[0].name, 'water')
  assert.equal(again.quietHours(), '23:00-07:00')
})

test('a say routine with no face connected goes to a notification instead', () => {
  const { clock, host, engine } = setup()
  host.isConnected = false
  host.isReady = false
  engine.add({ name: 'bins', kind: 'say', text: 'Bins go out tonight.', trigger: triggerFromArgs({ time: '08:05' }) })
  clock.t = at(2026, 11, 23, 8, 5).getTime()
  engine.tick()
  assert.deepEqual(host.said, [])
  assert.deepEqual(host.notified, ['Bins go out tonight.'])
})

test('a due routine waits while JARVIS is busy, then runs', () => {
  const { clock, host, engine } = setup()
  engine.add({ name: 'brief', kind: 'prompt', text: 'Give me the news.', trigger: triggerFromArgs({ time: '08:10' }) })
  clock.t = at(2026, 11, 23, 8, 10).getTime()
  host.isReady = false
  engine.tick()
  assert.equal(host.prompted.length, 0)
  host.isReady = true
  clock.t += 5 * MIN
  engine.tick()
  assert.equal(host.prompted.length, 1)
  assert.match(host.prompted[0], /ROUTINE "brief"/)
  assert.match(host.prompted[0], /Give me the news\./)
})

test('a timed routine does not cut in while the user is mid-sentence', () => {
  const { clock, host, engine } = setup()
  engine.add({ name: 'x', kind: 'say', text: 'Hello.', trigger: triggerFromArgs({ time: '08:10' }) })
  clock.t = at(2026, 11, 23, 8, 10).getTime()
  host.quietFor = 2_000
  engine.tick()
  assert.deepEqual(host.said, [])
  host.quietFor = 20_000
  engine.tick()
  assert.deepEqual(host.said, ['Hello.'])
})

test('a routine missed by more than its grace is skipped, not spoken late', () => {
  const { clock, host, engine } = setup()
  const r = engine.add({ name: 'brief', kind: 'prompt', text: 'News.', trigger: triggerFromArgs({ time: '08:10' }) })
  clock.t = at(2026, 11, 23, 10, 0).getTime()
  engine.tick()
  assert.equal(host.prompted.length, 0)
  assert.match(engine.get(r.id).lastResult, /missed/)
  assert.equal(engine.get(r.id).next, at(2026, 11, 24, 8, 10).getTime())
})

test('a one-off routine is removed once it has run', () => {
  const { clock, host, engine } = setup()
  engine.add({ name: 'call', kind: 'say', text: 'Call the bank.', trigger: triggerFromArgs({ at: '2026-11-23 09:00' }, new Date(clock.t)) })
  clock.t = at(2026, 11, 23, 9, 0).getTime()
  engine.tick()
  assert.deepEqual(host.said, ['Call the bank.'])
  assert.equal(engine.list().length, 0)
})

test('quiet hours hold back unprompted routines but not ones set for a time', () => {
  const { clock, host, engine } = setup(at(2026, 11, 23, 23, 0))
  engine.setQuietHours('22:00-07:00')
  engine.add({ name: 'checkin', kind: 'prompt', text: 'Check in.', trigger: triggerFromArgs({ on: 'idle', idle_minutes: 15 }) })
  engine.add({ name: 'late', kind: 'say', text: 'Late call.', trigger: triggerFromArgs({ time: '23:10' }) })
  clock.t = at(2026, 11, 23, 23, 10).getTime()
  engine.tick()
  assert.equal(host.prompted.length, 0)
  assert.deepEqual(host.said, ['Late call.'])
})

test('an idle routine fires after the quiet spell and respects its cooldown', () => {
  const { clock, host, engine } = setup(at(2026, 11, 23, 12, 0))
  engine.add({ name: 'checkin', kind: 'prompt', text: 'Check in.', trigger: triggerFromArgs({ on: 'idle', idle_minutes: 20, cooldown_minutes: 60 }) })
  host.quietFor = 10 * MIN
  engine.tick()
  assert.equal(host.prompted.length, 0)
  host.quietFor = 25 * MIN
  engine.tick()
  assert.equal(host.prompted.length, 1)
  clock.t += 30 * MIN
  engine.tick()
  assert.equal(host.prompted.length, 1)
  clock.t += 31 * MIN
  engine.tick()
  assert.equal(host.prompted.length, 2)
})

test('a startup routine runs once, after the first connection', () => {
  const { host, engine } = setup()
  engine.add({ name: 'hello', kind: 'say', text: 'Good to see you.', trigger: triggerFromArgs({ on: 'startup' }) })
  engine.tick()
  assert.deepEqual(host.said, [])
  engine.started()
  engine.tick()
  engine.started()
  engine.tick()
  assert.deepEqual(host.said, ['Good to see you.'])
})

test('routines can be found by id or name, updated, paused and removed', () => {
  const { engine } = setup()
  const r = engine.add({ name: 'Morning briefing', kind: 'prompt', text: 'Brief me.', trigger: triggerFromArgs({ time: '08:00' }) })
  assert.equal(engine.find(r.id).id, r.id)
  assert.equal(engine.find('briefing').id, r.id)
  const moved = engine.update(r.id, { trigger: triggerFromArgs({ time: '8:30' }) })
  assert.equal(moved.trigger.rule.time, '08:30')
  assert.equal(moved.next, at(2026, 11, 23, 8, 30).getTime())
  assert.equal(engine.update(r.id, { enabled: false }).enabled, false)
  assert.equal(engine.remove(r.id), true)
  assert.equal(engine.find('briefing'), null)
})

test('a paused routine does not fire, and resuming picks the next time from now', () => {
  const { clock, host, engine } = setup()
  const r = engine.add({ name: 'x', kind: 'say', text: 'Hi.', trigger: triggerFromArgs({ time: '08:10' }) })
  engine.update(r.id, { enabled: false })
  clock.t = at(2026, 11, 23, 8, 10).getTime()
  engine.tick()
  assert.deepEqual(host.said, [])
  clock.t = at(2026, 11, 23, 12, 0).getTime()
  assert.equal(engine.update(r.id, { enabled: true }).next, at(2026, 11, 24, 8, 10).getTime())
})

test('run now fires a routine immediately and reports a failure', () => {
  const { host, engine } = setup()
  const r = engine.add({ name: 'x', kind: 'say', text: 'Now.', trigger: triggerFromArgs({ time: '20:00' }) })
  assert.equal(engine.runNow(r.id), 'ran')
  assert.deepEqual(host.said, ['Now.'])
  host.say = () => {
    throw new Error('speaker gone')
  }
  assert.match(engine.runNow(r.id), /failed: speaker gone/)
})

test('add rejects a routine with nothing to say or do', () => {
  const { engine } = setup()
  assert.throws(() => engine.add({ name: 'x', kind: 'say', text: ' ', trigger: triggerFromArgs({ time: '9:00' }) }), /needs/)
  assert.throws(() => engine.add({ name: 'x', kind: 'dance', text: 'hi', trigger: triggerFromArgs({ time: '9:00' }) }), /kind/)
})

/** A host with one face: a prompt makes it busy until the test frees it. */
function oneFaceHost(host) {
  host.prompt = (text) => {
    if (!host.isReady) throw new Error('no face is free to take the turn')
    host.isReady = false
    host.prompted.push(text)
  }
  return host
}

test('two prompt routines due together run one after the other, not one failed', () => {
  const { clock, host, engine } = setup()
  oneFaceHost(host)
  const a = engine.add({ name: 'a', kind: 'prompt', text: 'A.', trigger: triggerFromArgs({ time: '08:10' }) })
  const b = engine.add({ name: 'b', kind: 'prompt', text: 'B.', trigger: triggerFromArgs({ time: '08:10' }) })
  clock.t = at(2026, 11, 23, 8, 10).getTime()
  engine.tick()
  assert.equal(host.prompted.length, 1)
  assert.equal(engine.get(b.id).lastResult, '')
  host.isReady = true
  clock.t += MIN
  engine.tick()
  assert.equal(host.prompted.length, 2)
  assert.equal(engine.get(a.id).lastResult, 'ran')
  assert.equal(engine.get(b.id).lastResult, 'ran')
})

test('two startup routines both run when the face frees up', () => {
  const { host, engine } = setup()
  oneFaceHost(host)
  engine.add({ name: 'a', kind: 'prompt', text: 'A.', trigger: triggerFromArgs({ on: 'startup' }) })
  engine.add({ name: 'b', kind: 'prompt', text: 'B.', trigger: triggerFromArgs({ on: 'startup' }) })
  engine.started()
  engine.tick()
  host.isReady = true
  engine.tick()
  assert.equal(host.prompted.length, 2)
})

test('a startup routine added mid-session waits for the next start', () => {
  const { host, engine } = setup()
  engine.started()
  engine.add({ name: 'hello', kind: 'say', text: 'Hi.', trigger: triggerFromArgs({ on: 'startup' }) })
  engine.tick()
  assert.deepEqual(host.said, [])
})

test('a fired routine is moved on before anything else, so it never repeats on the next tick', () => {
  const { clock, host, file, engine } = setup()
  const r = engine.add({ name: 'x', kind: 'say', text: 'Once.', trigger: triggerFromArgs({ time: '08:10' }) })
  clock.t = at(2026, 11, 23, 8, 10).getTime()
  engine.tick()
  engine.tick()
  assert.deepEqual(host.said, ['Once.'])
  assert.equal(engine.get(r.id).next, at(2026, 11, 24, 8, 10).getTime())
  assert.ok(readFileSync(file, 'utf8').includes(r.id))
})

test('a notification that throws does not stop the routine moving on', () => {
  const { clock, host, engine } = setup()
  host.isConnected = false
  host.notify = () => {
    throw new Error('osascript missing')
  }
  const r = engine.add({ name: 'x', kind: 'say', text: 'Hi.', trigger: triggerFromArgs({ time: '08:10' }) })
  clock.t = at(2026, 11, 23, 8, 10).getTime()
  engine.tick()
  assert.equal(engine.get(r.id).next, at(2026, 11, 24, 8, 10).getTime())
  assert.match(engine.get(r.id).lastResult, /failed: osascript missing/)
})

test('an interval window that wraps past midnight is refused clearly', () => {
  assert.throws(() => triggerFromArgs({ every_minutes: 30, between: '22:00-02:00' }), /start before it ends/)
})

test('routine tools are allowed in read-only mode', () => {
  assert.equal(decideTool('mcp__jarvis_skills__routine_add'), true)
  assert.equal(decideTool('mcp__jarvis_skills__routine_remove'), true)
})
