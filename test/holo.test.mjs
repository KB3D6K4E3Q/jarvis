import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HOLO_PANELS,
  DEFAULT_OPEN,
  homePosition,
  keepOnScreen,
  togglePanel,
  bringToFront,
} from '../src/lib/holo.ts'

const VIEW = { w: 1440, h: 900 }

test('every panel has a home position inside the screen', () => {
  for (const id of Object.keys(HOLO_PANELS)) {
    const p = homePosition(id, VIEW)
    const { w, h } = HOLO_PANELS[id]
    assert.ok(p.x >= 0 && p.x + w <= VIEW.w, `${id} fits across`)
    assert.ok(p.y >= 0 && p.y + h <= VIEW.h, `${id} fits down`)
  }
})

test('the desk opens with the clock and the hologram', () => {
  assert.deepEqual([...DEFAULT_OPEN], ['clock', 'model'])
})

test('a panel dragged off the right edge is pulled back so its header stays reachable', () => {
  const p = keepOnScreen({ x: 5000, y: 100 }, { w: 300, h: 200 }, VIEW)
  assert.ok(p.x + 80 <= VIEW.w, 'at least a grab-width stays visible')
})

test('a panel dragged above the top is held below the top edge', () => {
  const p = keepOnScreen({ x: 100, y: -400 }, { w: 300, h: 200 }, VIEW)
  assert.equal(p.y, 0)
})

test('a panel dragged off the left edge keeps a grab-width on screen', () => {
  const p = keepOnScreen({ x: -1000, y: 100 }, { w: 300, h: 200 }, VIEW)
  assert.ok(p.x + 300 >= 80)
})

test('a panel inside the screen is left where it is', () => {
  assert.deepEqual(keepOnScreen({ x: 200, y: 150 }, { w: 300, h: 200 }, VIEW), { x: 200, y: 150 })
})

test('toggling opens a closed panel and closes an open one, without mutating', () => {
  const open = ['clock']
  const more = togglePanel(open, 'log')
  assert.deepEqual(more, ['clock', 'log'])
  assert.deepEqual(open, ['clock'], 'input untouched')
  assert.deepEqual(togglePanel(more, 'clock'), ['log'])
})

test('bringing a panel to the front moves it last, without mutating', () => {
  const order = ['clock', 'model', 'log']
  assert.deepEqual(bringToFront(order, 'clock'), ['model', 'log', 'clock'])
  assert.deepEqual(order, ['clock', 'model', 'log'])
})

test('bringing an unopened panel to the front changes nothing', () => {
  const order = ['clock']
  assert.equal(bringToFront(order, 'log'), order)
})

/* ---------------------------------------------------- big screens, two screens */

import { panelScale, pickSecondScreen } from '../src/lib/holo.ts'

test('panels keep their size on a laptop screen', () => {
  assert.equal(panelScale({ w: 1440, h: 900 }), 1)
})

test('panels grow on a large monitor so they read from the chair', () => {
  const s = panelScale({ w: 2560, h: 1440 })
  assert.ok(s > 1.4 && s <= 1.8, `scale ${s}`)
})

test('panels never shrink below their designed size', () => {
  assert.equal(panelScale({ w: 800, h: 600 }), 1)
})

const LAPTOP = { left: 0, top: 0, width: 1728, height: 1117, isPrimary: true }
const MONITOR = { left: -2560, top: -323, width: 2560, height: 1440, isPrimary: false }

test('the second screen is the one the window is not on', () => {
  assert.equal(pickSecondScreen([LAPTOP, MONITOR], LAPTOP), MONITOR)
  assert.equal(pickSecondScreen([LAPTOP, MONITOR], MONITOR), LAPTOP)
})

test('with three screens, the largest other one is chosen', () => {
  const small = { left: 1728, top: 0, width: 1024, height: 768, isPrimary: false }
  assert.equal(pickSecondScreen([LAPTOP, small, MONITOR], LAPTOP), MONITOR)
})

test('with only one screen there is no second screen', () => {
  assert.equal(pickSecondScreen([LAPTOP], LAPTOP), null)
})

test('the current screen is recognised by position, not object identity', () => {
  assert.equal(pickSecondScreen([LAPTOP, MONITOR], { ...LAPTOP }), MONITOR)
})

test('enlarged panels still open fully on screen', () => {
  const view = { w: 2560, h: 1440 }
  const scale = panelScale(view)
  for (const id of Object.keys(HOLO_PANELS)) {
    const p = homePosition(id, view, scale)
    assert.ok(p.x + HOLO_PANELS[id].w * scale <= view.w, `${id} fits across`)
    assert.ok(p.y + HOLO_PANELS[id].h * scale <= view.h, `${id} fits down`)
  }
})

/* ------------------------------------------------- the mirror and the cursor */

import { mirrorBox } from '../src/lib/holo.ts'

const REACH = { x: 0.1, top: 0.08, bottom: 0.16 }

/** Where hand tracking puts a camera point on screen (lib/hands.ts). */
const cursorAt = (m, view) => ({
  x: ((1 - m.x - REACH.x) / (1 - 2 * REACH.x)) * view.w,
  y: ((m.y - REACH.top) / (1 - REACH.top - REACH.bottom)) * view.h,
})

/** Where the mirrored video draws that same camera point. */
const mirrorAt = (m, box) => ({
  x: box.left + (1 - m.x) * box.width,
  y: box.top + m.y * box.height,
})

for (const view of [{ w: 2560, h: 1440 }, { w: 1728, h: 1117 }, { w: 1440, h: 900 }]) {
  test(`your fingertip in the mirror is under the hand cursor at ${view.w}x${view.h}`, () => {
    const box = mirrorBox(view, REACH)
    for (const m of [{ x: 0.5, y: 0.5 }, { x: 0.1, y: 0.08 }, { x: 0.9, y: 0.84 }, { x: 0.3, y: 0.7 }]) {
      const want = cursorAt(m, view)
      const got = mirrorAt(m, box)
      assert.ok(Math.abs(got.x - want.x) < 0.5 && Math.abs(got.y - want.y) < 0.5, JSON.stringify({ m, want, got }))
    }
  })
}
