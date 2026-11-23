import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { OneEuroPoint } from './oneEuro'
import { holdCamera, releaseCamera } from './camera'

/**
 * Hands.
 *
 * Your hand appears on screen as a skeleton — every joint, every finger — and
 * the tip of your index finger is the cursor. Pinch thumb to finger to press.
 *
 * Drawing the whole hand rather than a floating dot is not decoration. You
 * cannot see your own hand against the screen, so with only a dot you are
 * aiming something whose orientation and shape you have to infer. With the
 * skeleton you can see the pinch closing before it fires, see which finger the
 * cursor is riding on, and see immediately when tracking has lost you rather
 * than wondering why nothing responds.
 *
 * The architectural decision is that nothing here knows what a blade is. No
 * hit-testing of blades, no calls to close or move them, no knowledge of the
 * header you drag by. It turns a hand into a position and a press and
 * dispatches ordinary PointerEvents there — so every interaction the mouse
 * already has works with a hand for free, and anything added later works
 * without being taught that hands exist.
 *
 * The camera is off until you ask for it, says so on screen the whole time it
 * is on, and nothing leaves the machine: the model runs locally on the GPU and
 * frames are read and discarded.
 */

/**
 * Served from our own origin, copied out of node_modules by scripts/start.mjs.
 *
 * Not a CDN, for two reasons that both bite. The runtime arrives as a script
 * and the page's CSP names no CDN in `script-src` — so a CDN path is simply
 * blocked, and the symptom is gesture control that never starts with nothing
 * obviously wrong. And a CDN import is a live supply-chain dependency:
 * executable code, re-resolved every load, that we neither control nor can pin
 * against being changed underneath us.
 */
const WASM_BASE = '/mediapipe'

/**
 * The weights stay remote, and that is a different call from the runtime above.
 * This is data, not code: it is fetched, so `connect-src` governs it rather
 * than `script-src`, and nothing in it executes. The browser caches it after
 * first use, exactly as the neural voice model is handled.
 */
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

/* ------------------------------------------------------------------ anatomy */

export const WRIST = 0
const THUMB_MCP = 2
export const THUMB_TIP = 4
const INDEX_PIP = 6
export const INDEX_TIP = 8
const MIDDLE_MCP = 9
const MIDDLE_PIP = 10
const MIDDLE_TIP = 12
const RING_PIP = 14
const RING_TIP = 16
const PINKY_PIP = 18
const PINKY_TIP = 20

/**
 * The skeleton, as pairs of landmark indices.
 *
 * Written out rather than taken from HandLandmarker.HAND_CONNECTIONS so the
 * renderer does not depend on a static that the library is free to reshape, and
 * so the palm arch below reads as a deliberate choice.
 */
export const BONES: readonly [number, number][] = [
  // thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // middle
  [9, 10], [10, 11], [11, 12],
  // ring
  [13, 14], [14, 15], [15, 16],
  // pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // the arch across the knuckles, which is what makes it read as a hand
  // rather than as five separate sticks
  [5, 9], [9, 13], [13, 17],
]

export const TIPS = [THUMB_TIP, INDEX_TIP, MIDDLE_TIP, RING_TIP, PINKY_TIP]

/* -------------------------------------------------------------------- tuning */

/**
 * 1€ filter constants, tuned by the published method: beta at zero, drop
 * minCutoff until a resting hand stops shivering, then raise beta until a fast
 * movement stops trailing.
 *
 * The cursor is filtered harder than the skeleton. Aiming is a precision task
 * and benefits from every bit of steadiness; the skeleton is a picture of your
 * hand and only has to look alive, so it is allowed to be looser and more
 * responsive. Filtering both identically made the drawing feel dead.
 */
/**
 * The cursor is filtered once, from the raw fingertip. It used to be filtered
 * from the already-smoothed skeleton, i.e. twice in series, and two low-passes
 * in a row add their lags together: that was most of why the cursor trailed
 * the hand. One filter, a slightly lower floor for a steadier rest, and a
 * higher beta so it opens up sooner once the hand moves.
 */
const CURSOR_MIN_CUTOFF = 0.85
const CURSOR_BETA = 0.022
const SKELETON_MIN_CUTOFF = 2.4
const SKELETON_BETA = 0.02

/**
 * How much of the camera's view maps onto the screen.
 *
 * A hand at the very edge of the frame is half out of it, and MediaPipe loses
 * hands that are half out of frame. Mapping the whole frame to the whole
 * screen therefore put the screen's edges exactly where tracking fails: the
 * close button in a corner was the hardest thing on screen to reach. Mapping
 * the middle of the view instead puts every edge of the screen comfortably
 * inside the frame, and means less arm travel to cross it. The bottom margin
 * is the largest because that is where the wrist leaves the picture first.
 */
const REACH_X = 0.1
const REACH_TOP = 0.08
const REACH_BOTTOM = 0.16
/** The same margins, for anything that draws the camera picture (the holo desk). */
export const REACH = { x: REACH_X, top: REACH_TOP, bottom: REACH_BOTTOM } as const

/**
 * Pinch thresholds, as a fraction of hand span rather than an absolute.
 *
 * The raw gap between two fingertips is meaningless alone: it halves when you
 * lean back and doubles when you lean in, so a fixed threshold means the
 * interface only works at one distance from the camera. Dividing by the span
 * from wrist to middle knuckle — a length that shrinks with the same
 * perspective — makes it a property of the hand's shape rather than its
 * distance, which is what a pinch actually is.
 *
 * Two thresholds, not one: it takes a tighter pinch to start a press than to
 * keep one, so the press cannot flicker on the boundary.
 */
const PINCH_ON = 0.40
const PINCH_OFF = 0.60

/**
 * The same thresholds, measured in 3D.
 *
 * MediaPipe also reports every joint in metres, in a frame centred on the
 * hand. Distances there do not foreshorten: a hand turned edge-on to the
 * camera, or pointing at it, has the same 3D proportions as one held flat,
 * where the 2D picture of it squashes. In 2D that squash was the main source
 * of misreads — a straight finger pointing at the lens looks short, so reads
 * as curled, and a palm turned sideways shrinks the span the pinch is divided
 * by, so a relaxed hand reads as pinching. 3D is used whenever it is present.
 */
const PINCH_ON_3D = 0.36
/** Wide hysteresis: once you have hold of something, a pinch that loosens
 *  slightly while you carry it must not drop it. */
const PINCH_OFF_3D = 0.6
/**
 * In a pinch the index fingertip is out in front of the palm, meeting the
 * thumb. In a fist it is tucked against the palm — with the thumb lying next
 * to it, which is why fists used to read as pinches. Closer to the middle
 * knuckle than this fraction of the palm, it is a fist, not a pinch.
 */
const TUCKED = 0.34

/**
 * A pinch must be apart this long before it lets go. A carried pinch loosens
 * for a frame or two as the hand moves — motion blur, a finger briefly
 * occluded — and each of those used to drop the blade mid-drag.
 */
const RELEASE_CONFIRM_MS = 70

/** A hand that has just appeared cannot press for this long. Hands enter the
 *  frame mid-gesture, and the first frames of a hand are the least reliable. */
const ENTRY_GRACE_MS = 350

/** A pinch cannot START while the hand moves faster than this, in screen
 *  widths per second. A swipe or a hand dropping out of the way passes through
 *  pinch-like shapes at speed; nobody aims a press at that speed. */
const FAST_HAND = 1.1

/** A finger counts as extended when its tip is this much further from the
 *  wrist than its middle joint. Ratio rather than a y-comparison, so it still
 *  works with your hand rotated or upside down. */
const EXTEND_RATIO = 1.12

/**
 * A gesture must hold for this long before it counts.
 *
 * Fingers pass through other shapes on the way to the one you meant — a fist
 * becomes a point by way of several ambiguous frames — and acting on those
 * intermediate readings is what makes gesture interfaces feel possessed.
 */
const GESTURE_HOLD_MS = 200

/**
 * A pinch has to survive this long before it presses.
 *
 * Pinch used to be exempt from any hold at all, on the reasoning that a press
 * is the one gesture where latency is felt. True, but it made every transition
 * between poses a hazard: going from a framing L to a point, or from a fist to
 * an open hand, takes the fingers through arrangements that momentarily read as
 * a pinch. Each of those fired a press — grabbing a blade you were not touching
 * and dropping it somewhere you did not choose.
 *
 * Seventy milliseconds is four frames. It is comfortably below the threshold at
 * which a press feels delayed, and comfortably above the one or two frames a
 * hand spends passing through a shape on its way to another one.
 */
const PINCH_CONFIRM_MS = 70

/**
 * After the finger pose changes, presses are ignored for this long.
 *
 * The confirm window above catches a pinch that flickers. This catches the
 * other half of the problem: a pose that genuinely settles into something
 * pinch-shaped for a moment while the hand is still rearranging itself. Both
 * are needed, because they fail in opposite directions.
 */
const POSE_SETTLE_MS = 220

/** Below this many pixels of travel, a press was a click rather than a drag.
 *  A hand holding a pinch drifts more than a mouse does, so a little more room. */
const CLICK_SLOP = 30

/**
 * How far back a press aims.
 *
 * A pinch takes about this long from "hand open, pointing at the thing" to
 * "fingers touching", and the fingertip travels several centimetres over that
 * time — so the position at the instant the press fires is not the position you
 * aimed from. The trail below keeps a short history and the press hit-tests
 * where the cursor was this long ago.
 */
const AIM_LAG_MS = 190
/** Nothing older than this is kept; two frames' worth of slack over the lag. */
const TRAIL_MS = 500

export type Gesture =
  | 'point' | 'pinch' | 'frame' | 'open' | 'fist' | 'peace'
  | 'thumbs-up' | 'thumbs-down' | 'none'
export type Side = 'left' | 'right'

/**
 * Whether MediaPipe's handedness label needs inverting.
 *
 * False, because that is what the screen actually showed. The older Hands docs
 * note that handedness assumes a mirrored selfie image and should be swapped if
 * your input is not mirrored — we feed the raw camera frame, so a swap looked
 * right on paper and named every hand backwards in practice. This build of the
 * Tasks API already reports the real hand.
 *
 * A constant rather than a hardcoded expression so that a different build, or a
 * genuinely pre-mirrored input, is a one-word change.
 */
const SWAP_HANDEDNESS = false

/**
 * Which tracked hand a detection belongs to.
 *
 * Handedness alone is not enough to key on, and using it that way caused the
 * worst bug in this file. The classifier is confident but not stable: it
 * mislabels a hand for a frame or two fairly often, especially while the hand
 * is rotating or half out of frame. Keyed purely on the label, that single
 * frame moves the hand into the other slot — which drops the old slot, fires
 * pointercancel, and silently ends whatever was being dragged. The symptom is
 * a drag that works once and then refuses to start again.
 *
 * So identity comes from continuity first: a detection belongs to whichever
 * tracked hand was nearest last frame. Your hand cannot teleport across the
 * screen between frames, but its label can flip, so position is the more
 * trustworthy signal by a wide margin. Handedness decides only where a hand
 * that is genuinely new goes.
 */
const MAX_JUMP_FRACTION = 0.28

/**
 * Ghost hands, two kinds, both borrowed from holo-gestures (MIT, Zubair
 * Trabzada): https://github.com/zubair-trabzada/holo-gestures
 *
 * A hand smaller than this (wrist to middle knuckle, as a fraction of the
 * camera frame) is a face, a poster or something far behind you that the model
 * has mistaken for a hand. A real hand within reach is several times bigger.
 */
const SPAN_MIN = 0.025
/**
 * And a second detection whose wrist lands this close to the first one's (same
 * units) is the model seeing one hand twice. Left in, it becomes a phantom
 * second pinch that turns every drag into a two-handed gesture.
 */
const TWIN_GAP = 0.04

function slotFor(
  side: Side,
  wrist: { x: number; y: number },
  taken: Set<number>,
  reach: number,
): number {
  let best = -1
  let bestDist = Infinity
  for (const h of hands) {
    if (taken.has(h.id) || !h.points?.[WRIST]) continue
    const d = Math.hypot(h.points[WRIST].x - wrist.x, h.points[WRIST].y - wrist.y)
    if (d < bestDist) {
      bestDist = d
      best = h.id
    }
  }
  if (best !== -1 && bestDist < reach * MAX_JUMP_FRACTION) return best

  // Genuinely new. Prefer the slot its handedness suggests.
  const want = side === 'right' ? 1 : 0
  if (!taken.has(want)) return want
  return want === 1 ? 0 : 1
}

/**
 * A running vote on which hand each slot is.
 *
 * The label is used for display and for the thumb geometry, so a single bad
 * frame renaming "LEFT" to "RIGHT" under the user's wrist is visible and
 * looks broken even when nothing else is wrong. A vote that decays makes the
 * label settle within a few frames and then stay put.
 */
const sideVote = new Map<number, number>()

function votedSide(id: number, saw: Side): Side {
  const prev = sideVote.get(id) ?? 0
  // Clamped so a long run of one label cannot make the other take a second to
  // win once the hand genuinely changes.
  const next = Math.max(-6, Math.min(6, prev + (saw === 'right' ? 1 : -1)))
  sideVote.set(id, next)
  return next >= 0 ? 'right' : 'left'
}

export type Hand = {
  /** Stable across frames: 0 is your left hand, 1 your right. See `slotFor`. */
  id: number
  /** Every joint, in viewport pixels, smoothed and mirrored. */
  points: { x: number; y: number }[]
  /** Cursor position — your index fingertip. */
  x: number
  y: number
  /** Where the cursor was before the fingers began closing, which is what a
   *  press is aimed at. See the note where it is set. */
  aimX: number
  aimY: number
  pinched: boolean
  /** 0..1, how closed the pinch is. Drives the reticle's tightening ring. */
  closeness: number
  gesture: Gesture
  fingers: { thumb: boolean; index: boolean; middle: boolean; ring: boolean; pinky: boolean }
  handedness: Side
  /** Rough hand size in pixels, so the renderer can scale line weight to it. */
  span: number
}

/**
 * Live hands, mutated in place.
 *
 * Deliberately not React state. This updates at camera rate and is consumed by
 * a canvas that redraws itself; routing it through the store would re-render
 * the entire HUD sixty times a second to move some lines. Same reasoning as the
 * scene's Drive object.
 */
export const hands: Hand[] = []

export const diag = {
  enabled: false,
  loading: false,
  ready: false,
  count: 0,
  fps: 0,
  gesture: '' as string,
  lastError: '',
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__hands = diag
}

let landmarker: HandLandmarker | null = null
let video: HTMLVideoElement | null = null
let running = false
/** Bumped on every enable, so a loop from a previous session stops itself. */
let generation = 0
let frames = 0
let fpsAt = 0
/** detectForVideo rejects a timestamp that does not advance, and performance.now()
 *  restarts its relationship with the model on every enable. Keep our own. */
let stamp = 0

/* ------------------------------------------------------------------ filters */

type Filters = {
  cursor: OneEuroPoint
  joints: OneEuroPoint[]
}

const filters = new Map<number, Filters>()

/** Recent cursor positions per hand, so a press can aim from before the pinch. */
const trails = new Map<number, { x: number; y: number; at: number }[]>()
/** When the fingers first closed, per hand — see PINCH_CONFIRM_MS. */
const pinchSince = new Map<number, number>()
/** When the finger pose last changed, per hand — see POSE_SETTLE_MS. */
const poseChangedAt = new Map<number, number>()
/** When a held pinch first came apart, per hand — see RELEASE_CONFIRM_MS. */
const releaseSince = new Map<number, number>()

function filtersFor(id: number): Filters {
  let f = filters.get(id)
  if (!f) {
    f = {
      cursor: new OneEuroPoint(CURSOR_MIN_CUTOFF, CURSOR_BETA),
      joints: Array.from({ length: 21 }, () => new OneEuroPoint(SKELETON_MIN_CUTOFF, SKELETON_BETA)),
    }
    filters.set(id, f)
  }
  return f
}

/* ---------------------------------------------------------------- synthetics */

/**
 * setPointerCapture, made safe for pointers that do not exist.
 *
 * A synthetic PointerEvent carries a pointerId the browser has never issued, so
 * any element that calls setPointerCapture with it throws NotFoundError and the
 * interaction dies at the first move. That call is made by framer-motion's drag
 * and by our own resize grip — both of which we very much want a hand to be
 * able to use — and neither is somewhere we can add a try/catch.
 *
 * Capture is an optimisation, not a requirement: it exists so a drag keeps
 * receiving events after the cursor leaves the element. Our events are aimed by
 * hit-testing every frame and routed to the element that took the press, so
 * they land correctly whether or not capture was granted.
 */
let patched = false
function patchPointerCapture() {
  if (patched || typeof Element === 'undefined') return
  patched = true
  const capture = Element.prototype.setPointerCapture
  const release = Element.prototype.releasePointerCapture
  Element.prototype.setPointerCapture = function (id: number) {
    try {
      return capture.call(this, id)
    } catch {
      /* a synthetic pointer; hit-testing covers what capture would have */
    }
  }
  Element.prototype.releasePointerCapture = function (id: number) {
    try {
      return release.call(this, id)
    } catch {
      /* as above */
    }
  }
}

type Press = {
  /** What took the press, so the release and any click agree on their target. */
  captured: Element | null
  wasPinched: boolean
  /** Where the press was aimed. */
  downX: number
  downY: number
  /** Where the cursor actually was when it fired — what travel is measured
   *  from. Not the aim point: that is where the finger was before it closed,
   *  so measuring from it counted the closing itself as movement, and most
   *  clicks were thrown away as drags. */
  atX: number
  atY: number
}

const presses = new Map<number, Press>()

function fire(
  el: Element | null,
  type: string,
  h: Hand,
  pressed: boolean,
  /** Defaults to the live cursor; the press passes its latched aim point. */
  at?: { x: number; y: number },
) {
  if (!el) return
  const px = at?.x ?? h.x
  const py = at?.y ?? h.y
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: px,
      clientY: py,
      // Well clear of any id the browser might issue for a real pointer.
      pointerId: 9000 + h.id,
      pointerType: 'touch',
      isPrimary: h.id === 0,
      button: 0,
      buttons: pressed ? 1 : 0,
      width: 1,
      height: 1,
      pressure: pressed ? 0.5 : 0,
    }),
  )
}

function emit(h: Hand) {
  let p = presses.get(h.id)
  if (!p) {
    p = { captured: null, wasPinched: false, downX: h.x, downY: h.y, atX: h.x, atY: h.y }
    presses.set(h.id, p)
  }

  const over = document.elementFromPoint(h.x, h.y)

  if (h.pinched && !p.wasPinched) {
    /**
     * Press, aimed from where the hand was before the fingers closed.
     *
     * The fingertip travels several centimetres on its way to meeting the
     * thumb — that is what a pinch is — so the position at the instant the
     * press fires is not the position you were aiming from. Hit-testing the
     * live point made a press land below whatever you had pointed at, which is
     * why grabbing a title bar worked only when you happened to pinch straight
     * down onto it.
     */
    const aim = { x: h.aimX, y: h.aimY }
    const target = document.elementFromPoint(aim.x, aim.y) ?? over
    p.captured = target
    p.downX = aim.x
    p.downY = aim.y
    p.atX = h.x
    p.atY = h.y
    fire(target, 'pointerdown', h, true, aim)
  } else if (!h.pinched && p.wasPinched) {
    const target = p.captured ?? over
    fire(target, 'pointerup', h, false)
    // Only a press that ends roughly where it began is a click. One that
    // travelled was a drag, and a drag that also clicked would close the very
    // blade it had just finished moving.
    // The click goes to whatever took the press. It used to also demand the
    // same element still be under the cursor on release, and a cursor that
    // drifts a few pixels off a small button lost the click for no reason.
    const travelled = Math.hypot(h.x - p.atX, h.y - p.atY)
    if (target && travelled < CLICK_SLOP) {
      target.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: p.downX,
          clientY: p.downY,
        }),
      )
      /**
       * An iframe is another document, and usually another site: a click
       * dispatched at the element never reaches what is inside it, and the
       * browser rightly allows nothing that would. So say that it was tapped,
       * and where; whatever put the frame there may know how to talk to it —
       * a video player has a command for play.
       */
      if (target.tagName === 'IFRAME') {
        const r = target.getBoundingClientRect()
        target.dispatchEvent(
          new CustomEvent('hand-tap', {
            bubbles: true,
            detail: { x: p.downX - r.left, y: p.downY - r.top },
          }),
        )
      }
    }
    p.captured = null
  } else {
    // While pressed, moves go to whatever took the press, so a drag survives
    // the cursor sliding off the header it grabbed.
    fire(h.pinched ? (p.captured ?? over) : over, 'pointermove', h, h.pinched)
  }

  p.wasPinched = h.pinched
}

/** Let go of anything still held. A press that outlives its hand leaves
 *  whatever was being dragged stuck to a cursor that no longer exists. */
function releasePress(id: number, at: { x: number; y: number }) {
  const p = presses.get(id)
  if (!p?.wasPinched) return
  const ghost = { id, x: at.x, y: at.y } as Hand
  fire(p.captured, 'pointerup', ghost, false)
  fire(p.captured, 'pointercancel', ghost, false)
  p.wasPinched = false
  p.captured = null
}

/* ------------------------------------------------------------------ geometry */

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y)

/*
 * Is a finger extended? Distance from the wrist, not height on screen: the
 * y-comparison is the common recipe and it is wrong the moment the hand is not
 * upright — turn your hand sideways and every finger reads as curled. Distance
 * from the wrist is rotation-invariant, which is the property the question
 * actually needs. Done inline in the loop now, in 3D where it can be.
 */

/**
 * Only report a finger pose once it has held.
 *
 * Fingers pass through other shapes on the way to the one you meant: a fist
 * opening into a point spends several frames looking like a pinch, and a hand
 * relaxing looks briefly like every gesture in the list. Acting on those
 * intermediate readings is exactly what makes gesture interfaces feel
 * possessed, so a pose has to survive GESTURE_HOLD_MS before it is believed.
 *
 * A pinch is deliberately exempt. It already carries its own hysteresis, and
 * it is the one gesture where the delay would be felt directly — as a press
 * that lands late.
 */
const settling = new Map<number, { raw: Gesture; since: number; held: Gesture }>()

function stableGesture(id: number, raw: Gesture, now: number): Gesture {
  if (raw === 'pinch') {
    settling.set(id, { raw, since: now, held: raw })
    return raw
  }
  const s = settling.get(id)
  if (!s || s.raw !== raw) {
    settling.set(id, { raw, since: now, held: s?.held === 'pinch' ? 'none' : (s?.held ?? 'none') })
    return settling.get(id)!.held
  }
  if (now - s.since >= GESTURE_HOLD_MS) s.held = raw
  return s.held
}

function classify(
  fingers: Hand['fingers'],
  pinched: boolean,
  /** How far the thumb tip sits above its base, in hand spans; negative is below. */
  thumbRise = 0,
): Gesture {
  if (pinched) return 'pinch'
  const { thumb, index, middle, ring, pinky } = fingers
  /**
   * Thumbs up and down: the thumb out, every finger curled, and the thumb
   * clearly pointing up or down the screen. Sideways is neither — a fist with
   * the thumb resting along it is the commonest accidental version, and it
   * points sideways.
   */
  if (thumb && !index && !middle && !ring && !pinky) {
    if (thumbRise > 0.55) return 'thumbs-up'
    if (thumbRise < -0.55) return 'thumbs-down'
  }
  const up = [thumb, index, middle, ring, pinky].filter(Boolean).length
  if (index && middle && !ring && !pinky) return 'peace'
  /**
   * The framing pose — index up, thumb out, the rest curled. The corner of a
   * rectangle, the shape people already make when they mime framing a shot.
   *
   * Tested before `point`, and it has to be: a framing hand also has exactly
   * one finger extended, so the point rule would swallow it. The thumb is the
   * whole difference between "I am aiming at that" and "I am sizing this".
   */
  if (thumb && index && !middle && !ring && !pinky) return 'frame'
  if (index && !middle && !ring && !pinky) return 'point'
  if (up >= 4) return 'open'
  if (up === 0) return 'fist'
  return 'none'
}

/* ------------------------------------------------------------ whole gestures */

/**
 * Swipes and holds are published as window events rather than acted on here,
 * for the same reason presses are PointerEvents: this file knows hands, not
 * blades or conversations. `hand-swipe` carries where it started and which
 * way it went; `hand-hold` says a pose was held on purpose. What they mean is
 * decided by whoever listens.
 */
export type SwipeDetail = { dir: 'left' | 'right'; x: number; y: number; hand: number }
export type HoldGesture = 'thumbs-up' | 'thumbs-down' | 'palm'
export type HoldDetail = { gesture: HoldGesture; hand: number; x: number; y: number }

/** A swipe: an open hand crossing this fraction of the screen... */
const SWIPE_MIN = 0.2
/** ...within this long. Slower than that is moving your hand, not swiping. */
const SWIPE_WINDOW_MS = 320
const SWIPE_COOLDOWN_MS = 800

const sweeps = new Map<number, { x: number; y: number; at: number }[]>()
const swipeQuiet = new Map<number, number>()

function detectSwipe(h: Hand, open: boolean, now: number) {
  // Measured at the palm, which a swipe carries cleanly; fingertips flap.
  const p = h.points[MIDDLE_MCP]
  if (!open || h.pinched || !p) {
    sweeps.delete(h.id)
    return
  }
  const hist = sweeps.get(h.id) ?? []
  hist.push({ x: p.x, y: p.y, at: now })
  while (hist.length > 1 && now - hist[0].at > SWIPE_WINDOW_MS) hist.shift()
  sweeps.set(h.id, hist)
  if (now < (swipeQuiet.get(h.id) ?? 0)) return
  const first = hist[0]
  const dx = p.x - first.x
  const dy = p.y - first.y
  if (Math.abs(dx) > window.innerWidth * SWIPE_MIN && Math.abs(dy) < Math.abs(dx) * 0.6) {
    swipeQuiet.set(h.id, now + SWIPE_COOLDOWN_MS)
    sweeps.delete(h.id)
    // A swipe is an open hand in motion; it must not also count as a held palm.
    holds.delete(h.id)
    const detail: SwipeDetail = { dir: dx > 0 ? 'right' : 'left', x: first.x, y: first.y, hand: h.id }
    window.dispatchEvent(new CustomEvent('hand-swipe', { detail }))
  }
}

/** How long a pose must be held, on top of the gesture's own settling. */
const HOLD_MS: Record<HoldGesture, number> = { 'thumbs-up': 450, 'thumbs-down': 450, palm: 550 }
/** A hold is a hand kept still; drifting further than this restarts it. */
const HOLD_DRIFT = 0.045

const holds = new Map<number, { g: HoldGesture; since: number; fired: boolean; x: number; y: number }>()

function detectHold(h: Hand, now: number) {
  const g: HoldGesture | null =
    h.gesture === 'open' ? 'palm'
    : h.gesture === 'thumbs-up' || h.gesture === 'thumbs-down' ? h.gesture
    : null
  const p = h.points[MIDDLE_MCP]
  if (!g || !p) {
    holds.delete(h.id)
    return
  }
  const c = holds.get(h.id)
  if (!c || c.g !== g || Math.hypot(p.x - c.x, p.y - c.y) > window.innerWidth * HOLD_DRIFT) {
    holds.set(h.id, { g, since: now, fired: false, x: p.x, y: p.y })
    return
  }
  if (!c.fired && now - c.since >= HOLD_MS[g]) {
    c.fired = true
    const detail: HoldDetail = { gesture: g, hand: h.id, x: p.x, y: p.y }
    window.dispatchEvent(new CustomEvent('hand-hold', { detail }))
  }
}

/**
 * How far along a hold is, for drawing it filling up. Thumbs only: an open
 * palm is also how you let go of things, and a ring filling under every open
 * hand would be noise. Its effect shows up where it lands instead.
 */
export function holdProgress(id: number): { gesture: HoldGesture; progress: number } | null {
  const c = holds.get(id)
  if (!c || c.fired || c.g === 'palm') return null
  return { gesture: c.g, progress: Math.min(1, (performance.now() - c.since) / HOLD_MS[c.g]) }
}

/* -------------------------------------------------------------------- camera */

async function ensureModel() {
  if (landmarker) return landmarker
  diag.loading = true
  try {
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
    landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    diag.ready = true
    return landmarker
  } catch (err) {
    // A machine with no working GPU delegate should still get hands rather than
    // an error — the CPU path is slower but perfectly usable at this frame size.
    diag.lastError = `GPU delegate failed (${(err as Error)?.message ?? err}); retrying on CPU`
    const vision = await FilesetResolver.forVisionTasks(WASM_BASE)
    landmarker = await HandLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
    })
    diag.ready = true
    return landmarker
  } finally {
    diag.loading = false
  }
}

function dropHand(i: number) {
  const at = hands.findIndex((h) => h.id === i)
  if (at === -1) return
  releasePress(i, hands[at])
  hands.splice(at, 1)
  filters.get(i)?.cursor.reset()
  filters.get(i)?.joints.forEach((f) => f.reset())
  settling.delete(i)
  sideVote.delete(i)
  trails.delete(i)
  pinchSince.delete(i)
  poseChangedAt.delete(i)
  sweeps.delete(i)
  holds.delete(i)
  releaseSince.delete(i)
}

/**
 * The tracking loop.
 *
 * Driven by requestVideoFrameCallback where it exists: rAF runs on the
 * display's clock and will happily hand the same camera frame to the model
 * several times, burning GPU on work whose answer cannot have changed. Falls
 * back to rAF on browsers that lack it, where the only cost is some wasted
 * inference.
 */
function loop(mine: number) {
  if (!running || mine !== generation || !video || !landmarker) return

  const now = performance.now()
  // Strictly increasing, and independent of performance.now(): the model
  // rejects a timestamp that does not advance, and enable/disable cycles would
  // otherwise hand it the same clock twice.
  stamp += 1

  let result
  try {
    result = landmarker.detectForVideo(video, stamp)
  } catch (err) {
    diag.lastError = String((err as Error)?.message ?? err)
    result = null
  }

  const w = window.innerWidth
  const h = window.innerHeight
  const found = result?.landmarks ?? []
  const labels = result?.handedness ?? []
  const world = result?.worldLandmarks ?? []
  /** Camera coordinates to screen pixels: mirrored, with the reach margins. */
  const toScreen = (m: { x: number; y: number }) => ({
    x: ((1 - m.x - REACH_X) / (1 - 2 * REACH_X)) * w,
    y: ((m.y - REACH_TOP) / (1 - REACH_TOP - REACH_BOTTOM)) * h,
  })
  diag.count = found.length
  const at = now / 1000

  const seen = new Set<number>()

  for (let k = 0; k < found.length && k < 2; k++) {
    const marks = found[k]
    if (!marks || marks.length < 21) continue
    if (Math.hypot(marks[WRIST].x - marks[MIDDLE_MCP].x, marks[WRIST].y - marks[MIDDLE_MCP].y) < SPAN_MIN) continue
    if (k > 0 && found[0]?.[WRIST] &&
        Math.hypot(marks[WRIST].x - found[0][WRIST].x, marks[WRIST].y - found[0][WRIST].y) < TWIN_GAP) continue

    /**
     * Which hand this is.
     *
     * This was inverted, and the inversion was reasoned rather than observed —
     * from the note in MediaPipe's older Hands docs saying handedness is
     * determined assuming a mirrored selfie image, and to swap it if your input
     * is not mirrored. We feed the raw camera frame, so on paper a swap was
     * correct. On this build of the Tasks API it is not: the label already
     * describes the actual hand, and swapping it named every hand wrongly.
     *
     * Taken at face value now, because that is what the screen showed. Kept as
     * one named constant rather than folded into the expression so that if it
     * ever needs flipping again — a different build, a genuinely mirrored
     * input — it is one line and one word, not an archaeology exercise.
     */
    const raw = labels[k]?.[0]?.categoryName ?? ''
    const named: Side = raw === 'Right' ? 'right' : 'left'
    const side: Side = SWAP_HANDEDNESS ? (named === 'right' ? 'left' : 'right') : named

    /**
     * Identity has to come from the hand, not from its position in the array.
     *
     * MediaPipe makes no promise about ordering between frames, so keying on
     * the array index means the two hands can silently swap — cursors trade
     * places, a drag in progress jumps to the other hand, and the filters that
     * smooth each hand start smoothing the other one. Keying on handedness
     * makes your left hand slot 0 for as long as it is your left hand.
     */
    const wristPx = toScreen(marks[WRIST])
    const reach = Math.hypot(w, h)
    const i = slotFor(side, wristPx, seen, reach)
    seen.add(i)

    const f = filtersFor(i)

    // Mirrored, because the camera faces you: moving your hand right should
    // move the cursor right, not left.
    const points = marks.map((m, j) => {
      const q = toScreen(m)
      return f.joints[j].filter(q.x, q.y, at)
    })

    const span = dist(points[WRIST], points[MIDDLE_MCP]) || 1

    /**
     * Distances for the shape questions — is it pinching, which fingers are
     * out — come from the 3D landmarks when there are any. See PINCH_ON_3D.
     * The screen points above are still what is drawn and what is aimed.
     */
    const w3 = world[k] && world[k].length >= 21 ? world[k] : null
    const D = (a: number, b: number) =>
      w3
        ? Math.hypot(w3[a].x - w3[b].x, w3[a].y - w3[b].y, w3[a].z - w3[b].z)
        : dist(points[a], points[b])
    const palm = D(WRIST, MIDDLE_MCP) || 1
    const gap = D(THUMB_TIP, INDEX_TIP) / palm
    const pinchOn = w3 ? PINCH_ON_3D : PINCH_ON
    const pinchOff = w3 ? PINCH_OFF_3D : PINCH_OFF
    const tucked = D(INDEX_TIP, MIDDLE_MCP) / palm < TUCKED

    let hand = hands.find((q) => q.id === i)
    if (!hand) {
      hand = {
        id: i, points,
        x: points[INDEX_TIP].x, y: points[INDEX_TIP].y,
        aimX: points[INDEX_TIP].x, aimY: points[INDEX_TIP].y,
        pinched: false, closeness: 0, gesture: 'none',
        fingers: { thumb: false, index: false, middle: false, ring: false, pinky: false },
        handedness: side, span,  // replaced by the vote below on the same frame
      }
      hands.push(hand)
      // Entry grace: the settling window, pushed out so the first frames of a
      // hand cannot press. See ENTRY_GRACE_MS.
      poseChangedAt.set(i, now + ENTRY_GRACE_MS - POSE_SETTLE_MS)
    }
    hand.points = points
    hand.span = span

    /**
     * Hysteresis, then confirmation, then a settling window.
     *
     * Three filters rather than one because they catch different things. The
     * hysteresis stops a held pinch flickering on the boundary. The
     * confirmation stops a pinch that lasts a frame or two on the way between
     * poses. The settling window stops one that arrives while the hand is still
     * rearranging after a deliberate change of gesture. A press has to get past
     * all three, and an intentional pinch does so without noticing they exist.
     */
    /**
     * How fast the hand is moving, from the cursor trail, in screen widths per
     * second. A pinch may not begin above FAST_HAND; one already held is
     * unaffected, or a fast drag would drop what it carries.
     */
    const prior = trails.get(i) ?? []
    let speed = 0
    for (const p of prior) {
      if (now - p.at <= 110 && now - p.at >= 40) {
        speed = Math.hypot(hand.x - p.x, hand.y - p.y) / ((now - p.at) / 1000) / w
        break
      }
    }

    // `tucked` only stops a pinch starting. Holding a firm pinch curls the
    // index toward the palm, and checking it mid-pinch dropped what you held.
    const wantsPinch = hand.pinched
      ? gap < pinchOff
      : !tucked && gap < pinchOn && speed < FAST_HAND
    if (!wantsPinch && hand.pinched) {
      releaseSince.set(i, releaseSince.get(i) ?? now)
    } else {
      releaseSince.delete(i)
    }
    const letGo = hand.pinched && !wantsPinch && now - (releaseSince.get(i) ?? now) >= RELEASE_CONFIRM_MS
    if (wantsPinch && !hand.pinched) {
      pinchSince.set(i, pinchSince.get(i) ?? now)
    } else if (!wantsPinch) {
      pinchSince.delete(i)
    }
    const held = pinchSince.get(i)
    const settledLongEnough = now - (poseChangedAt.get(i) ?? 0) > POSE_SETTLE_MS
    const pinched = hand.pinched
      ? !letGo
      : wantsPinch && held !== undefined && now - held >= PINCH_CONFIRM_MS && settledLongEnough
    hand.closeness = tucked && !hand.pinched ? 0 : Math.max(0, Math.min(1, 1 - (gap - pinchOn) / (pinchOff - pinchOn)))

    /**
     * Where the cursor sits: the index fingertip, and nothing else.
     *
     * It used to blend toward the midpoint between thumb and finger as the
     * pinch closed, on the theory that the midpoint is what you are "really"
     * aiming when you pinch. That was wrong, and wrong in the most annoying
     * possible way: the cursor slid away from the target during the act of
     * pressing it, so a press aimed at a title bar landed a centimetre below —
     * sometimes on the blade, sometimes on nothing. It is a pointer that moves
     * while you click, which no pointer may do.
     */
    // From the raw fingertip, not the smoothed skeleton: one filter, not two.
    const tip = toScreen(marks[INDEX_TIP])
    const aimed = f.cursor.filter(tip.x, tip.y, at)
    hand.x = aimed.x
    hand.y = aimed.y

    /**
     * What the press is aimed at: where the cursor was a moment ago.
     *
     * This used to latch the position only while `closeness < 0.35`, which
     * sounded like "while the hand is open" and is not. Closeness is measured
     * against the pinch thresholds, so that condition demanded thumb and finger
     * more than half a hand-span apart — further than anyone holds a hand they
     * are pointing with. The aim point therefore froze at wherever the hand was
     * FIRST seen and never moved again, so every pinch pressed at a stale point
     * somewhere across the screen. Nothing could be focused, grabbed or closed.
     *
     * A trail has no such cliff: it always records, and the press simply reads
     * back AIM_LAG_MS, which is the distance a fingertip covers on its way to
     * meeting the thumb.
     */
    const trail = trails.get(i) ?? []
    trail.push({ x: aimed.x, y: aimed.y, at: now })
    while (trail.length > 1 && now - trail[0].at > TRAIL_MS) trail.shift()
    trails.set(i, trail)

    if (!pinched) {
      const want = now - AIM_LAG_MS
      // The newest sample that is still old enough; the oldest we have if the
      // hand has only just appeared.
      let pick = trail[0]
      for (const p of trail) if (p.at <= want) pick = p
      hand.aimX = pick.x
      hand.aimY = pick.y
    }
    hand.pinched = pinched

    // Measured with D, so in 3D when there is 3D — rotation and foreshortening
    // no longer turn a straight finger into a curled one. See the note above
    // stableGesture for why distance from the wrist, not height on screen.
    const out = (tipJ: number, pipJ: number) => D(tipJ, WRIST) > D(pipJ, WRIST) * EXTEND_RATIO
    hand.fingers = {
      // The thumb never straightens the way the fingers do, so it is measured
      // against its own base joint rather than by the same ratio.
      thumb: D(THUMB_TIP, WRIST) > D(THUMB_MCP, WRIST) * 1.35 || D(THUMB_TIP, INDEX_PIP) > palm * 1.1,
      index: out(INDEX_TIP, INDEX_PIP),
      middle: out(MIDDLE_TIP, MIDDLE_PIP),
      ring: out(RING_TIP, RING_PIP),
      pinky: out(PINKY_TIP, PINKY_PIP),
    }
    const thumbRise = (points[THUMB_MCP].y - points[THUMB_TIP].y) / span
    const wasGesture = hand.gesture
    hand.gesture = stableGesture(i, classify(hand.fingers, pinched, thumbRise), now)
    // A change of pose starts the settling window. Pinch is not counted: it is
    // the thing being protected, not a transition to recover from.
    if (hand.gesture !== wasGesture && hand.gesture !== 'pinch' && wasGesture !== 'pinch') {
      poseChangedAt.set(i, now)
    }
    hand.handedness = votedSide(i, side)

    emit(hand)

    const { index: ix, middle: mx, ring: rx, pinky: px } = hand.fingers
    detectSwipe(hand, [ix, mx, rx, px].filter(Boolean).length >= 3, now)
    detectHold(hand, now)
  }

  // Anything not seen this frame has left the picture.
  for (const id of [0, 1]) if (!seen.has(id)) dropHand(id)

  diag.gesture = hands
    .map((q) => `${q.handedness === 'right' ? 'R' : 'L'}:${q.gesture}`)
    .join(' + ')

  frames++
  if (now - fpsAt > 1000) {
    diag.fps = Math.round((frames * 1000) / (now - fpsAt))
    frames = 0
    fpsAt = now
  }

  schedule(mine)
}

function schedule(mine: number) {
  if (!video) return
  if (typeof video.requestVideoFrameCallback === 'function') {
    video.requestVideoFrameCallback(() => loop(mine))
  } else {
    requestAnimationFrame(() => loop(mine))
  }
}

/** Turn the camera on and start tracking. Safe to call twice. */
export async function enableHands(): Promise<void> {
  if (running) return
  patchPointerCapture()
  const mine = ++generation
  try {
    /**
     * One shared camera, refcounted — see camera.ts.
     *
     * This used to open its own stream. A second getUserMedia makes Chrome drop
     * the first, so hand tracking and the camera blade could not both exist:
     * whichever started last blinded the other, and the symptom appeared in the
     * feature that had done nothing wrong.
     */
    video = await holdCamera()
    await ensureModel()

    running = true
    diag.enabled = true
    fpsAt = performance.now()
    schedule(mine)
  } catch (err) {
    diag.lastError = String((err as Error)?.message ?? err)
    disableHands()
    throw err
  }
}

/** Camera off, tracking stopped, anything held released. */
export function disableHands(): void {
  running = false
  generation++
  diag.enabled = false
  diag.count = 0
  diag.fps = 0
  diag.gesture = ''
  for (const h of hands) releasePress(h.id, h)
  hands.length = 0
  presses.clear()
  filters.clear()
  settling.clear()
  sideVote.clear()
  trails.clear()
  pinchSince.clear()
  poseChangedAt.clear()
  sweeps.clear()
  swipeQuiet.clear()
  holds.clear()
  releaseSince.clear()
  // Give the hold back rather than tearing the stream down: the camera blade
  // may still be showing it, and stopping the tracks would blank it.
  if (video) {
    video = null
    releaseCamera()
  }
}

/**
 * Both hands framing, and how big the box between them is.
 *
 * The gesture is the one people already make to mime a rectangle: index up,
 * thumb out, two corners held apart. Pulling them apart makes the box bigger;
 * bringing them together makes it smaller.
 *
 * Depth comes free. Moving both hands toward the camera makes everything about
 * them larger in the image, including the distance between them, so leaning in
 * grows the box and leaning back shrinks it — without a single line about z,
 * which is the noisiest number MediaPipe reports.
 *
 * The corner is measured at the crook between thumb and index rather than at
 * the index tip, because that is where the corner of the imagined rectangle
 * actually is, and it is the point that stays still while the fingers spread.
 *
 * Published as a plain distance. This file does not know what is on screen and
 * has no business deciding that a bigger box means a bigger blade.
 */
/**
 * How many hands are currently pinching.
 *
 * A single pinch is a grab. Two at once is not two grabs — it is somebody doing
 * something with both hands, and whatever that is, it is not "drag this blade
 * to two places at once". Consumers use this to stand down rather than fight
 * each other for the same object.
 */
export function pinchCount(): number {
  return hands.filter((h) => h.pinched).length
}

export function frameSpan(): number | null {
  const framing = hands.filter((h) => h.gesture === 'frame')
  if (framing.length < 2) return null
  const [a, b] = framing
  const corner = (h: Hand) => ({
    x: (h.points[THUMB_TIP].x + h.points[INDEX_TIP].x) / 2,
    y: (h.points[THUMB_TIP].y + h.points[INDEX_TIP].y) / 2,
  })
  const ca = corner(a)
  const cb = corner(b)
  return Math.hypot(ca.x - cb.x, ca.y - cb.y)
}

/**
 * Both hands closed, and how far apart they are.
 *
 * Two fists, pulled apart to grow and brought together to shrink. It is the
 * gesture for stretching something between your hands, and unlike the framing
 * pose it survives being half-turned away from the camera: a closed hand looks
 * closed from every angle, where an L-corner only reads as one when the palm
 * faces the lens.
 *
 * Closure is read from the fingers rather than from `gesture`, deliberately.
 * A fist brings the thumb close to the index, so it sits near the pinch
 * threshold and `classify` reports some fists as a pinch; keying on the
 * gesture string would make the resize drop out for exactly the hands that are
 * closed hardest. The fingers do not lie.
 *
 * Measured wrist to wrist. Fingertips move about inside a fist as it tightens,
 * the wrist does not, and a span that twitches while you hold still is a span
 * that resizes the blade while you hold still.
 */
const closed = (h: Hand) =>
  !h.fingers.index && !h.fingers.middle && !h.fingers.ring && !h.fingers.pinky

export function fistSpan(): number | null {
  const fists = hands.filter(closed)
  if (fists.length < 2) return null
  const [a, b] = fists
  const wa = a.points[WRIST]
  const wb = b.points[WRIST]
  return Math.hypot(wa.x - wb.x, wa.y - wb.y)
}

/**
 * Two fingers up, moved vertically — how far, since the pose began.
 *
 * Scrolling needed its own gesture once pinch became "grab this blade". A pinch
 * cannot mean both grab and scroll, and grabbing is what people reach for
 * first: they see a thing and try to pick it up. So scrolling gets the pose
 * that is deliberate and hard to make by accident.
 *
 * Returns pixels travelled since the two fingers went up, or null when nobody
 * is holding the pose. Published as a distance rather than as a scroll for the
 * same reason as twoHandSpan — this file does not know what is on screen.
 */
let peaceFrom: { id: number; y: number } | null = null

export function peaceScroll(): number | null {
  const hand = hands.find((h) => h.gesture === 'peace')
  if (!hand) {
    peaceFrom = null
    return null
  }
  if (!peaceFrom || peaceFrom.id !== hand.id) {
    peaceFrom = { id: hand.id, y: hand.y }
    return 0
  }
  return hand.y - peaceFrom.y
}

export const handsRunning = () => running
