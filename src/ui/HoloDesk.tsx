import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Canvas, useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import { useStore } from '../store'
import * as camera from '../lib/camera'
import * as hands from '../lib/hands'
import {
  DEFAULT_OPEN,
  HOLO_ORDER,
  HOLO_PANELS,
  bringToFront,
  homePosition,
  keepOnScreen,
  mirrorBox,
  panelScale,
  togglePanel,
  type HoloPanelId,
  type Point,
  type Size,
} from '../lib/holo'

/**
 * The holo desk.
 *
 * "Activate holo desk" and the screen becomes a mirror: the room through the
 * webcam, flipped so your hand moves the way you expect, tinted to the HUD,
 * with glass panels floating over it. Hand tracking comes on with it, so you
 * pinch a panel's header in the air and drag it where you want it; the dock
 * along the bottom opens and closes them.
 *
 * Nothing here knows about hands. Pinches arrive as ordinary pointer events
 * (lib/hands.ts), so the same drag code serves the mouse and the hand alike.
 *
 * The camera is only on while the desk is up, and only because you asked for
 * the desk by name. Closing it releases the camera, and stops hand tracking if
 * the desk was what started it.
 */

/** How long the dark "initialising" beat lasts before the room fades in. */
const REVEAL_MS = 650

export function HoloDesk() {
  const holo = useStore((s) => s.holo)
  return <AnimatePresence>{holo && <Desk key="desk" />}</AnimatePresence>
}

function Desk() {
  const setHolo = useStore((s) => s.setHolo)
  const video = useRef<HTMLVideoElement>(null)
  const [live, setLive] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [open, setOpen] = useState<readonly HoloPanelId[]>(DEFAULT_OPEN)
  const [order, setOrder] = useState<readonly HoloPanelId[]>(DEFAULT_OPEN)

  const view = useView()
  const scale = panelScale(view)
  const room = mirrorBox(view, hands.REACH)
  useCameraAndHands(video, setLive, setFailed)

  // Esc stands the desk down, ahead of anything else Esc does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setHolo(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [setHolo])

  const toggle = (id: HoloPanelId) => {
    setOpen((o) => togglePanel(o, id))
    setOrder((o) => (o.includes(id) ? o.filter((p) => p !== id) : [...o, id]))
  }
  const raise = (id: HoloPanelId) => setOrder((o) => bringToFront(o, id))

  return (
    <motion.div
      className="holo-desk"
      // Every size in the desk's CSS is multiplied by --hs, so on a big monitor
      // the panels, type and dock grow together. Real sizes, not CSS zoom: the
      // hologram's canvas measures its box, and under zoom it measured the
      // enlarged box and was enlarged again, which shoved the reactor into the
      // panel's bottom-right corner.
      style={{ ['--hs' as string]: scale }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, filter: 'blur(8px)' }}
      transition={{ duration: 0.35 }}
    >
      <video
        ref={video}
        className={`holo-room ${live ? 'holo-room-live' : ''}`}
        // Framed to match hand tracking, so your fingertip in the mirror is
        // where the cursor is (see mirrorBox).
        style={{ left: room.left, top: room.top, width: room.width, height: room.height }}
        muted
        playsInline
        autoPlay
      />
      <div className="holo-grade" />
      <div className="holo-tag">HOLO DESK · {failed ? 'NO CAMERA' : live ? 'CAMERA ON' : 'INITIALISING'}</div>
      {failed && <div className="holo-failed">{failed}</div>}

      {order.map((id) => (
        <HoloPanel key={id} id={id} scale={scale} onRaise={raise} onClose={toggle}>
          <PanelBody id={id} />
        </HoloPanel>
      ))}

      <Dock open={open} onToggle={toggle} onClose={() => setHolo(false)} />
    </motion.div>
  )
}

/** This window's size, kept current as it is resized, moved or made fullscreen. */
function useView(): Size {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight })
  const [view, setView] = useState(read)
  useEffect(() => {
    const onResize = () => setView(read())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return view
}

/**
 * Hold the camera and show it, and bring hands up if they are not already.
 * Hands that were on before the desk opened are left on after it closes.
 */
function useCameraAndHands(
  video: React.RefObject<HTMLVideoElement | null>,
  setLive: (on: boolean) => void,
  setFailed: (why: string | null) => void,
) {
  useEffect(() => {
    let cancelled = false
    let held = false
    let startedHands = false
    const reveal = window.setTimeout(() => {
      void (async () => {
        try {
          await camera.holdCamera()
          held = true
          if (cancelled) return
          const el = video.current
          const stream = camera.cameraStream()
          if (el && stream) {
            el.srcObject = stream
            await el.play().catch(() => {})
            setLive(true)
          }
          if (!hands.handsRunning()) {
            await hands.enableHands()
            startedHands = true
            if (cancelled) return
            useStore.getState().setGestures(true)
          }
        } catch (err) {
          if (cancelled) return
          setFailed(
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'Camera access is denied, so the desk has no room to show.'
              : `The camera could not start: ${(err as Error)?.message ?? err}`,
          )
        }
      })()
    }, REVEAL_MS)
    return () => {
      cancelled = true
      window.clearTimeout(reveal)
      if (startedHands) {
        hands.disableHands()
        useStore.getState().setGestures(false)
      }
      if (held) camera.releaseCamera()
    }
  }, [video, setLive, setFailed])
}

/* ------------------------------------------------------------------ panels */

interface HoloPanelProps {
  id: HoloPanelId
  scale: number
  onRaise: (id: HoloPanelId) => void
  onClose: (id: HoloPanelId) => void
  children: ReactNode
}

/**
 * A glass panel. Pinch (or press) anywhere on it to pick it up and move it.
 * The whole panel is the handle, not just the title bar: a strip 30 pixels
 * tall is easy with a mouse and nearly impossible to land on with a fingertip
 * held in the air, so a pinch used to fall on the body and do nothing.
 */
function HoloPanel({ id, scale, onRaise, onClose, children }: HoloPanelProps) {
  const spec = HOLO_PANELS[id]
  const [pos, setPos] = useState<Point>(() =>
    homePosition(id, { w: window.innerWidth, h: window.innerHeight }, scale),
  )
  const [grabbed, setGrabbed] = useState(false)

  const size = { w: spec.w * scale, h: spec.h * scale }

  const onGrab = (e: ReactPointerEvent) => {
    e.preventDefault()
    onRaise(id)
    setGrabbed(true)
    const dx = e.clientX - pos.x
    const dy = e.clientY - pos.y
    const move = (ev: PointerEvent) => {
      const view = { w: window.innerWidth, h: window.innerHeight }
      setPos(keepOnScreen({ x: ev.clientX - dx, y: ev.clientY - dy }, size, view))
    }
    const done = () => {
      setGrabbed(false)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
  }

  return (
    <motion.section
      className={`holo-panel ${grabbed ? 'holo-grabbed' : ''}`}
      style={{ left: pos.x, top: pos.y, width: size.w, height: size.h }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.25 }}
      onPointerDown={onGrab}
    >
      <header className="holo-head">
        <span className="holo-dot" />
        {spec.title.toUpperCase()}
        <button
          type="button"
          className="holo-x"
          aria-label={`Close ${spec.title}`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onClose(id)}
        >
          ×
        </button>
      </header>
      <div className="holo-body">{children}</div>
    </motion.section>
  )
}

function PanelBody({ id }: { id: HoloPanelId }) {
  switch (id) {
    case 'clock':
      return <ClockBody />
    case 'model':
      return <ModelBody />
    case 'log':
      return <LogBody />
    case 'status':
      return <StatusBody />
  }
}

function useNow(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), everyMs)
    return () => window.clearInterval(t)
  }, [everyMs])
  return now
}

function ClockBody() {
  const now = useNow(1000)
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const date = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div className="holo-clock">
      <div className="holo-time">{time}</div>
      <div className="holo-date">{date}</div>
      <div className="holo-secs" style={{ ['--s' as string]: now.getSeconds() / 59 }} />
    </div>
  )
}

/**
 * A wireframe of the reactor, turning on its own. It used to spin when dragged
 * across, which meant a pinch on it spun the model instead of moving the
 * panel; moving the panel is what a pinch is for here.
 */
function ModelBody() {
  return (
    <div className="holo-model">
      <Canvas camera={{ position: [0, 0, 4.2], fov: 45 }} dpr={[1, 2]} gl={{ alpha: true }}>
        <Wireframe />
      </Canvas>
      <div className="holo-model-tag">ARC REACTOR · MK I</div>
    </div>
  )
}

const CYAN = '#5fe6ff'
const IDLE_SPIN = 0.35

function Wireframe() {
  const root = useRef<Group>(null)
  useFrame((_, dt) => {
    const g = root.current
    if (!g) return
    g.rotation.y += dt * IDLE_SPIN
    g.rotation.x = 0.35 + Math.sin(performance.now() / 2400) * 0.08
  })
  return (
    <group ref={root}>
      <mesh>
        <icosahedronGeometry args={[0.45, 1]} />
        <meshBasicMaterial color={CYAN} wireframe transparent opacity={0.9} />
      </mesh>
      {[0.75, 0.98, 1.18].map((r, i) => (
        <mesh key={r} rotation={[Math.PI / 2 + i * 0.5, i * 0.7, 0]}>
          <torusGeometry args={[r, 0.012, 6, 96]} />
          <meshBasicMaterial color={CYAN} transparent opacity={0.65 - i * 0.15} />
        </mesh>
      ))}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.88, 0.88, 0.02, 32, 1, true]} />
        <meshBasicMaterial color={CYAN} wireframe transparent opacity={0.25} />
      </mesh>
    </group>
  )
}

const LOG_TURNS = 6

function LogBody() {
  const turns = useStore((s) => s.turns)
  const recent = turns.slice(-LOG_TURNS)
  if (recent.length === 0) return <div className="holo-empty">Nothing said yet.</div>
  return (
    <ol className="holo-log">
      {recent.map((t) => (
        <li key={t.id} className={`holo-turn holo-turn-${t.role}`}>
          <span>{t.role === 'user' ? 'YOU' : 'JARVIS'}</span>
          {t.text}
        </li>
      ))}
    </ol>
  )
}

function StatusBody() {
  const connected = useStore((s) => s.connected)
  const voice = useStore((s) => s.voice)
  const gestures = useStore((s) => s.gestures)
  const phase = useStore((s) => s.phase)
  const rows: [string, string, boolean][] = [
    ['STATE', phase.toUpperCase(), true],
    ['HANDS', gestures ? 'TRACKING' : 'OFF', gestures],
    ['VOICE', voice || 'DEFAULT', Boolean(voice)],
    ['LINKS', `${connected.length} ONLINE`, connected.length > 0],
  ]
  return (
    <dl className="holo-status">
      {rows.map(([k, v, ok]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className={ok ? 'holo-ok' : 'holo-off'}>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

/* -------------------------------------------------------------------- dock */

const ICONS: Record<HoloPanelId, ReactNode> = {
  clock: (
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>
  ),
  model: (
    <svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></svg>
  ),
  log: (
    <svg viewBox="0 0 24 24"><path d="M5 5h14v10H9l-4 4z" /></svg>
  ),
  status: (
    <svg viewBox="0 0 24 24"><path d="M3 12h4l2-5 4 10 2-5h6" /></svg>
  ),
}

interface DockProps {
  open: readonly HoloPanelId[]
  onToggle: (id: HoloPanelId) => void
  onClose: () => void
}

function Dock({ open, onToggle, onClose }: DockProps) {
  return (
    <nav className="holo-dock">
      {HOLO_ORDER.map((id) => (
        <button
          key={id}
          type="button"
          className={`holo-dock-btn ${open.includes(id) ? 'holo-dock-on' : ''}`}
          onClick={() => onToggle(id)}
          aria-pressed={open.includes(id)}
        >
          {ICONS[id]}
          <span>{HOLO_PANELS[id].title}</span>
        </button>
      ))}
      <button type="button" className="holo-dock-btn holo-dock-exit" onClick={onClose}>
        <svg viewBox="0 0 24 24"><path d="M12 3v8" /><path d="M6.5 6.5a8 8 0 1 0 11 0" /></svg>
        <span>Close</span>
      </button>
    </nav>
  )
}
