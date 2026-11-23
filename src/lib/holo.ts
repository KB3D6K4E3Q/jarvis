/**
 * The holo desk's layout, kept apart from the component so it can be tested.
 *
 * The desk is the room seen through the webcam, mirrored, with glass panels
 * floating over it that you pinch and drag in the air. Everything here is
 * plain data and pure functions: where each panel starts, how far a drag may
 * take it, which panels are open and in what stacking order.
 */

export type HoloPanelId = 'clock' | 'model' | 'log' | 'status'

export interface Size {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

interface PanelSpec extends Size {
  /** Shown in the panel header and on its dock button. */
  title: string
  /** Where it opens, as fractions of the free space across and down. */
  home: Point
}

/**
 * The panels. Sizes in CSS pixels; homes leave the middle of the screen clear,
 * because that is where you are sitting in the mirror.
 */
export const HOLO_PANELS: Readonly<Record<HoloPanelId, PanelSpec>> = {
  clock: { title: 'Clock', w: 260, h: 150, home: { x: 0.04, y: 0.1 } },
  model: { title: 'Hologram', w: 300, h: 320, home: { x: 0.96, y: 0.12 } },
  log: { title: 'Conversation', w: 320, h: 300, home: { x: 0.04, y: 0.55 } },
  status: { title: 'Systems', w: 280, h: 220, home: { x: 0.96, y: 0.7 } },
}

export const HOLO_ORDER: readonly HoloPanelId[] = ['clock', 'model', 'log', 'status']

/** What is open the moment the desk activates. */
export const DEFAULT_OPEN: readonly HoloPanelId[] = ['clock', 'model']

/** How much of a panel must stay on screen, so it can always be grabbed back. */
const GRAB_MARGIN = 80

/** Room left at the bottom for the dock. */
const DOCK_CLEARANCE = 110

/** Where a panel opens, given how much it has been enlarged (see panelScale). */
export function homePosition(id: HoloPanelId, view: Size, scale = 1): Point {
  const { w, h, home } = HOLO_PANELS[id]
  const freeW = Math.max(0, view.w - w * scale)
  const freeH = Math.max(0, view.h - (h + DOCK_CLEARANCE) * scale)
  return { x: Math.round(freeW * home.x), y: Math.round(freeH * home.y) }
}

/**
 * Clamp a dragged panel so its header can never leave the screen. It may hang
 * off the left, right or bottom edge, but never so far that there is nothing
 * left to pinch, and never above the top, where its header would be lost.
 */
export function keepOnScreen(pos: Point, size: Size, view: Size): Point {
  const x = Math.min(Math.max(pos.x, GRAB_MARGIN - size.w), view.w - GRAB_MARGIN)
  const y = Math.min(Math.max(pos.y, 0), view.h - GRAB_MARGIN)
  return x === pos.x && y === pos.y ? pos : { x, y }
}

/** Open a closed panel or close an open one. Returns a new list. */
export function togglePanel(
  open: readonly HoloPanelId[],
  id: HoloPanelId,
): HoloPanelId[] {
  return open.includes(id) ? open.filter((p) => p !== id) : [...open, id]
}

/**
 * Move a panel to the top of the stack (the end of the list). An id that is
 * not open returns the list untouched, the same reference, so callers can skip
 * a re-render.
 */
export function bringToFront(
  order: readonly HoloPanelId[],
  id: HoloPanelId,
): readonly HoloPanelId[] {
  if (!order.includes(id) || order[order.length - 1] === id) return order
  return [...order.filter((p) => p !== id), id]
}

/* ----------------------------------------------------- big screens, two screens */

/** The screen width the panel sizes were designed at. */
const DESIGN_WIDTH = 1440
/** Panels stop growing here; past it they start to crowd the mirror. */
const MAX_SCALE = 1.75

/**
 * How much to enlarge the panels. Sized for a laptop, they read as postage
 * stamps on a 27-inch monitor across the desk, so they grow with the screen,
 * but never shrink below what they were designed at.
 */
export function panelScale(view: Size): number {
  const s = view.w / DESIGN_WIDTH
  return Math.round(Math.min(MAX_SCALE, Math.max(1, s)) * 100) / 100
}

/** The parts of a ScreenDetailed this needs. */
export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

const sameScreen = (a: ScreenRect, b: ScreenRect) =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height

/**
 * The screen to put the holo desk on: the largest one the JARVIS window is
 * not already on, or null when there is only one. Compared by position rather
 * than identity, because the browser hands back fresh objects on every read.
 */
export function pickSecondScreen<T extends ScreenRect>(
  screens: readonly T[],
  current: ScreenRect,
): T | null {
  const others = screens.filter((s) => !sameScreen(s, current))
  if (others.length === 0) return null
  return others.reduce((best, s) => (s.width * s.height > best.width * best.height ? s : best))
}

/* ------------------------------------------------- the mirror and the cursor */

/** How much of the camera view hand tracking spreads across the screen. */
export interface Reach {
  x: number
  top: number
  bottom: number
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where to draw the mirrored camera picture so your fingertip on screen is
 * exactly where the hand cursor is.
 *
 * Hand tracking maps only the middle of the camera view onto the screen (see
 * REACH in lib/hands.ts), so you can reach the corners without your hand
 * leaving the frame. The mirror has to show that same middle region, edge to
 * edge, or the cursor floats a hand's width away from the finger you see —
 * which on a wide fullscreen monitor made pinching a panel feel broken. The
 * picture is therefore drawn larger than the screen and shifted so its margins
 * fall off the edges. It stretches slightly when the screen's shape differs
 * from the camera's; lining up beats exact proportions for a mirror you touch.
 */
export function mirrorBox(view: Size, reach: Reach): Box {
  const width = view.w / (1 - 2 * reach.x)
  const height = view.h / (1 - reach.top - reach.bottom)
  // Mirrored, so the left margin that falls off screen is the camera's right.
  return { left: -reach.x * width, top: -reach.top * height, width, height }
}
