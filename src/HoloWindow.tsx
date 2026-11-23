import { useEffect, useRef } from 'react'
import { useStore } from './store'
import { HoloDesk } from './ui/HoloDesk'
import { Pointer } from './ui/Pointer'
import { followMainWindow } from './lib/holoWindow'

/**
 * The page the second monitor shows in dual-screen mode: the holo desk and
 * nothing else. No voice, no wake word, no reactor — JARVIS is the other
 * window. The conversation and status arrive from it (lib/holoWindow.ts).
 *
 * Closing the desk (Esc, the dock's Close, or "close dual screen") closes the
 * window. It opens fullscreen on its own (see the effect below).
 */
export default function HoloWindow() {
  const holo = useStore((s) => s.holo)
  const wasOpen = useRef(false)

  useEffect(() => {
    document.title = 'J.A.R.V.I.S. · Holo desk'
    useStore.getState().setHolo(true)
    return followMainWindow()
  }, [])

  // Fullscreen straight away. Chrome allows that without a click only because
  // scripts/jarvis.sh grants this page automatic fullscreen; if it is refused
  // anyway, the first pinch or click does it instead.
  useEffect(() => {
    const goFullscreen = () => {
      if (document.fullscreenElement) return Promise.resolve()
      return document.documentElement.requestFullscreen()
    }
    const onFirstTouch = () => void goFullscreen().catch(() => {})
    goFullscreen().catch(() => window.addEventListener('pointerdown', onFirstTouch, { once: true }))
    return () => window.removeEventListener('pointerdown', onFirstTouch)
  }, [])

  // The desk was stood down from inside this window: nothing left to show.
  // Only once it has been up — on the very first render it is not yet.
  useEffect(() => {
    if (holo) wasOpen.current = true
    else if (wasOpen.current) window.close()
  }, [holo])

  return (
    <>
      <HoloDesk />
      <Pointer />
    </>
  )
}
