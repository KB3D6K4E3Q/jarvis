/**
 * Failures that arrive dressed as answers.
 *
 * When the Claude account itself is the problem — the sign-in expired, the key
 * was rejected, the usage limit is spent — the CLI does not fail the turn. It
 * reports a *successful* result whose text is the error, from a synthetic
 * assistant that never streams a word. The bridge used to pass that on as a
 * finished answer with nothing to speak, so JARVIS listened, went quiet and
 * dropped back to standby, and the only trace was one line in a log nobody
 * reads.
 *
 * These are matched on the CLI's own wording, anchored to the start of the
 * text, so an ordinary answer that happens to mention logging in is never
 * mistaken for one.
 */

const ACCOUNT_FAILURES = [
  {
    match: /^(failed to authenticate|oauth (token|session) (has )?expired|invalid api key|authentication_error|not logged in|please run \/login)/i,
    // Every word here is spoken, and the persona must never read a command
    // aloud, so it says what to do rather than what to type.
    say:
      "I've been signed out of my Claude account, sir, so I can't answer. " +
      'Please sign me in again on the Mac, then restart me.',
  },
  {
    match: /^(claude ai )?usage limit reached|^you've hit your (usage )?limit/i,
    say: "I've hit the usage limit on my Claude account, sir. I'll be able to answer again once it resets.",
  },
  {
    match: /^(credit balance is too low|your credit balance)/i,
    say: "My Claude account has run out of credit, sir, so I can't answer until it is topped up.",
  },
]

/**
 * What to say when `text` is an account failure rather than an answer, or
 * null when it is an ordinary answer.
 *
 * @param {string | undefined | null} text the result text of a turn
 * @returns {string | null}
 */
export function accountFailure(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed) return null
  const hit = ACCOUNT_FAILURES.find((f) => f.match.test(trimmed))
  return hit ? hit.say : null
}
