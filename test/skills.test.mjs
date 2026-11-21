import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { customSkillsPrompt, findApp, parseWhen, searchMemories, seedSkills } from '../bridge/skills.mjs'
import { decideTool } from '../bridge/policy.mjs'

test('skills tools are allowed in read-only mode', () => {
  assert.equal(decideTool('mcp__jarvis_skills__timer_set'), true)
  assert.equal(decideTool('mcp__jarvis_skills__memory_save'), true)
  assert.equal(decideTool('mcp__jarvis_skills__mac_open_app'), true)
})

test('parseWhen handles delays and clock times', () => {
  const now = new Date(2026, 10, 21, 14, 0, 0)
  assert.equal(parseWhen({ minutes: 10 }, now), now.getTime() + 600_000)
  assert.equal(parseWhen({ minutes: '1.5' }, now), now.getTime() + 90_000)
  const five = new Date(parseWhen({ at: '5pm' }, now))
  assert.deepEqual([five.getDate(), five.getHours(), five.getMinutes()], [21, 17, 0])
  const morning = new Date(parseWhen({ at: '07:30' }, now))
  assert.deepEqual([morning.getDate(), morning.getHours(), morning.getMinutes()], [22, 7, 30])
  assert.equal(parseWhen({ at: '25:00' }, now), null)
  assert.equal(parseWhen({}, now), null)
})

test('findApp matches spoken names fuzzily', () => {
  const apps = new Map([
    ['spotify', { name: 'Spotify', path: '/Applications/Spotify.app' }],
    ['system settings', { name: 'System Settings', path: '/System/Applications/System Settings.app' }],
    ['google chrome', { name: 'Google Chrome', path: '/Applications/Google Chrome.app' }],
  ])
  assert.equal(findApp('spotify', apps)?.name, 'Spotify')
  assert.equal(findApp('System settings', apps)?.name, 'System Settings')
  assert.equal(findApp('chrome', apps)?.name, 'Google Chrome')
  assert.equal(findApp('photoshop', apps), null)
})

test('searchMemories ranks by matching words', () => {
  const mem = [
    { id: 'a', text: 'Spare key is under the blue pot', topic: 'home', saved: 1 },
    { id: 'b', text: 'Wifi password is on the fridge', topic: 'home', saved: 2 },
    { id: 'c', text: 'Mum birthday is 3 May', topic: 'family', saved: 3 },
  ]
  assert.equal(searchMemories(mem, 'where is the spare key')[0].id, 'a')
  assert.equal(searchMemories(mem, 'wifi')[0].id, 'b')
  assert.equal(searchMemories(mem, 'zebra').length, 0)
  assert.equal(searchMemories(mem, '')[0].id, 'c')
})

test('custom skills folder is seeded and read into the prompt', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'jarvis-skills-')), 'skills')
  seedSkills(dir)
  writeFileSync(join(dir, 'movie-night.md'), 'When: "movie night". Steps: volume 60.')
  const prompt = customSkillsPrompt(dir)
  assert.match(prompt, /### movie-night/)
  assert.match(prompt, /### focus-mode/)
  assert.doesNotMatch(prompt, /HOW-TO/)
  assert.equal(customSkillsPrompt(join(dir, 'missing')), '')
})

test('siteUrl understands names, domains and URLs, and nothing else', async () => {
  const { siteUrl } = await import('../bridge/skills.mjs')
  assert.equal(siteUrl('YouTube'), 'https://www.youtube.com')
  assert.equal(siteUrl('netflix.com'), 'https://www.netflix.com')
  assert.equal(siteUrl('bbc.co.uk'), 'https://bbc.co.uk/')
  assert.equal(siteUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1')
  assert.equal(siteUrl('file:///etc/passwd'), null)
  assert.equal(siteUrl('javascript:alert(1)'), null)
  assert.equal(siteUrl('some random words'), null)
})
