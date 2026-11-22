import { useEffect, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { useStore, accentFor } from '../store'
import { dive, nudge, ownsWheel, revealWords, scramble, clamp01, type Scrollish } from '../lib/dive'

/**
 * The DOM half of the scroll dive: the wheel input, and the caption that
 * decodes JARVIS's last reply one word at a time as the camera goes in.
 *
 * The scene half lives in Scene.tsx and reads the same `dive` value. This
 * component only re-renders while the caption is on screen and actually
 * changing — at rest it holds still at zero opacity.
 */

/** Said when there is no reply to show yet. */
const FALLBACK = 'All systems online. Every reactor ring holding steady, sir.'
/** Depths over which the caption fades in, and over which its words decode. */
const SHOW_FROM = 0.06
const SHOW_TO = 0.2
const DECODE_FROM = 0.1
const DECODE_SPAN = 0.72
/** Glyph refresh interval for the decoding word. */
const GLYPH_MS = 55

type Frame = { opacity: number; progress: number; tick: number }
const REST: Frame = { opacity: 0, progress: 0, tick: 0 }

const asScrollish = (el: EventTarget | null): Scrollish | null =>
  el instanceof Element ? (el as unknown as Scrollish) : null

const styleOf = (el: Scrollish) => getComputedStyle(el as unknown as Element)

function useDiveInput() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      // Ctrl+wheel is the trackpad pinch: that is zoom, not travel.
      if (e.ctrlKey) return
      if (ownsWheel(asScrollish(e.target), e.deltaY, styleOf)) return
      dive.target = nudge(dive.target, e.deltaY, e.deltaMode)
    }
    // Escape already stands JARVIS down in App; it also brings the camera home.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dive.target = 0
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

/** Samples the dive each animation frame, publishing only real changes. */
function useDiveFrame(): Frame {
  const [frame, setFrame] = useState<Frame>(REST)
  useEffect(() => {
    let raf = 0
    const step = (now: number) => {
      const d = dive.depth
      const next: Frame = {
        opacity: clamp01((d - SHOW_FROM) / (SHOW_TO - SHOW_FROM)),
        progress: clamp01((d - DECODE_FROM) / DECODE_SPAN),
        tick: Math.floor(now / GLYPH_MS),
      }
      setFrame((prev) => {
        if (next.opacity === 0 && prev.opacity === 0) return prev
        const same =
          Math.abs(prev.opacity - next.opacity) < 0.005 &&
          Math.abs(prev.progress - next.progress) < 0.002 &&
          prev.tick === next.tick
        return same ? prev : next
      })
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])
  return frame
}

export function Dive() {
  useDiveInput()
  const { opacity, progress, tick } = useDiveFrame()
  const reduced = useReducedMotion()
  const reply = useStore((s) => {
    for (let i = s.turns.length - 1; i >= 0; i--) {
      if (s.turns[i].role === 'jarvis' && s.turns[i].text.trim()) return s.turns[i].text
    }
    return FALLBACK
  })
  const accent = useStore((s) => accentFor(s.phase, s.ui))

  if (opacity === 0) return null

  const { shown, current, currentProgress, rest } = revealWords(reply, progress)
  const decoding = current && (reduced ? current : scramble(current, currentProgress, tick))

  return (
    <div
      className="dive-caption"
      style={{ opacity, ['--accent' as string]: accent }}
      aria-live="off"
    >
      <span className="dive-shown">{shown.join(' ')}</span>
      {decoding && <span className="dive-current"> {decoding}</span>}
      {rest.length > 0 && <span className="dive-rest"> {rest.join(' ')}</span>}
    </div>
  )
}
