/**
 * The port the bridge listens on, shared by everything that needs to know it.
 *
 * 8788 rather than the old 8787: 8787 is also the default of other local tools
 * (the Headroom proxy that Claude Code can be routed through, among them), and
 * whichever started first took the port, which left JARVIS silently unable to
 * start. Override with JARVIS_BRIDGE_PORT, and set VITE_BRIDGE_URL to match.
 */
export const BRIDGE_PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8788)
