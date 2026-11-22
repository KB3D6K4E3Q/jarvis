import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore, type Blade } from '../store'
import { BRIDGE_HTTP_URL } from '../config'
import { sanitisePanelHtml } from './sanitise'
import { fistSpan, peaceScroll, pinchCount, type SwipeDetail } from '../lib/hands'
import * as camera from '../lib/camera'

/**
 * The blades.
 *
 * This file used to be six slivers of light raking across the frame while a
 * tool ran — pure atmosphere, nothing you could read. That effect is still
 * here, at the bottom, because it is still the right answer to "something is
 * happening". But the name now belongs to the surface it was decorating.
 *
 * A panel is a card you glance at while listening: a figure, three headlines, a
 * status line. A blade is the thing you actually look at. The distinction is
 * not styling, it is geometry — an article you are meant to READ needs a column
 * of a particular width and a height you can scroll, and no amount of care
 * makes that work inside a 320px card stacked beside the reactor. So blades own
 * their size, they stack instead of replacing one another, and the user can
 * pull an older one forward or throw one to full screen.
 *
 * The hard problem a blade solves is that most of the web refuses to be shown.
 * X-Frame-Options and frame-ancestors stop an article being framed, CORS stops
 * the page fetching it, and hotlink protection stops even its images loading.
 * All three are rules the origin server enforces against the *browser*, so the
 * bridge takes the browser out of it: it fetches server-side and serves the
 * result from localhost, and at that point the document in the iframe is ours.
 *
 * Nothing in this file is a special case for a particular site, and nothing
 * here sniffs a file extension. The model asks `probe_url` what a thing is and
 * says what it wants shown; this only knows how to show it.
 */

/* ------------------------------------------------------------------ sources */

/**
 * Paths that are genuinely on this machine's disk, as opposed to app-relative
 * URLs that happen to start with a slash. Mirrors the test in sanitise.ts and
 * Orbits.tsx — the list of root directories is the sort of thing that should be
 * changed in each place deliberately.
 */
const DISK_PATH =
  /^\/(Users|home|root|Volumes|Applications|System|Library|private|tmp|var|opt|mnt|media|srv|data)\//

/** Route a source through the bridge, which is the only origin that can
 *  actually fetch it — and the only one the page CSP will load from. */
function viaBridge(raw: string, route: 'img' | 'media'): string {
  const src = String(raw ?? '').trim()
  if (!src) return ''
  const path = src.replace(/^file:\/\//, '')
  if (DISK_PATH.test(path)) {
    return `${BRIDGE_HTTP_URL}/file?path=${encodeURIComponent(path)}`
  }
  if (!/^https?:\/\//i.test(src)) return src
  if (src.startsWith(`${BRIDGE_HTTP_URL}/`)) return src
  return `${BRIDGE_HTTP_URL}/${route}?url=${encodeURIComponent(src)}`
}

/** A whole document, rendered by the bridge so it can be framed at all. */
const pageUrl = (url: string, mode: 'reader' | 'live') =>
  `${BRIDGE_HTTP_URL}/page?mode=${mode}&url=${encodeURIComponent(url)}`

/**
 * The three embed hosts, and only these.
 *
 * Same closed list as the panel sanitiser, for the same reason: YouTube and
 * Vimeo will not hand over the media file, so an iframe is the only way to play
 * a result inline, and the trade for that is that the host list does not grow.
 */
function embedUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '')
  const id = (s: string) => (/^[\w-]{6,20}$/.test(s) ? s : null)

  // enablejsapi lets this page drive the player by message — the only way a
  // hand can press play, since nothing may click inside another site's frame.
  const yt = (v: string) =>
    `https://www.youtube-nocookie.com/embed/${v}?enablejsapi=1&origin=${encodeURIComponent(location.origin)}`
  if (host === 'youtube.com' && url.pathname === '/watch') {
    const v = id(url.searchParams.get('v') ?? '')
    return v && yt(v)
  }
  if (host === 'youtu.be') {
    const v = id(url.pathname.slice(1))
    return v && yt(v)
  }
  if (host === 'youtube-nocookie.com' && /^\/embed\/[\w-]+/.test(url.pathname)) {
    const v = id(url.pathname.split('/')[2] ?? '')
    return v && yt(v)
  }
  if (host === 'vimeo.com') {
    const v = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return /^\d+$/.test(v) ? `https://player.vimeo.com/video/${v}` : null
  }
  if (host === 'player.vimeo.com' && /^\/video\/\d+/.test(url.pathname)) return url.href
  return null
}

/* ------------------------------------------------------------------ players */

/**
 * A YouTube or Vimeo player that a hand can use.
 *
 * The player is another site in a frame, and no page may click inside another
 * site's frame — not with a mouse event it made up, not with anything. Both
 * players instead accept commands by postMessage. So a hand gets two ways in:
 * a pinch-click on the picture (hands.ts reports it as `hand-tap` on the
 * frame) plays or pauses, and a row of large controls under it, which are
 * ordinary buttons in this page and so click like everything else.
 */
const VideoEmbed = memo(function VideoEmbed({ src, title }: { src: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const vimeo = src.includes('player.vimeo.com')
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  /** Seconds in, as last reported by the player. Needed to seek relatively. */
  const time = useRef(0)

  const post = useCallback(
    (msg: object) => {
      const target = vimeo ? 'https://player.vimeo.com' : 'https://www.youtube-nocookie.com'
      frame.current?.contentWindow?.postMessage(JSON.stringify(msg), target)
    },
    [vimeo],
  )

  const command = useCallback(
    (what: 'play' | 'pause' | 'mute' | 'unmute' | 'seek', at = 0) => {
      if (vimeo) {
        if (what === 'play') post({ method: 'play' })
        else if (what === 'pause') post({ method: 'pause' })
        else if (what === 'mute') post({ method: 'setVolume', value: 0 })
        else if (what === 'unmute') post({ method: 'setVolume', value: 1 })
        else post({ method: 'setCurrentTime', value: Math.max(0, at) })
        return
      }
      const func = { play: 'playVideo', pause: 'pauseVideo', mute: 'mute', unmute: 'unMute', seek: 'seekTo' }[what]
      post({ event: 'command', func, args: what === 'seek' ? [Math.max(0, at), true] : [] })
    },
    [post, vimeo],
  )

  // Ask the player to report its state, and keep track of what it says.
  useEffect(() => {
    const el = frame.current
    if (!el) return
    const subscribe = () => {
      if (vimeo) {
        for (const value of ['play', 'pause', 'playProgress']) post({ method: 'addEventListener', value })
      } else {
        post({ event: 'listening', id: title, channel: 'widget' })
      }
    }
    const onMessage = (e: MessageEvent) => {
      if (e.source !== el.contentWindow) return
      let d: Record<string, unknown>
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
      } catch {
        return
      }
      if (vimeo) {
        if (d.event === 'ready') subscribe()
        if (d.event === 'play') setPlaying(true)
        if (d.event === 'pause') setPlaying(false)
        const sec = (d.data as { seconds?: number } | undefined)?.seconds
        if (d.event === 'playProgress' && typeof sec === 'number') time.current = sec
        return
      }
      const info = d.info as { playerState?: number; currentTime?: number; muted?: boolean } | undefined
      if (d.event === 'onReady') subscribe()
      if (!info) return
      // 1 is playing, 3 buffering (still on its way to playing).
      if (typeof info.playerState === 'number') setPlaying(info.playerState === 1 || info.playerState === 3)
      if (typeof info.currentTime === 'number') time.current = info.currentTime
      if (typeof info.muted === 'boolean') setMuted(info.muted)
    }
    window.addEventListener('message', onMessage)
    el.addEventListener('load', subscribe)
    return () => {
      window.removeEventListener('message', onMessage)
      el.removeEventListener('load', subscribe)
    }
  }, [post, vimeo, title])

  const toggle = useCallback(() => {
    command(playing ? 'pause' : 'play')
    // Optimistic: the player confirms within a moment, and a button that
    // waits for the round trip feels like it missed.
    setPlaying(!playing)
  }, [command, playing])

  // A pinch-click on the picture itself.
  useEffect(() => {
    const el = frame.current
    if (!el) return
    el.addEventListener('hand-tap', toggle)
    return () => el.removeEventListener('hand-tap', toggle)
  }, [toggle])

  const skip = (by: number) => {
    time.current = Math.max(0, time.current + by)
    command('seek', time.current)
  }

  // Pressing a control must not also start dragging the blade.
  const stop = (e: React.PointerEvent) => e.stopPropagation()

  return (
    <div className="bl-player">
      <iframe
        ref={frame}
        className="bl-frame"
        src={src}
        // A player genuinely needs scripts and its own origin. Nothing that
        // reaches the room the user is sitting in is granted.
        sandbox="allow-scripts allow-same-origin allow-presentation"
        allow="accelerometer; encrypted-media; picture-in-picture; fullscreen; autoplay"
        // Not no-referrer: YouTube and Vimeo refuse to play without knowing
        // which site embeds them, and YouTube says so as "Error 153". This
        // sends the origin alone (http://localhost:5173), never the path.
        referrerPolicy="strict-origin-when-cross-origin"
        allowFullScreen
        title={title}
      />
      <div className="bl-controls" onPointerDown={stop}>
        <button className="bl-ctl" onClick={() => skip(-10)} title="Back ten seconds">
          ◂◂ 10
        </button>
        <button className="bl-ctl bl-ctl-main" onClick={toggle} title={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="bl-ctl" onClick={() => skip(10)} title="Forward ten seconds">
          10 ▸▸
        </button>
        <button
          className="bl-ctl"
          onClick={() => {
            command(muted ? 'unmute' : 'mute')
            setMuted(!muted)
          }}
          title={muted ? 'Sound on' : 'Mute'}
        >
          {muted ? 'SOUND' : 'MUTE'}
        </button>
      </div>
    </div>
  )
})

/* --------------------------------------------------------------------- body */

/**
 * What goes inside a blade.
 *
 * Every iframe is sandboxed. `allow-same-origin` is deliberately absent from
 * the proxied-page case: that document is served from the bridge's own origin —
 * the one origin permitted to open the agent socket — so granting it
 * same-origin would let a page JARVIS found on the web reach that socket. It
 * does not need it. It is being read, not run.
 */
/**
 * The live camera, on screen.
 *
 * Holding the camera for as long as the blade is open does two jobs. It shows
 * the user what JARVIS can see, which is the honest way to run a camera; and it
 * starts the rolling buffer, which is the only reason "what did I just do" can
 * ever be answered — a question that cannot be satisfied by starting to record
 * at the moment it is asked.
 *
 * Mirrored here and only here. A person expects their own image to behave like
 * a reflection, so the preview is flipped for them; the frames handed to the
 * model are not, because a label held up to the lens has to arrive the right
 * way round.
 */
const CameraView = memo(function CameraView() {
  const el = useRef<HTMLVideoElement>(null)
  const [failed, failed_] = useState<string | null>(null)

  useEffect(() => {
    let held = false
    let gone = false
    void camera
      .holdCamera()
      .then((source) => {
        if (gone) {
          camera.releaseCamera()
          return
        }
        held = true
        camera.startBuffer()
        if (el.current && source.srcObject) el.current.srcObject = source.srcObject
      })
      .catch((err: DOMException) =>
        failed_(
          err?.name === 'NotAllowedError'
            ? 'Camera access is not permitted.'
            : `The camera could not be opened: ${err?.message ?? err}`,
        ),
      )
    return () => {
      gone = true
      if (held) camera.releaseCamera()
    }
  }, [])

  if (failed) return <p className="bl-note">{failed}</p>
  return <video ref={el} className="bl-camera" autoPlay playsInline muted />
})

const Body = memo(function Body({ blade }: { blade: Blade }) {
  if (blade.kind === 'camera') return <CameraView />

  if (blade.kind === 'article' && blade.url) {
    return (
      <iframe
        className="bl-frame"
        src={pageUrl(blade.url, blade.mode ?? 'reader')}
        // allow-scripts WITHOUT allow-same-origin. That combination is the
        // point: the page runs in an opaque origin, so the one script the
        // bridge injects can move the document's own scroll position and can
        // reach nothing of ours — not this origin, not the agent socket. Adding
        // allow-same-origin would hand a page found on the web the keys.
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        title={blade.title}
      />
    )
  }

  if (blade.kind === 'embed' && blade.url) {
    const embed = embedUrl(blade.url)
    if (!embed) return <p className="bl-note">That video link could not be played.</p>
    return <VideoEmbed src={embed} title={blade.title} />
  }

  if (blade.kind === 'video' && blade.url) {
    return (
      <video
        className="bl-video"
        src={viaBridge(blade.url, 'media')}
        controls
        playsInline
        preload="metadata"
      />
    )
  }

  if (blade.kind === 'image' && blade.url) {
    return <img className="bl-image" src={viaBridge(blade.url, 'img')} alt={blade.title} />
  }

  if (blade.kind === 'gallery') {
    return (
      <div className="bl-gallery">
        {(blade.images ?? []).map((src, i) => (
          <img key={`${src}-${i}`} className="bl-thumb" src={viaBridge(src, 'img')} alt="" />
        ))}
      </div>
    )
  }

  if (blade.kind === 'markup' && blade.html) {
    // Model-authored markup gets exactly the treatment panel markup gets.
    // There is one sanitiser, and this is it.
    return (
      <div
        className="bl-markup p-body"
        dangerouslySetInnerHTML={{ __html: sanitisePanelHtml(blade.html) }}
      />
    )
  }

  return <p className="bl-note">Nothing to show.</p>
})

/* -------------------------------------------------------------------- card */

/** Where a blade sits in the overview: a cell, as an offset from the centre. */
type Tile = { x: number; y: number; w: number; h: number }

/** Dragged this close to an edge (fraction of the screen), a blade snaps to it. */
const SNAP_EDGE = 0.04
type SnapZone = 'left' | 'right' | 'top' | null

/** Tell the stack where a drag would snap, so it can show the outline. */
const hintSnap = (zone: SnapZone) =>
  window.dispatchEvent(new CustomEvent('blade-snap-hint', { detail: zone }))

const zoneAt = (x: number, y: number): SnapZone =>
  x < window.innerWidth * SNAP_EDGE ? 'left'
  : x > window.innerWidth * (1 - SNAP_EDGE) ? 'right'
  : y < window.innerHeight * SNAP_EDGE ? 'top'
  : null

/** How fast the pointer was moving at release, in pixels per millisecond. */
type Fling = { vx: number; vy: number; kind: string }

/** Release speed is read from this much of the drag just before letting go. */
const FLING_WINDOW_MS = 160
/** Faster than this sideways, by hand, and the blade is thrown away (px/ms). */
const FLING_CLOSE = 2.2
/** Slower than this and it just stops where it was let go. */
const GLIDE_MIN = 0.35
/** Speed kept per 16 ms of gliding. */
const GLIDE_FRICTION = 0.93

/**
 * The fastest stretch of the recent drag. Peak rather than average, because a
 * hand slows in the instant it opens to let go, and an average reads every
 * flick as limp. Older than `now - 120ms` counts for nothing: a drag that
 * stopped and then let go was not a throw.
 */
function peakVelocity(trail: { x: number; y: number; t: number }[], now: number) {
  let best = { vx: 0, vy: 0 }
  let top = 0
  for (let i = 1; i < trail.length; i++) {
    if (now - trail[i].t > 120) continue
    const dt = Math.max(8, trail[i].t - trail[i - 1].t)
    const vx = (trail[i].x - trail[i - 1].x) / dt
    const vy = (trail[i].y - trail[i - 1].y) / dt
    const sp = Math.hypot(vx, vy)
    if (sp > top) {
      top = sp
      best = { vx, vy }
    }
  }
  return best
}

function Card({
  blade,
  depth,
  focused,
  expanded,
  tile,
  exitDir,
  onFocus,
  onExpand,
  onClose,
  onMinimise,
  onPick,
  onThrow,
}: {
  blade: Blade
  /** 0 is front-most. Drives the offset and the dimming behind it. */
  depth: number
  focused: boolean
  expanded: boolean
  /** Set while the overview is up: the cell this blade is laid out in. */
  tile: Tile | null
  /** Set when a swipe closed it: which way it flies off. */
  exitDir: 'left' | 'right' | undefined
  onFocus: () => void
  onExpand: () => void
  onClose: () => void
  onMinimise: () => void
  /** Chosen from the overview. */
  onPick: () => void
  /** Flicked hard off the side of the screen: close it, flying that way. */
  onThrow: (dir: 'left' | 'right') => void
}) {
  /** Size the user has dragged this blade to, overriding the class preset. */
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  /** Where the user has dragged it, relative to its slot. */
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const shell = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)

  /**
   * Scroll whatever this blade is showing.
   *
   * Two destinations, because a blade holds two different kinds of thing. Its
   * own overflow for markup and galleries; a postMessage for an article, since
   * an iframe is a separate document that the parent cannot scroll directly —
   * see the shim in bridge/page.mjs.
   */
  const scrollContent = (dy: number) => {
    const el = body.current
    if (!el) return
    const frame = el.querySelector('iframe')
    if (frame?.contentWindow) {
      frame.contentWindow.postMessage({ jarvis: 'scroll', dy }, '*')
    } else {
      el.scrollTop += dy
    }
  }

  /**
   * Drag and resize both listen on `window`, and that is the whole trick.
   *
   * The obvious implementations do not work by hand. framer-motion's own drag
   * tracks the pointer through internals we cannot reach, and the resize grip
   * originally listened on the grip element — but the hand controller aims its
   * synthetic events with elementFromPoint, and one pixel into a drag the
   * element under the cursor is no longer the grip. So resizing by hand died on
   * the first frame, and dragging never started at all.
   *
   * Listening on window fixes both for free: a synthetic event dispatched at
   * whatever is under the cursor still bubbles to window, so these handlers see
   * a hand and a mouse identically. Which is the property the gesture layer was
   * designed around — one interaction, not two implementations of it.
   */
  const grab = (
    e: React.PointerEvent,
    onMove: (dx: number, dy: number) => void,
    /** Where the pointer was when it let go, and how fast it was going. */
    onEnd?: (x: number, y: number, v: Fling) => void,
  ) => {
    e.preventDefault()
    e.stopPropagation()
    stopGlide()
    const kind = e.pointerType
    const trail: { x: number; y: number; t: number }[] = []
    const sx = e.clientX
    const sy = e.clientY
    let baseX = sx
    let baseY = sy
    let dx = 0
    let dy = 0
    let lastX = sx
    let lastY = sy

    const move = (ev: PointerEvent) => {
      lastX = ev.clientX
      lastY = ev.clientY
      const t = performance.now()
      trail.push({ x: lastX, y: lastY, t })
      while (trail.length && t - trail[0].t > FLING_WINDOW_MS) trail.shift()
      if (onEnd) hintSnap(zoneAt(lastX, lastY))
      /**
       * Both hands pinching means this is not a drag.
       *
       * One pinch is a grab. Two is somebody doing something two-handed, and
       * whichever hand happened to press first should not be hauling the blade
       * around underneath it — the result is a blade that lurches away while
       * you are trying to do something else with both hands.
       *
       * Suppressed by re-anchoring rather than by returning early. A plain
       * return would leave the origin where the press began, so the moment one
       * hand released, the blade would leap by however far the other hand had
       * travelled in the meantime. Moving the origin with the hand keeps the
       * offset constant, so letting go of one hand simply resumes from here.
       */
      if (ev.pointerType === 'touch' && pinchCount() > 1) {
        baseX = ev.clientX - dx
        baseY = ev.clientY - dy
        return
      }
      dx = ev.clientX - baseX
      dy = ev.clientY - baseY
      onMove(dx, dy)
    }
    const done = () => {
      if (onEnd) {
        hintSnap(null)
        onEnd(lastX, lastY, { ...peakVelocity(trail, performance.now()), kind })
      }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', done)
      window.removeEventListener('pointercancel', done)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', done)
    window.addEventListener('pointercancel', done)
  }

  /**
   * Let go of a dragged blade at the edge of the screen and it snaps there:
   * left or right edge takes that half, the top edge takes the whole screen.
   * Two blades side by side is the layout people actually want, and arranging
   * it by hand to the pixel is not something a hand cursor is good at.
   */
  const snap = (x: number, y: number, v: Fling) => {
    // A hard sideways flick by hand throws it away, even if it ends at an edge:
    // snapping is a slow, deliberate drag, and a real flick always overshoots.
    // Only for the hand: a quick mouse drag should never lose a blade.
    if (v.kind === 'touch' && Math.abs(v.vx) > FLING_CLOSE && Math.abs(v.vx) > Math.abs(v.vy) * 1.5) {
      onThrow(v.vx < 0 ? 'left' : 'right')
      return
    }
    const zone = zoneAt(x, y)
    if (!zone) {
      // Anything gentler glides.
      if (Math.hypot(v.vx, v.vy) > GLIDE_MIN) glide(v.vx, v.vy)
      return
    }
    if (zone === 'top') {
      setSize(null)
      setPos({ x: 0, y: 0 })
      onExpand()
      return
    }
    const W = window.innerWidth
    const H = window.innerHeight
    // Clear of the title above and the dock below.
    setSize({ w: W * 0.48, h: H * 0.8 })
    setPos({ x: (zone === 'left' ? -1 : 1) * W * 0.25, y: -H * 0.02 })
  }

  /**
   * Let go mid-swing and the blade keeps moving, slowing as it goes, and
   * bounces softly off the screen edges. Borrowed from holo-gestures (MIT,
   * Zubair Trabzada): positioning a blade by hand is far easier as a toss
   * than as a drag that has to stop on the exact pixel.
   */
  const glideRaf = useRef(0)
  const stopGlide = () => cancelAnimationFrame(glideRaf.current)
  useEffect(() => stopGlide, [])
  const glide = (vx0: number, vy0: number) => {
    stopGlide()
    let vx = vx0
    let vy = vy0
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.min(40, now - last)
      last = now
      const r = shell.current?.getBoundingClientRect()
      if (r) {
        const W = window.innerWidth
        const H = window.innerHeight
        // Keep at least most of it on screen.
        if ((r.left < -r.width * 0.3 && vx < 0) || (r.right > W + r.width * 0.3 && vx > 0)) vx = -vx * 0.4
        if ((r.top < 0 && vy < 0) || (r.bottom > H + r.height * 0.2 && vy > 0)) vy = -vy * 0.4
      }
      setPos((p) => ({ x: p.x + vx * dt, y: p.y + vy * dt }))
      const k = Math.pow(GLIDE_FRICTION, dt / 16)
      vx *= k
      vy *= k
      if (Math.hypot(vx, vy) > 0.02) glideRaf.current = requestAnimationFrame(step)
    }
    glideRaf.current = requestAnimationFrame(step)
  }

  const onHeadDown = (e: React.PointerEvent) => {
    // Buttons live in the header too; starting a drag from one would mean the
    // click never lands.
    if ((e.target as HTMLElement).closest('button')) return
    if (!focused) onFocus()
    if (expanded || tile) return
    const from = { ...pos }
    grab(e, (dx, dy) => setPos({ x: from.x + dx, y: from.y + dy }), snap)
  }

  /**
   * Pinch anywhere on a blade to grab it.
   *
   * This used to scroll, and moving a blade was possible only by hitting the
   * header — a strip 31 pixels tall. Asking someone to land a hand cursor on 31
   * pixels is not an interaction, and since a pinch on the body scrolled
   * instead, there was in practice no way to move a blade by hand at all.
   *
   * Grabbing is also what people try first: you see a thing and reach for it.
   * So a pinch anywhere picks the blade up, and scrolling moves to a pose that
   * is deliberate and hard to make by accident — two fingers, see the effect
   * below. Only for 'touch', which is what the gesture layer dispatches; a mouse
   * keeps its wheel and its ability to select text.
   */
  const onBodyDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'touch') return
    if (!focused) onFocus()
    if (expanded || tile) return
    const from = { ...pos }
    grab(e, (dx, dy) => setPos({ x: from.x + dx, y: from.y + dy }), snap)
  }

  /**
   * Two fingers up, moved up or down, scrolls the front blade.
   *
   * Reads a distance from hands.ts and decides here that it means scrolling —
   * the tracker publishes the pose, not the consequence.
   */
  useEffect(() => {
    if (!focused) return
    let raf = 0
    let last: number | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const travelled = peaceScroll()
      if (travelled === null) {
        last = null
        return
      }
      if (last === null) {
        last = travelled
        return
      }
      // Inverted and amplified: pulling your hand up moves you down the page,
      // and a hand does not have the travel a scroll wheel does.
      scrollContent((last - travelled) * 2.4)
      last = travelled
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [focused])

  /**
   * Two fists, pulled apart, to resize the blade.
   *
   * Close both hands and move them apart and the blade grows; bring them
   * together and it shrinks; lean toward the camera and it grows too, because
   * leaning in enlarges everything about the hands including the gap between
   * them.
   *
   * This is the third gesture in the slot. A two-handed pinch came first and
   * collided with grabbing, since a pinch is how you pick a blade up. Framing
   * an L-corner with each hand replaced it and collided with nothing, but it
   * only reads when both palms face the lens, which is not where hands sit
   * when you are pulling something wider. A closed hand looks closed from
   * every angle.
   *
   * The measurement arrives as a plain distance; that it means a resize is
   * decided here. Only the focused blade, and never while expanded, where the
   * size is the entire point of the state.
   */
  useEffect(() => {
    if (!focused || expanded) return
    let raf = 0
    let from: { span: number; w: number; h: number } | null = null
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const span = fistSpan()
      if (span === null) {
        from = null
        return
      }
      const box = shell.current?.getBoundingClientRect()
      if (!box) return
      if (!from) {
        // Both fists have just appeared. Anchor on the size as it is now.
        from = { span, w: box.width, h: box.height }
        return
      }
      // Guard the divisor: hands almost touching would send the scale to
      // infinity and the blade off the screen in one frame.
      const k = span / Math.max(from.span, 40)
      setSize({
        w: Math.max(280, Math.min(window.innerWidth * 0.96, from.w * k)),
        h: Math.max(180, Math.min(window.innerHeight * 0.94, from.h * k)),
      })
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [focused, expanded])

  /**
   * The overview scales each blade to fit its cell, so it needs the blade's
   * own size — offsetWidth, which transforms do not touch, so the scale being
   * applied cannot feed back into the measurement of what to scale.
   */
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    if (!tile || !shell.current) return
    setNatural({ w: shell.current.offsetWidth, h: shell.current.offsetHeight })
  }, [tile, size])

  const tileScale =
    tile && natural ? Math.min(tile.w / natural.w, tile.h / natural.h, 1) * 0.92 : 1

  const onGrip = (e: React.PointerEvent) => {
    const box = shell.current?.getBoundingClientRect()
    if (!box) return
    const from = { w: box.width, h: box.height }
    grab(e, (dx, dy) =>
      setSize({
        w: Math.max(280, Math.min(window.innerWidth * 0.96, from.w + dx)),
        h: Math.max(180, Math.min(window.innerHeight * 0.94, from.h + dy)),
      }),
    )
  }

  /**
   * Resize from the bottom-right grip.
   *
   * Pointer capture rather than window listeners: the pointer spends most of a
   * resize over an <iframe>, and an iframe swallows mousemove from the parent
   * document entirely. Without capture the blade stops resizing the instant the
   * cursor crosses into the article it is showing, which is precisely where it
   * always crosses.
   */
  return (
    /**
     * Two elements, because two different things want the transform.
     *
     * The outer one carries the depth offset — the small lift and scale that
     * makes the stack read as objects rather than as a list. The inner one is
     * what the user drags. Framer owns `transform` on anything it animates, so
     * with both jobs on one element the drag and the stack animation overwrite
     * each other every frame and the blade jitters back to its slot.
     */
    <motion.div
      className="bl-slot"
      initial={{ opacity: 0, y: 26, scale: 0.96, filter: 'blur(6px)' }}
      animate={
        tile
          ? { opacity: 1, x: tile.x, y: tile.y, scale: tileScale, filter: 'blur(0px)' }
          : {
              opacity: expanded || depth === 0 ? 1 : Math.max(0.3, 1 - depth * 0.24),
              y: expanded ? 0 : depth * -13,
              x: expanded ? 0 : depth * 15,
              scale: expanded ? 1 : 1 - depth * 0.035,
              filter: depth === 0 || expanded ? 'blur(0px)' : `blur(${depth * 0.7}px)`,
            }
      }
      // Swiped away: it leaves the way the hand threw it.
      exit={
        exitDir
          ? {
              opacity: 0,
              x: (exitDir === 'left' ? -1 : 1) * window.innerWidth * 0.7,
              rotate: exitDir === 'left' ? -8 : 8,
              filter: 'blur(4px)',
              transition: { duration: 0.32, ease: [0.4, 0, 1, 1] },
            }
          : { opacity: 0, y: 18, scaleY: 0.02, filter: 'blur(8px)', transition: { duration: 0.28 } }
      }
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
      style={{ zIndex: expanded ? 60 : tile ? 40 : 40 - depth }}
    >
      <motion.section
        ref={shell}
        data-blade={blade.id}
        className={
          `bl bl-${blade.size}` +
          (expanded ? ' bl-expanded' : '') +
          (focused && !tile ? ' bl-front' : '') +
          (tile ? ' bl-tile' : '')
        }
        // Position and size are ours rather than framer's — see `grab` above for
        // why. Applied as a plain transform because the depth animation lives on
        // the slot wrapper, so nothing is competing for this element's own one.
        style={{
          ...(size && !expanded ? { width: size.w, height: size.h } : null),
          // In the overview the tile decides where it is; its own drag offset
          // waits until it is back in the stack.
          transform: expanded || tile ? undefined : `translate(${pos.x}px, ${pos.y}px)`,
        }}
        // pointerdown, not mousedown: a hand dispatches PointerEvents, and a
        // mousedown handler simply never hears them. Focusing a blade by pinch
        // was silently impossible until this changed.
        onPointerDown={() => {
          if (!focused) onFocus()
        }}
      >
        <span className="pk pk-tl" />
        <span className="pk pk-tr" />
        <span className="pk pk-bl" />
        <span className="pk pk-br" />
        <span className="bl-scan" aria-hidden="true" />
        <span className="bl-trace" aria-hidden="true" />

        <header className="bl-head" onPointerDown={onHeadDown}>
          <span className="bl-title">{blade.title}</span>
          <span className="bl-kind">{blade.kind}</span>
          <span className="bl-acts">
            {(size || pos.x || pos.y) && !expanded && (
              <button
                className="bl-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  setSize(null)
                  setPos({ x: 0, y: 0 })
                }}
                title="Back where it started"
              >
                ⤾
              </button>
            )}
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onMinimise()
              }}
              title="Hide in the dock (H)"
            >
              –
            </button>
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onExpand()
              }}
              title={expanded ? 'Shrink (E)' : 'Full screen (E)'}
            >
              {expanded ? '⤡' : '⤢'}
            </button>
            <button
              className="bl-btn"
              onClick={(e) => {
                e.stopPropagation()
                onClose()
              }}
              title="Close (X)"
            >
              ✕
            </button>
          </span>
        </header>

        <div className="bl-body" ref={body} onPointerDown={onBodyDown}>
          <Body blade={blade} />
        </div>

        {/* Resize grip. Absent while expanded, where the size is the point. */}
        {!expanded && !tile && <span className="bl-grip" onPointerDown={onGrip} title="Drag to resize" />}

        {/* In the overview the whole tile is one button: pick this one. A
            cover rather than a handler on the blade, so a press cannot land
            on a link or an iframe inside it instead. */}
        {tile && (
          <button
            className="bl-pick"
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onPick()
            }}
            title={`Open ${blade.title}`}
          />
        )}
      </motion.section>
    </motion.div>
  )
}

/* ------------------------------------------------------------------- stack */

/** Overview cells, as offsets from the centre of the screen. */
function tilesFor(n: number): Tile[] {
  const W = window.innerWidth
  const H = window.innerHeight
  const cols = Math.ceil(Math.sqrt(n * (W / H) / 1.4))
  const rows = Math.ceil(n / cols)
  // Leave room for the rails at the sides and the dock at the bottom.
  const areaW = W * 0.86
  const areaH = H * 0.74
  const w = areaW / cols
  const h = areaH / rows
  return Array.from({ length: n }, (_, i) => {
    const r = Math.floor(i / cols)
    // The last row, if short, is centred rather than left-aligned.
    const inRow = r === rows - 1 ? n - r * cols : cols
    const c = i % cols
    return {
      x: (c - (inRow - 1) / 2) * w,
      y: (r - (rows - 1) / 2) * h - H * 0.03,
      w,
      h,
    }
  })
}

export function Blades() {
  const blades = useStore((s) => s.blades)
  const focusedBlade = useStore((s) => s.focusedBlade)
  const expandedBlade = useStore((s) => s.expandedBlade)
  const overview = useStore((s) => s.bladeOverview)
  const focusBlade = useStore((s) => s.focusBlade)
  const expandBlade = useStore((s) => s.expandBlade)
  const closeBlade = useStore((s) => s.closeBlade)
  const minimiseBlade = useStore((s) => s.minimiseBlade)
  const closeAll = useStore((s) => s.closeAllBlades)
  const setOverview = useStore((s) => s.setBladeOverview)

  /** Which way each swiped blade is leaving, read by its exit animation. */
  const [exitDirs, setExitDirs] = useState<Record<string, 'left' | 'right'>>({})
  const [snapZone, setSnapZone] = useState<SnapZone>(null)

  // Forget exit directions once their blades are gone.
  useEffect(() => {
    setExitDirs((d) => {
      const alive = Object.keys(d).filter((id) => blades.some((b) => b.id === id))
      return alive.length === Object.keys(d).length ? d : Object.fromEntries(alive.map((id) => [id, d[id]]))
    })
  }, [blades])

  const shown = useMemo(() => blades.filter((b) => !b.minimised), [blades])
  const docked = useMemo(() => blades.filter((b) => b.minimised), [blades])

  /**
   * Newest first, then whichever the user pulled forward lifted to the front.
   *
   * Ordered here rather than in the store because it is a view concern, and the
   * store's array order is the history — which is what makes "the one before
   * that" a meaningful thing to ask for.
   */
  const ordered = useMemo(() => {
    const newestFirst = [...shown].reverse()
    if (!focusedBlade) return newestFirst
    const hit = newestFirst.findIndex((b) => b.id === focusedBlade)
    if (hit <= 0) return newestFirst
    const copy = [...newestFirst]
    const [lifted] = copy.splice(hit, 1)
    return [lifted, ...copy]
  }, [shown, focusedBlade])

  const front = ordered[0]

  const cycle = useCallback(
    (by: number) => {
      if (ordered.length < 2) return
      const at = ordered.findIndex((b) => b.id === front?.id)
      const next = ordered[(at + by + ordered.length) % ordered.length]
      if (next) focusBlade(next.id)
    },
    [ordered, front, focusBlade],
  )

  /** Close one, thrown the way it was swiped. */
  const throwAway = useCallback(
    (id: string, dir: 'left' | 'right') => {
      setExitDirs((d) => ({ ...d, [id]: dir }))
      // A frame later, so the card has re-rendered with its exit direction
      // before AnimatePresence takes its last snapshot of it.
      requestAnimationFrame(() => closeBlade(id))
    },
    [closeBlade],
  )

  /**
   * Swipe an open hand across a blade to throw it away. A swipe that starts
   * somewhere else flips through the stack instead — left for the next one,
   * right for the one before.
   */
  useEffect(() => {
    const onSwipe = (e: Event) => {
      const { dir, x, y } = (e as CustomEvent<SwipeDetail>).detail
      const hit = document.elementFromPoint(x, y)?.closest('[data-blade]')
      const id = hit?.getAttribute('data-blade')
      if (id) throwAway(id, dir)
      else if (!overview) cycle(dir === 'left' ? 1 : -1)
    }
    window.addEventListener('hand-swipe', onSwipe)
    return () => window.removeEventListener('hand-swipe', onSwipe)
  }, [throwAway, cycle, overview])

  useEffect(() => {
    const onHint = (e: Event) => setSnapZone((e as CustomEvent<SnapZone>).detail)
    window.addEventListener('blade-snap-hint', onHint)
    return () => window.removeEventListener('blade-snap-hint', onHint)
  }, [])

  // Bound here rather than in App, and only while something is open, so these
  // keys are free for anything else the moment the last blade closes.
  const live = useRef(false)
  live.current = blades.length > 0

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!live.current) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return

      if (e.key === 'e') {
        e.preventDefault()
        expandBlade(expandedBlade ? null : (front?.id ?? null))
      } else if (e.key === 'X') {
        e.preventDefault()
        closeAll()
      } else if (e.key === 'x') {
        e.preventDefault()
        if (front) closeBlade(front.id)
      } else if (e.key === 'h') {
        e.preventDefault()
        if (front) minimiseBlade(front.id, true)
      } else if (e.key === 'o') {
        e.preventDefault()
        setOverview(!overview && shown.length > 1)
      } else if (e.key === 'Escape' && overview) {
        e.preventDefault()
        setOverview(false)
      } else if (e.key === ']') {
        e.preventDefault()
        cycle(1)
      } else if (e.key === '[') {
        e.preventDefault()
        cycle(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [front, expandedBlade, expandBlade, closeBlade, closeAll, minimiseBlade, setOverview, overview, shown, cycle])

  if (!blades.length) return null

  // In the overview, laid out oldest to newest, reading order.
  const tiles = overview ? tilesFor(shown.length) : []
  const tileOf = (id: string) => {
    const at = shown.findIndex((b) => b.id === id)
    return overview && at !== -1 ? tiles[at] : null
  }

  return (
    <div
      className={
        'blades-stack' +
        (expandedBlade ? ' blades-stack-full' : '') +
        (overview ? ' blades-stack-overview' : '')
      }
    >
      {snapZone && <div className={`bl-snap-hint bl-snap-${snapZone}`} />}
      {/* Behind the tiles: dims the rest, and a press on it backs out. */}
      {overview && <div className="bl-backdrop" onPointerDown={() => setOverview(false)} />}

      <AnimatePresence>
        {ordered.map((blade, i) => {
          const expanded = expandedBlade === blade.id
          // While one is expanded it is the only thing on screen; the rest are
          // unmounted rather than hidden so their iframes stop loading.
          if (expandedBlade && !expanded) return null
          return (
            <Card
              key={blade.id}
              blade={blade}
              depth={expanded ? 0 : i}
              focused={blade.id === front?.id}
              expanded={expanded}
              tile={tileOf(blade.id)}
              exitDir={exitDirs[blade.id]}
              onFocus={() => focusBlade(blade.id)}
              onExpand={() => expandBlade(expanded ? null : blade.id)}
              onClose={() => closeBlade(blade.id)}
              onMinimise={() => minimiseBlade(blade.id, true)}
              onThrow={(dir) => throwAway(blade.id, dir)}
              onPick={() => {
                focusBlade(blade.id)
                setOverview(false)
              }}
            />
          )
        })}
      </AnimatePresence>

      {!expandedBlade && (
        <div className="bl-dock">
          {shown.length > 1 && (
            <button
              className={`bl-dock-btn${overview ? ' on' : ''}`}
              onClick={() => setOverview(!overview)}
              title="See them all (O)"
            >
              ▦ {overview ? 'back' : 'all'}
            </button>
          )}
          <button className="bl-dock-btn" onClick={closeAll} title="Close every blade (Shift X)">
            ✕ clear
          </button>
          {docked.map((b) => (
            <button
              key={b.id}
              className="bl-chip"
              onClick={() => minimiseBlade(b.id, false)}
              title={`Bring back ${b.title}`}
            >
              <span className="bl-chip-dot" />
              {b.title}
            </button>
          ))}
          <span className="bl-dock-keys">
            {shown.length > 1 && (
              <>
                <kbd>[</kbd> <kbd>]</kbd> cycle ·{' '}
              </>
            )}
            <kbd>E</kbd> full · <kbd>H</kbd> hide · <kbd>X</kbd> close
          </span>
        </div>
      )}
    </div>
  )
}

/* --------------------------------------------------------------- the sweep */

/**
 * The original blades: slivers of light raking across the frame while a tool
 * runs. Unchanged, because it is still the right answer to "something is
 * happening" — a tool call is the one moment the interface stops being a face
 * and becomes machinery, and the reactor cannot carry that on its own.
 *
 * Deliberately CSS rather than three.js: the scene is bloomed and tone-mapped,
 * which is exactly wrong for a 1px edge. Kept in the DOM it stays a blade.
 */
const SWEEP = [1, 2, 3, 4, 5, 6]

export function BladeSweep() {
  const phase = useStore((s) => s.phase)
  const activeTool = useStore((s) => s.activeTool)

  return (
    <AnimatePresence>
      {phase === 'tooling' && (
        <motion.div
          className="blades"
          // Only opacity is animated here. The sweeps are CSS keyframes on the
          // children, and framer writes `transform` inline on anything it
          // animates — one transform prop in this list and every blade would be
          // sliding inside an element that is itself sliding.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
        >
          <div className="blade-field">
            {SWEEP.map((n) => (
              <span key={n} className={`blade blade-${n}`} />
            ))}
          </div>

          {activeTool && (
            // Keyed on the name so a chain of tools re-runs the ride-in for
            // each one rather than silently swapping the text mid-sweep.
            <div className="blade-carrier">
              <span key={activeTool} className="blade-tool">
                {activeTool}
              </span>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
