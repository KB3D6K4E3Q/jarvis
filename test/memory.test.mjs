import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  conversationMemory,
  flushMemories,
  loadMemories,
  memoryPrompt,
  parseSummary,
  rememberFact,
  saveMemories,
  searchMemories,
  whenSaid,
} from '../bridge/memory.mjs'
import { decideTool } from '../bridge/policy.mjs'

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'jarvis-mem-')), 'memory.json')

test('memory tools are allowed in read-only mode', () => {
  assert.equal(decideTool('mcp__jarvis_memory__memory_save'), true)
  assert.equal(decideTool('mcp__jarvis_memory__memory_forget'), true)
})

test('older memories load, with their session notes recognised', () => {
  const file = tempFile()
  writeFileSync(
    file,
    JSON.stringify([
      { id: 'a', text: 'Spare key is under the blue pot.', saved: 1 },
      { id: 'b', text: 'Previous session: set up OmniRoute.', saved: 2 },
      { id: 'c', text: 'Session summary: practised English.', topic: 'sessions', saved: 3 },
    ]),
  )
  const kinds = loadMemories(file).map((m) => m.kind)
  assert.deepEqual(kinds, ['fact', 'session', 'session'])
})

test('a repeated fact updates the old one instead of adding another', () => {
  const mem = []
  rememberFact(mem, "Ondrej's sister is called Eva.", 'family', 1)
  const { merged } = rememberFact(mem, "Ondrej's sister is called Eva", undefined, 2)
  assert.equal(merged, true)
  assert.equal(mem.length, 1)
  rememberFact(mem, 'Ondrej is learning English.', undefined, 3)
  assert.equal(mem.length, 2)
})

test('search matches word forms and ranks by matches', () => {
  const mem = [
    { id: 'a', kind: 'fact', text: "Ondrej's sister is called Eva.", saved: 1 },
    { id: 'b', kind: 'fact', text: 'The wifi password is on the router.', saved: 2 },
    { id: 'c', kind: 'session', text: 'Practised English past tense.', saved: 3 },
  ]
  assert.equal(searchMemories(mem, "what's my sisters name")[0].id, 'a')
  assert.equal(searchMemories(mem, 'english practice')[0].id, 'c')
  assert.equal(searchMemories(mem, 'zebra').length, 0)
  assert.equal(searchMemories(mem, '')[0].id, 'c')
})

test('the prompt carries facts and recent conversations', () => {
  const file = tempFile()
  const now = new Date(2026, 10, 22, 12).getTime()
  saveMemories(file, [
    { id: 'k1', kind: 'fact', text: 'Ondrej takes his coffee black.', saved: now - 5e8 },
    { id: 's1', kind: 'session', text: 'Session summary: talked about the clap trigger.', saved: now - 86_400_000 },
  ])
  const p = memoryPrompt(file, 'Ondrej', now)
  assert.match(p, /\[k1\] Ondrej takes his coffee black\./)
  assert.match(p, /- yesterday: talked about the clap trigger\./)
  assert.match(memoryPrompt(tempFile(), 'Ondrej', now), /Nothing yet/)
})

test('whenSaid speaks dates', () => {
  const now = new Date(2026, 10, 22, 9).getTime()
  assert.equal(whenSaid(new Date(2026, 10, 22, 1).getTime(), now), 'today')
  assert.equal(whenSaid(new Date(2026, 10, 21, 23).getTime(), now), 'yesterday')
  assert.equal(whenSaid(new Date(2026, 10, 19).getTime(), now), '3 days ago')
  assert.equal(whenSaid(new Date(2026, 10, 4).getTime(), now), 'on 4 November')
})

test('parseSummary tolerates fences and junk', () => {
  assert.deepEqual(parseSummary('```json\n{"summary":"Talked.","facts":["A."]}\n```'), {
    summary: 'Talked.',
    facts: ['A.'],
  })
  assert.equal(parseSummary('no json here'), null)
})

test('a finished conversation is noted, with new facts, once', async () => {
  const file = tempFile()
  let calls = 0
  const convo = conversationMemory({
    file,
    userName: 'Ondrej',
    summariser: async (turns) => {
      calls++
      assert.equal(turns.length, 4)
      return { summary: 'Ondrej planned a trip to Prague.', facts: ['Ondrej has a dog called Rex.'] }
    },
  })
  convo.heard('I want to go to Prague')
  convo.said('When?')
  convo.heard('Next month, with my dog Rex')
  convo.said('Noted.')
  await convo.end()
  await convo.end() // nothing new: no second note
  await flushMemories(1000)
  assert.equal(calls, 1)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(
    saved.map((m) => [m.kind, m.text]),
    [
      ['session', 'Ondrej planned a trip to Prague.'],
      ['fact', 'Ondrej has a dog called Rex.'],
    ],
  )
})

test('a lone greeting is not worth a note', async () => {
  let calls = 0
  const convo = conversationMemory({
    file: tempFile(),
    userName: 'Ondrej',
    summariser: async () => (calls++, { summary: 'x', facts: [] }),
  })
  convo.heard('hello jarvis')
  convo.said('Hello, Ondrej.')
  await convo.end()
  assert.equal(calls, 0)
})
