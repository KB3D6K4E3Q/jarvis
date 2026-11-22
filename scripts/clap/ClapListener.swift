// Clap three times to start JARVIS.
//
// A tiny background app that listens to the microphone and, on three claps,
// runs `scripts/jarvis.sh start`. Built and installed by scripts/clap.sh, which
// also registers it to run at login. Nothing is recorded or sent anywhere: each
// buffer is reduced to a peak level and thrown away.
//
// Same idea as src/lib/clap.ts: a clap is not loud, it is SHARP — quiet before,
// a near-instant rise, and gone again within a tenth of a second. Three of those,
// evenly spaced, a fraction of a second apart, is something a room never does by itself.

import AVFoundation
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
func log(_ s: String) { print("[clap] \(s)") }

guard CommandLine.arguments.count > 1 else {
  log("usage: ClapListener /path/to/jarvis.sh")
  exit(2)
}
let jarvisScript = CommandLine.arguments[1]

/** A candidate must be this many times the room's background level... */
let PEAK_OVER_FLOOR: Float = 12
/** ...and at least this loud in absolute terms. */
let MIN_PEAK: Float = 0.3
/** The blocks just before a clap must be under this fraction of its peak. */
let QUIET_BEFORE: Float = 0.15
/** Confirmed once it falls below this fraction of the peak... */
let DECAY_TO: Float = 0.25
/** ...within this long. Speech, music and doors do not collapse this fast. */
let DECAY_S = 0.1
/** How many claps start him. Two let a bottle set down on a table (thud, bounce) through. */
let CLAPS_NEEDED = 3
/** Each clap must land this long after the one before. */
let PAIR_MIN_S = 0.15, PAIR_MAX_S = 0.7
/**
 * People clap at an even pace; something bouncing speeds up as it settles.
 * The longest gap between claps may be at most this many times the shortest.
 */
let RHYTHM_RATIO = 1.5
/** All the claps must be this close in loudness (loudest / quietest). */
let PAIR_RATIO: Float = 2.5
/**
 * A film or a game is full of sharp sounds, but they come in the middle of
 * other sound. Real claps are surrounded by a quiet room, so demand
 * quiet for this long before the first clap and after the last.
 */
let SILENT_BEFORE_S = 0.5, SILENT_AFTER_S = 0.5
/** "Quiet" around the pair means under this fraction of the claps' peak. */
let SILENT_LEVEL: Float = 0.15
/**
 * How long the sound must actually ring: the time the fine-grained level stays
 * above a quarter of its loudest. Measured on this Mac, claps ran 2 to 14 ms
 * (mostly 10 to 14); a click is about a millisecond. Mouse clicks were also
 * far quieter (0.07) than the softest clap (0.97), which MIN_PEAK relies on.
 */
let MIN_BODY_S = 0.002
/**
 * ...and at least one of the claps must ring this long. A finger snap is as
 * sharp as a clap but shorter: snaps measured 3 to 4.4 ms here, while every
 * real double clap had at least one clap of 10 ms or more.
 */
let PAIR_BODY_S = 0.008
/** Log every sharp sound and why it was or wasn't a clap (JARVIS_CLAP_DEBUG=0 to quiet it). */
let DEBUG = ProcessInfo.processInfo.environment["JARVIS_CLAP_DEBUG"] != "0"
/** After a start, ignore claps for this long. */
let RETRIGGER_S = 15.0

final class Detector {
  var floor: Float = 0.01
  /** Recent block peaks, with the time each ended. */
  var history: [(t: Double, p: Float)] = []
  var candPeak: Float = 0, candStart: Double = -1
  /** The candidate's fine-grained levels and energy, for its length and tone. */
  var candSubs: [Float] = [], candE: Float = 0, candDE: Float = 0
  var cooldownUntil: Double = 0
  /** The claps so far in the current run. */
  var run: [(t: Double, p: Float, body: Double)] = []
  /** The length of the last sound isClap() measured. */
  var lastBody: Double = 0
  /** A pair that has happened, waiting to see the room go quiet after it. */
  var pending: (t: Double, p: Float)? = nil
  var lastTrigger: Double = -100
  let onDouble: () -> Void
  let subS: Double, rate: Double
  init(subS: Double, rate: Double, onDouble: @escaping () -> Void) {
    self.subS = subS; self.rate = rate; self.onDouble = onDouble
  }

  func loudest(since t0: Double, before t1: Double) -> Float {
    history.lazy.filter { $0.t >= t0 && $0.t < t1 }.map(\.p).max() ?? 0
  }

  /**
   * One block of audio: its peak, the RMS of each short slice inside it, its
   * energy and the energy of its first difference (which weights treble).
   */
  func feed(peak p: Float, subs: [Float], e: Float, de: Float, at t: Double) {
    defer {
      history.append((t, p))
      while let h = history.first, h.t < t - 1.0 { history.removeFirst() }
    }
    if let pend = pending {
      if p > pend.p * SILENT_LEVEL {
        pending = nil  // more sound right after: part of something else
      } else if t - pend.t >= SILENT_AFTER_S {
        pending = nil
        if t - lastTrigger > RETRIGGER_S {
          lastTrigger = t
          onDouble()
        }
      }
    }
    if candStart >= 0 {
      candPeak = max(candPeak, p)
      candSubs += subs; candE += e; candDE += de
      if p < candPeak * DECAY_TO {
        if t - candStart <= DECAY_S && isClap() { clap(peak: candPeak, start: candStart, at: t) }
        candStart = -1
        cooldownUntil = t + 0.08
      } else if t - candStart > DECAY_S {
        candStart = -1  // sustained: a voice, music, a door. Not a clap.
        run = []
        cooldownUntil = t + 0.3
      }
      return
    }
    let before = loudest(since: t - 0.03, before: t)
    if t >= cooldownUntil, p > max(floor * PEAK_OVER_FLOOR, MIN_PEAK), before < p * QUIET_BEFORE {
      candPeak = p
      candStart = t
      candSubs = subs; candE = e; candDE = de
      return
    }
    // Track the room slowly so a noisy room does not turn every sound into a clap.
    floor = max(0.002, floor * 0.995 + min(p, floor * 4) * 0.005)
  }

  /** Long enough to be a hand, not a mouse button. */
  func isClap() -> Bool {
    let top = candSubs.max() ?? 0
    let body = Double(candSubs.filter { $0 > top * 0.25 }.count) * subS
    lastBody = body
    let ok = body >= MIN_BODY_S
    if DEBUG {
      // de/e = 4 sin²(πf/fs) for a tone of frequency f: a rough centre of the sound.
      let x = min(1, Double((candDE / max(candE, 1e-9)).squareRoot() / 2))
      let tone = rate / .pi * asin(x)
      log(String(format: "sound: peak %.2f, body %.1f ms, tone %.1f kHz -> %@",
                 candPeak, body * 1000, tone / 1000, ok ? "clap" : "too short (click?)"))
    }
    return ok
  }

  func clap(peak: Float, start: Double, at t: Double) {
    pending = nil
    let me = (t: start, p: peak, body: lastBody)
    if let last = run.last {
      let gap = start - last.t
      let all = run + [me]
      let ratio = all.map(\.p).max()! / all.map(\.p).min()!
      // Between claps the room must drop back to quiet.
      let between = loudest(since: last.t + DECAY_S, before: start - 0.02)
      if gap >= PAIR_MIN_S, gap <= PAIR_MAX_S, ratio <= PAIR_RATIO,
         between < min(peak, last.p) * SILENT_LEVEL {
        run.append(me)
        if run.count == CLAPS_NEEDED {
          let gaps = zip(run.dropFirst(), run).map { $0.t - $1.t }
          let even = gaps.max()! / gaps.min()! <= RHYTHM_RATIO
          let rings = run.map(\.body).max()! >= PAIR_BODY_S
          if DEBUG && !(even && rings) {
            log(even ? "\(CLAPS_NEEDED) sounds, but none rang long enough (snaps?)"
                     : "\(CLAPS_NEEDED) sounds, but the rhythm was uneven (bouncing?)")
          }
          if even && rings { pending = (t, all.map(\.p).max()!) }
          run = []
        }
        return
      }
    }
    // A first clap only counts if the room was quiet before it.
    let earlier = loudest(since: start - SILENT_BEFORE_S, before: start - 0.02)
    run = earlier < peak * SILENT_LEVEL ? [me] : []
  }
}

func startJarvis() {
  log("\(CLAPS_NEEDED) claps — starting JARVIS")
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/bin/bash")
  p.arguments = [jarvisScript, "start"]
  do { try p.run() } catch { log("could not run jarvis.sh: \(error)") }
}

var detector: Detector? = nil
/** Loudest level since the last report, so the log shows the mic is alive. */
var loudestHeard: Float = 0
let engine = AVAudioEngine()
var clock: Double = 0

func startEngine() {
  engine.stop()
  let input = engine.inputNode
  input.removeTap(onBus: 0)
  let format = input.outputFormat(forBus: 0)
  guard format.sampleRate > 0, format.channelCount > 0 else {
    log("no microphone available; retrying shortly")
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { startEngine() }
    return
  }
  let block = 256, sub = 32
  let blockS = Double(block) / format.sampleRate
  let d = detector ?? Detector(subS: Double(sub) / format.sampleRate, rate: format.sampleRate,
                               onDouble: startJarvis)
  detector = d
  var prev: Float = 0
  input.installTap(onBus: 0, bufferSize: 1024, format: format) { buf, _ in
    guard let ch = buf.floatChannelData?[0] else { return }
    let n = Int(buf.frameLength)
    var i = 0
    while i < n {
      let end = min(i + block, n)
      var peak: Float = 0, e: Float = 0, de: Float = 0
      var subs: [Float] = []
      var j = i
      while j < end {
        let sEnd = min(j + sub, end)
        var se: Float = 0
        for k in j..<sEnd {
          let x = ch[k]
          peak = max(peak, abs(x))
          se += x * x
          de += (x - prev) * (x - prev)
          prev = x
        }
        e += se
        subs.append((se / Float(sEnd - j)).squareRoot())
        j = sEnd
      }
      loudestHeard = max(loudestHeard, peak)
      d.feed(peak: peak, subs: subs, e: e, de: de, at: clock)
      clock += blockS
      i = end
    }
  }
  do {
    try engine.start()
    log("listening (\(Int(format.sampleRate)) Hz)")
  } catch {
    log("could not start the microphone: \(error); retrying shortly")
    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { startEngine() }
  }
}

// Headphones plugged in, a new default mic: rebuild the tap on the new device.
NotificationCenter.default.addObserver(
  forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
) { _ in
  log("audio device changed")
  startEngine()
}

AVCaptureDevice.requestAccess(for: .audio) { granted in
  DispatchQueue.main.async {
    if granted {
      startEngine()
    } else {
      log("microphone access refused — allow it in System Settings → Privacy & Security → Microphone")
      exit(1)
    }
  }
}

if DEBUG {
  Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
    let l = loudestHeard
    loudestHeard = 0
    if l > 0.03 { log(String(format: "loudest in the last 10 s: %.2f", l)) }
  }
}

RunLoop.main.run()
