import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRobots, isAllowed, publicUrl, RETRIEVAL_BOTS, TRAINING_BOTS } from '../dist/checks.js'

/**
 * The robots parser is the only place in this package with real logic, and the
 * question it answers decides what the tool reports: is this crawler allowed
 * to fetch the site at all. Getting it backwards would tell somebody they are
 * invisible when they are fine, or fine when they are invisible.
 */

test('a specific group beats the wildcard', () => {
  const g = parseRobots(`
User-agent: *
Disallow: /

User-agent: PerplexityBot
Disallow:
`)
  assert.equal(isAllowed(g, 'PerplexityBot'), true, 'named group should win')
  assert.equal(isAllowed(g, 'Bingbot'), false, 'unnamed falls to the wildcard')
})

test('consecutive user-agent lines share one set of rules', () => {
  const g = parseRobots(`
User-agent: GPTBot
User-agent: ClaudeBot
Disallow: /
`)
  assert.equal(isAllowed(g, 'GPTBot'), false)
  assert.equal(isAllowed(g, 'ClaudeBot'), false)
  assert.equal(isAllowed(g, 'Bingbot'), true, 'nobody else is covered')
})

test('an empty Disallow permits everything', () => {
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), 'Bingbot'), true)
})

test('the longest matching rule wins, and Allow breaks a tie', () => {
  const g = parseRobots(`
User-agent: *
Disallow: /
Allow: /
`)
  assert.equal(isAllowed(g, 'Bingbot'), true)

  const deeper = parseRobots(`
User-agent: *
Allow: /
Disallow: /private
`)
  assert.equal(isAllowed(deeper, 'Bingbot', '/private/x'), false)
  assert.equal(isAllowed(deeper, 'Bingbot', '/public'), true)
})

test('agent matching ignores case', () => {
  const g = parseRobots('User-agent: perplexitybot\nDisallow: /')
  assert.equal(isAllowed(g, 'PerplexityBot'), false)
})

test('comments and blank lines are ignored', () => {
  const g = parseRobots(`
# everything below is deliberate
User-agent: *   # yes, everyone
Disallow: /     # nothing for you
`)
  assert.equal(isAllowed(g, 'Bingbot'), false)
})

test('no robots rules at all means allowed', () => {
  assert.equal(isAllowed(parseRobots(''), 'Bingbot'), true)
  assert.equal(isAllowed(parseRobots('Sitemap: https://x.test/sitemap.xml'), 'Bingbot'), true)
})

test('the two crawler groups do not overlap', () => {
  const overlap = RETRIEVAL_BOTS.filter((b) => TRAINING_BOTS.includes(b))
  assert.deepEqual(overlap, [], 'a bot cannot be both, or the advice contradicts itself')
})

test('refuses anything that is not the public web', () => {
  for (const bad of [
    'localhost',
    'http://127.0.0.1',
    'http://10.1.2.3',
    'http://192.168.0.1',
    'http://169.254.169.254',
    'http://172.20.0.1',
    'file:///etc/passwd',
    '',
    'not a url',
    42,
  ]) {
    assert.equal(publicUrl(bad), null, `${bad} should be refused`)
  }
})

test('accepts a bare hostname and assumes https', () => {
  assert.equal(publicUrl('example.com')?.protocol, 'https:')
  assert.equal(publicUrl('  example.com  ')?.hostname, 'example.com')
  assert.equal(publicUrl('http://example.com')?.protocol, 'http:')
})
