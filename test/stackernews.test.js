import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'

import { buildAuthEvent, nsecToSecretKey } from '../src/stackernews.js'

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

test('rejects invalid secret keys', () => {
  assert.throws(() => nsecToSecretKey(''), /missing nsec/)
  assert.throws(() => nsecToSecretKey('nsec1nope'), /not a valid nsec/)
  assert.throws(() => nsecToSecretKey(nip19.npubEncode('a'.repeat(64))), /must be an nsec/)
})
