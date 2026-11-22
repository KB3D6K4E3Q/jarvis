import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  nudge,
  follow,
  stages,
  cameraZ,
  ownsWheel,
  revealWords,
  scramble,
  CAMERA_HOME_Z,
} from '../src/lib/dive.ts'

test('a wheel tick moves the dive target forward and back', () => {
  const forward = nudge(0, 240, 0)
  assert.ok(forward > 0 && forward < 0.2)
  assert.equal(nudge(forward, -240, 0), 0)
})

test('the dive target is clamped to 0..1', () => {
  assert.equal(nudge(0, -5000, 0), 0)
  assert.equal(nudge(0.9, 99999, 0), 1)
})

test('line and page wheel modes are scaled to pixels', () => {
  assert.ok(nudge(0, 3, 1) > nudge(0, 3, 0))
  assert.ok(nudge(0, 1, 2) > nudge(0, 3, 1))
})

test('non-finite wheel deltas leave the target alone', () => {
  assert.equal(nudge(0.4, Number.NaN, 0), 0.4)
  assert.equal(nudge(0.4, Number.POSITIVE_INFINITY, 0), 0.4)
})

test('follow glides toward the target without overshooting', () => {
  const step = follow(0, 1, 1 / 60)
  assert.ok(step > 0 && step < 0.2)
  assert.ok(follow(0, 1, 10) <= 1)
  assert.equal(follow(0.5, 0.5, 1 / 60), 0.5)
})

test('stages are all zero at rest and all one at full depth', () => {
  assert.deepEqual(stages(0), { rings: 0, coreFade: 0, stars: 0, through: 0 })
  assert.deepEqual(stages(1), { rings: 1, coreFade: 1, stars: 1, through: 1 })
})

test('rings form before the camera passes through them', () => {
  const mid = stages(0.5)
  assert.ok(mid.rings > 0.9)
  assert.ok(mid.through < 0.05)
})

test('camera starts at home and moves steadily inward', () => {
  assert.equal(cameraZ(0), CAMERA_HOME_Z)
  assert.ok(cameraZ(0.5) < cameraZ(0.25))
  assert.ok(cameraZ(1) < cameraZ(0.5))
  assert.ok(cameraZ(1) > 0)
})

const node = (overflowY, scrollTop, scrollHeight, clientHeight, parentElement = null) => ({
  overflowY,
  scrollTop,
  scrollHeight,
  clientHeight,
  parentElement,
})
const styleOf = (el) => ({ overflowY: el.overflowY })

test('a scrollable panel keeps the wheel while it can still scroll', () => {
  const panel = node('auto', 0, 1000, 300)
  const child = node('visible', 0, 20, 20, panel)
  assert.equal(ownsWheel(child, 100, styleOf), true)
})

test('a panel already at its end lets the wheel through to the dive', () => {
  const panel = node('auto', 700, 1000, 300)
  assert.equal(ownsWheel(panel, 100, styleOf), false)
  assert.equal(ownsWheel(panel, -100, styleOf), true)
})

test('plain elements never claim the wheel', () => {
  const box = node('hidden', 0, 1000, 300)
  assert.equal(ownsWheel(box, 100, styleOf), false)
  assert.equal(ownsWheel(null, 100, styleOf), false)
})

test('revealWords splits finished, decoding and pending words', () => {
  const r = revealWords('one two three four', 0.5)
  assert.deepEqual(r.shown, ['one', 'two'])
  assert.equal(r.current, 'three')
  assert.ok(r.currentProgress >= 0 && r.currentProgress < 1)
  assert.deepEqual(r.rest, ['four'])
})

test('revealWords shows everything at full progress and nothing at zero', () => {
  assert.deepEqual(revealWords('a b', 1).shown, ['a', 'b'])
  assert.equal(revealWords('a b', 1).current, null)
  assert.deepEqual(revealWords('a b', 0).shown, [])
  assert.deepEqual(revealWords('', 0.5), { shown: [], current: null, currentProgress: 0, rest: [] })
})

test('scramble keeps length and settles letters left to right', () => {
  assert.equal(scramble('RELAY', 0, 3).length, 5)
  assert.equal(scramble('RELAY', 1, 3), 'RELAY')
  assert.equal(scramble('RELAY', 0.6, 3).slice(0, 3), 'REL')
  assert.equal(scramble('RELAY', 0.4, 7), scramble('RELAY', 0.4, 7))
})
