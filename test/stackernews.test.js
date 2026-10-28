import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'

import { buildAuthEvent, nsecToSecretKey, StackerNewsClient } from '../src/stackernews.js'

function clientReturning (data) {
  const calls = []
  const client = new StackerNewsClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init?.body })
      return new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })
  return { client, calls }
}

// Serves `count` items one minute apart, newest first, honouring the cursor.
function pagingClient (count) {
  const now = Date.parse('2026-10-28T12:00:00Z')
  const items = Array.from({ length: count }, (_, index) => ({
    id: String(1000 + index),
    createdAt: new Date(now - index * 60_000).toISOString()
  }))

  const calls = []
  const client = new StackerNewsClient({
    fetchImpl: async (url, init) => {
      const { variables } = JSON.parse(init.body)
      calls.push(variables)

      const start = variables.cursor == null ? 0 : Number(variables.cursor)
      const slice = items.slice(start, start + variables.limit)
      const next = start + slice.length < items.length ? String(start + slice.length) : null

      return new Response(JSON.stringify({ data: { items: { cursor: next, items: slice } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
  })

  return { client, calls, now }
}

test('auth event matches the id and signature stacker.news verifies', () => {
  const secretKey = generateSecretKey()
  const event = buildAuthEvent({ k1: 'abc123', baseUrl: 'https://stacker.news', secretKey })

  // this is how stacker.news recomputes the id (pages/api/auth/[...nextauth].js)
  const expectedId = createHash('sha256')
    .update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]))
    .digest('hex')

  assert.equal(event.id, expectedId)
  assert.equal(event.pubkey, getPublicKey(secretKey))
  assert.equal(event.kind, 27235)
  assert.deepEqual(event.tags[0], ['challenge', 'abc123'])
  assert.equal(verifyEvent(event), true)
})

test('accepts nsec and hex secret keys', () => {
  const secretKey = generateSecretKey()

  assert.deepEqual(nsecToSecretKey(nip19.nsecEncode(secretKey)), secretKey)
  assert.deepEqual(nsecToSecretKey(Buffer.from(secretKey).toString('hex')), secretKey)
  assert.deepEqual(nsecToSecretKey(` ${nip19.nsecEncode(secretKey)} `), secretKey)
})

test('reads the balance that pays for comments', async () => {
  const { client, calls } = clientReturning({
    me: { id: '36365', privates: { sats: 4, credits: 96, freeCommentsLeft: 5 } }
  })

  assert.deepEqual(await client.fetchWallet(), { sats: 4, credits: 96, freeCommentsLeft: 5 })
  assert.match(JSON.parse(calls[0].body).query, /privates\s*{\s*sats\s+credits/)
})

test('refuses to guess a balance when the session is not authenticated', async () => {
  const { client } = clientReturning({ me: null })

  await assert.rejects(() => client.fetchWallet(), /could not read the account balance/)
})

test('rejects invalid secret keys', () => {
  assert.throws(() => nsecToSecretKey(''), /missing nsec/)
  assert.throws(() => nsecToSecretKey('nsec1nope'), /not a valid nsec/)
  assert.throws(() => nsecToSecretKey(nip19.npubEncode('a'.repeat(64))), /must be an nsec/)
})

test('pages back until the requested window is covered', async () => {
  const { client, now } = pagingClient(30)
  const logs = []

  const { items, pages, truncated } = await client.recentItemsSince({
    since: new Date(now - 8 * 60_000),
    pageSize: 5,
    maxPages: 10,
    log: message => logs.push(message)
  })

  // page 1 covers -0..-4 min, page 2 reaches -9 min, which is past the cutoff
  assert.equal(pages, 2)
  assert.equal(truncated, false)
  assert.equal(items.length, 10)
  assert.deepEqual(items.map(item => item.id), ['1000', '1001', '1002', '1003', '1004', '1005', '1006', '1007', '1008', '1009'])
  assert.deepEqual(logs, ['page 1: 5 item(s), oldest 2026-10-28T11:56:00.000Z', 'page 2: 5 item(s), oldest 2026-10-28T11:51:00.000Z'])
})

test('stops at the end of the feed instead of looping on an empty cursor', async () => {
  const { client, now, calls } = pagingClient(12)

  const { items, pages, truncated } = await client.recentItemsSince({
    since: new Date(now - 400 * 24 * 60 * 60_000),
    pageSize: 5,
    maxPages: 10
  })

  assert.equal(items.length, 12)
  assert.equal(pages, 3)
  assert.equal(truncated, false)
  // first page has no cursor, later pages carry the one stacker.news returned
  assert.equal(calls[0].cursor, null)
  assert.equal(calls[1].cursor, '5')
  assert.equal(calls[2].cursor, '10')
})

test('reports truncation when MAX_PAGES runs out before the window', async () => {
  const { client, now } = pagingClient(50)

  const { items, pages, truncated } = await client.recentItemsSince({
    since: new Date(now - 180 * 60_000),
    pageSize: 5,
    maxPages: 2
  })

  assert.equal(pages, 2)
  assert.equal(items.length, 10)
  assert.equal(truncated, true)
})

test('never asks for more items than stacker.news allows', async () => {
  const { client, calls } = pagingClient(5)

  // stacker.news rejects limit > 100 with "got invalid value ... code=maximum"
  await client.recentItemsPage({ limit: 500 })

  assert.equal(calls[0].limit, 100)
})
