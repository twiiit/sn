import test from 'node:test'
import assert from 'node:assert/strict'

import { findStatusLinks, toRedirectUrl, buildComment } from '../src/links.js'

test('finds x.com and twitter.com status links', () => {
  const links = findStatusLinks(
    'interesting thread https://x.com/jack/status/20?s=20',
    'also http://www.twitter.com/jack/statuses/20'
  )

  assert.deepEqual(links.map(l => l.key), ['jack/status/20'])
})

test('finds protocol-less and mobile links', () => {
  const links = findStatusLinks('x.com/alice/status/123 and https://mobile.twitter.com/bob/status/456')

  assert.deepEqual(links.map(l => l.key), ['alice/status/123', 'bob/status/456'])
})

test('keeps distinct links and drops duplicates', () => {
  const links = findStatusLinks(
    'https://x.com/a/status/1 https://twitter.com/b/status/2 https://x.com/A/status/1'
  )

  assert.deepEqual(links.map(l => l.key), ['a/status/1', 'b/status/2'])
})

test('ignores lookalike hosts and non-status links', () => {
  const links = findStatusLinks([
    'https://notx.com/jack/status/20',
    'https://x.com/jack',
    'https://x.com/jack/status/',
    'https://example.com/?u=https://x.com/foo/status/1'
  ].join(' '))

  assert.deepEqual(links.map(l => l.key), ['foo/status/1'])
})

test('ignores empty and missing text', () => {
  assert.deepEqual(findStatusLinks(null, undefined, ''), [])
})

test('builds redirector urls and the comment body', () => {
  const links = findStatusLinks('https://x.com/jack/status/20 and https://x.com/a/status/1')

  assert.equal(toRedirectUrl(links[0], 'https://twiiit.com'), 'https://twiiit.com/jack/status/20')
  assert.equal(toRedirectUrl(links[0], 'https://twiiit.com/'), 'https://twiiit.com/jack/status/20')
  assert.equal(
    buildComment(links, 'https://twiiit.com'),
    'https://twiiit.com/jack/status/20\nhttps://twiiit.com/a/status/1'
  )
})
