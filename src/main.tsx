import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import HoloWindow from './HoloWindow.tsx'
import { isHoloOnly } from './lib/holoWindow'

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
//
// ?holo=1 is the dual-screen desk window: the holo desk alone, with no voice of
// its own, so there is never a second JARVIS listening to the room.
createRoot(document.getElementById('root')!).render(isHoloOnly() ? <HoloWindow /> : <App />)
