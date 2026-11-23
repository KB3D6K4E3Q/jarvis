import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountFailure } from '../bridge/failures.mjs'

test('recognises an expired sign-in as an account failure', () => {
  const said = accountFailure(
    'Failed to authenticate: OAuth session expired and could not be refreshed',
  )
  assert.match(said, /signed out/i)
})

test('recognises a rejected API key', () => {
  assert.ok(accountFailure('Invalid API key · Please run /login'))
})

test('recognises having no account signed in at all', () => {
  assert.ok(accountFailure('Not logged in · Please run /login'))
})

test('recognises an exhausted usage limit', () => {
  assert.match(accountFailure('Claude AI usage limit reached|1795400000'), /limit/i)
})

test('returns null for an ordinary answer', () => {
  assert.equal(accountFailure('Hello, sir. The weather is fine.'), null)
})

test('returns null for an answer that merely mentions logging in', () => {
  assert.equal(
    accountFailure('You can log in to the router at 192.168.1.1, then check the settings.'),
    null,
  )
})

test('returns null for empty or missing text', () => {
  assert.equal(accountFailure(''), null)
  assert.equal(accountFailure(undefined), null)
})

test('the spoken message carries no command to read aloud', () => {
  const said = accountFailure('Failed to authenticate: OAuth session expired')
  assert.doesNotMatch(said, /claude auth|\/login|`/)
})
