/**
 * The scroll dive: the wheel or trackpad flies the camera into the reactor.
 *
 * JARVIS has no page to scroll, so scrolling drives one number instead — how
 * deep into the scene the camera has gone. At 0 the reactor sits where it
 * always has. Scrolling in, the dust gathers into orbit rings around the core,
 * then the camera passes through them into an open starfield, and the last
 * reply decodes one word at a time on the way.
 *
 * Everything in this file is pure apart from `dive`, the one shared value the
 * input handler writes and the scene and caption read every frame. It lives
 * outside React for the same reason the scene's Drive object does: it changes
 * sixty times a second and nothing about it should cause a render.
 */

/** Where the camera sits with no dive at all. Matches the Canvas camera. */
export const CAMERA_HOME_Z = 6.2
/** Where the camera holds while the rings form, framing the whole cage. */
const CAMERA_RINGS_Z = 4.9
/** Deepest point of the dive: past the rings, just short of the core plane. */
export const CAMERA_DEEP_Z = 1.4
/** Depth by which the rings have formed and the fly-through begins. */
const RINGS_DONE = 0.5
/** Wheel distance, in pixels, from resting to fully dived. */
const WHEEL_RANGE_PX = 2400
/** Pixels per wheel unit, by WheelEvent.deltaMode (pixel, line, page). */
const DELTA_MODE_PX = [1, 16, 800] as const
/** How quickly the dive catches up with the wheel. Higher is snappier. */
const FOLLOW_RATE = 3.2

/** Written by the wheel handler, eased toward by the scene. */
export const dive = { target: 0, depth: 0 }

export type DiveStages = {
  /** 0..1 — the dust has gathered into orbit rings. */
  rings: number
  /** 0..1 — the core has faded so the camera can pass it. */
  coreFade: number
  /** 0..1 — the starfield around the reactor. */
  stars: number
  /** 0..1 — the rings have widened out past the camera. */
  through: number
}

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** The dive target after one wheel event. */
export function nudge(target: number, deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return target
  const px = deltaY * (DELTA_MODE_PX[deltaMode] ?? 1)
  return clamp01(target + px / WHEEL_RANGE_PX)
}

/** Frame-rate independent glide from `current` toward `target`. */
export function follow(current: number, target: number, dt: number): number {
  if (current === target) return current
  return current + (target - current) * (1 - Math.exp(-dt * FOLLOW_RATE))
}

/** How far along each part of the dive is, at a given depth. */
export function stages(depth: number): DiveStages {
  const d = clamp01(depth)
  return {
    rings: smoothstep(0.04, 0.45, d),
    coreFade: smoothstep(0.2, 0.5, d),
    stars: smoothstep(0.3, 0.9, d),
    through: smoothstep(RINGS_DONE, 1, d),
  }
}

/**
 * Camera distance from the core at a given depth: a short approach while the
 * rings form, holding them all in frame, then the long push through them.
 */
export function cameraZ(depth: number): number {
  const d = clamp01(depth)
  if (d <= RINGS_DONE) {
    return CAMERA_HOME_Z + (CAMERA_RINGS_Z - CAMERA_HOME_Z) * smoothstep(0, RINGS_DONE, d)
  }
  return CAMERA_RINGS_Z + (CAMERA_DEEP_Z - CAMERA_RINGS_Z) * smoothstep(RINGS_DONE, 1, d)
}

/** The parts of an element the wheel test needs. Structural, so tests can fake it. */
export type Scrollish = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  parentElement: Scrollish | null
}

const SCROLLABLE = new Set(['auto', 'scroll', 'overlay'])

/**
 * Whether some panel under the pointer will use this wheel event itself.
 *
 * Blades and the diagnostics sheet scroll their own content. A wheel over one
 * of them scrolls it, and only once it has hit its end does the wheel go on to
 * the dive — the same handoff a nested scroller has on any web page.
 */
export function ownsWheel(
  el: Scrollish | null,
  deltaY: number,
  styleOf: (el: Scrollish) => { overflowY: string },
): boolean {
  for (let node = el; node; node = node.parentElement) {
    if (!SCROLLABLE.has(styleOf(node).overflowY)) continue
    if (node.scrollHeight <= node.clientHeight + 1) continue
    const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1
    if (deltaY > 0 && !atEnd) return true
    if (deltaY < 0 && node.scrollTop > 0) return true
  }
  return false
}

export type Reveal = {
  shown: string[]
  /** The word currently decoding, or null once every word is in. */
  current: string | null
  /** 0..1 through the decoding word. */
  currentProgress: number
  rest: string[]
}

/** Splits text into the words already decoded, the one decoding, and the rest. */
export function revealWords(text: string, progress: number): Reveal {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return { shown: [], current: null, currentProgress: 0, rest: [] }
  const pos = clamp01(progress) * words.length
  const index = Math.floor(pos)
  if (index >= words.length) return { shown: words, current: null, currentProgress: 0, rest: [] }
  return {
    shown: words.slice(0, index),
    current: words[index],
    currentProgress: pos - index,
    rest: words.slice(index + 1),
  }
}

const GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&*+=<>/\\'

/**
 * A word part-way through decoding: settled letters from the left, cycling
 * glyphs for the rest. `tick` picks the glyphs, so the same tick always gives
 * the same string and the noise only moves when the caller advances it.
 */
export function scramble(word: string, amount: number, tick: number): string {
  const settled = Math.floor(clamp01(amount) * word.length)
  let out = word.slice(0, settled)
  for (let i = settled; i < word.length; i++) {
    const h = Math.abs(Math.imul(i + 1, 2654435761) ^ Math.imul(tick + 7, 40503))
    out += GLYPHS[h % GLYPHS.length]
  }
  return out
}
