import { useStore, type Turn } from '../store'
import { pickSecondScreen, type ScreenRect } from './holo'

/**
 * Dual screen: the holo desk in its own window on the other monitor, while
 * JARVIS himself stays where he is.
 *
 * The second window is the same page opened with ?holo=1, which renders only
 * the desk — no voice, no wake word, no second JARVIS listening to the room.
 * It has no conversation of its own, so this window mirrors what the desk shows
 * (the conversation, the phase, the voice, the links) to it over a
 * BroadcastChannel. Same origin, same machine, nothing leaves the browser.
 *
 * Placement uses the Window Management API: getScreenDetails() lists the
 * screens with their positions, and window.open puts the new window on the one
 * chosen. scripts/jarvis.sh grants this page that permission, and pop-ups,
 * ahead of time, because a voice command is not a click and both would
 * otherwise be refused.
 */

const CHANNEL = 'jarvis-holo'
const WINDOW_NAME = 'jarvis-holo'
export const HOLO_ONLY_PARAM = 'holo'

/** What the desk window shows from the main one. */
export interface Mirror {
  turns: Turn[]
  phase: string
  voice: string
  connected: string[]
}

type Message = { type: 'hello' } | { type: 'mirror'; state: Mirror }

/** The parts of the Window Management API used here; not yet in lib.dom. */
interface ScreenDetailed extends ScreenRect {
  availLeft: number
  availTop: number
  availWidth: number
  availHeight: number
}
interface ScreenDetails {
  screens: ScreenDetailed[]
  currentScreen: ScreenDetailed
}
type WithScreens = Window & { getScreenDetails?: () => Promise<ScreenDetails> }

let desk: Window | null = null
let stopMirroring: (() => void) | null = null

export type PlaceResult = { placed: true } | { placed: false; reason: string }

/** Open the holo desk on the other screen. Says why when it cannot. */
export async function openHoloOnSecondScreen(): Promise<PlaceResult> {
  const w = window as WithScreens
  if (!w.getScreenDetails) {
    return { placed: false, reason: 'This browser cannot place windows on another screen.' }
  }
  let details: ScreenDetails
  try {
    details = await w.getScreenDetails()
  } catch {
    return { placed: false, reason: 'Permission to use the other screen was refused.' }
  }
  const target = pickSecondScreen(details.screens, details.currentScreen)
  if (!target) return { placed: false, reason: 'Only one screen is connected.' }

  const url = `${location.origin}/?${HOLO_ONLY_PARAM}=1`
  const features =
    `popup,left=${target.availLeft},top=${target.availTop},` +
    `width=${target.availWidth},height=${target.availHeight}`
  const opened = window.open(url, WINDOW_NAME, features)
  if (!opened) return { placed: false, reason: 'The browser blocked the second window.' }
  desk = opened
  startMirroring()
  return { placed: true }
}

/** Close the desk window, if this window opened one. */
export function closeHoloWindow(): void {
  desk?.close()
  desk = null
  stopMirroring?.()
  stopMirroring = null
}

function snapshot(): Mirror {
  const s = useStore.getState()
  return { turns: s.turns, phase: s.phase, voice: s.voice, connected: s.connected }
}

/** In the main window: send the desk what it shows, now and on every change. */
function startMirroring(): void {
  if (stopMirroring) return
  const channel = new BroadcastChannel(CHANNEL)
  const post = () => channel.postMessage({ type: 'mirror', state: snapshot() } satisfies Message)
  // The desk says hello once it has loaded; answer with the current state.
  channel.onmessage = (e: MessageEvent<Message>) => {
    if (e.data?.type === 'hello') post()
  }
  const unsubscribe = useStore.subscribe((s, prev) => {
    if (
      s.turns !== prev.turns ||
      s.phase !== prev.phase ||
      s.voice !== prev.voice ||
      s.connected !== prev.connected
    ) {
      post()
    }
  })
  stopMirroring = () => {
    unsubscribe()
    channel.close()
  }
}

/** In the desk window: take what the main window sends. Returns a stop function. */
export function followMainWindow(): () => void {
  const channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (e: MessageEvent<Message>) => {
    if (e.data?.type !== 'mirror') return
    const { turns, phase, voice, connected } = e.data.state
    useStore.setState({
      turns,
      voice,
      connected,
      phase: phase as ReturnType<typeof useStore.getState>['phase'],
    })
  }
  channel.postMessage({ type: 'hello' } satisfies Message)
  return () => channel.close()
}

/** Whether this page was opened as the desk window. */
export const isHoloOnly = (): boolean =>
  new URLSearchParams(location.search).get(HOLO_ONLY_PARAM) === '1'
