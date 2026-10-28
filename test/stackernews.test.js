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
