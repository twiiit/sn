import test from 'node:test'
import assert from 'node:assert/strict'

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'

import { buildNote, publishToRelay, publishNote, DEFAULT_RELAYS } from '../src/nostr.js'

const secretKey = generateSecretKey()
const event = buildNote({ content: 'https://twiiit.com/jack/status/20', secretKey })

/**
 * Stand-in for a relay connection. `handlers[url]` runs once the socket opened
 * and decides how that relay behaves.
 */
function fakeWebSocket (handlers = {}) {
  return class {
    constructor (url) {
      this.url = url
      this.sent = []
      queueMicrotask(() => {
        this.onopen?.()
        handlers[url]?.(this)
      })
    }

    send (data) { this.sent.push(data) }
    close () {}
  }
}

const reply = (socket, accepted, note = '') => {
  const [, published] = JSON.parse(socket.sent[0])
  socket.onmessage({ data: JSON.stringify(['OK', published.id, accepted, note]) })
}

test('signs a kind 1 note with the bot key', () => {
  assert.equal(event.kind, 1)
  assert.equal(event.content, 'https://twiiit.com/jack/status/20')
  assert.deepEqual(event.tags, [])
  assert.equal(event.pubkey, getPublicKey(secretKey))
  assert.equal(verifyEvent(event), true)
})

test('reports a relay that accepts the note', async () => {
  const result = await publishToRelay('wss://good.example/', event, {
    WebSocketImpl: fakeWebSocket({ 'wss://good.example/': socket => reply(socket, true) })
  })

  assert.deepEqual(result, { url: 'wss://good.example/', ok: true })
})

test('reports the reason a relay rejected the note', async () => {
  const result = await publishToRelay('wss://blocked.example/', event, {
    WebSocketImpl: fakeWebSocket({ 'wss://blocked.example/': socket => reply(socket, false, 'blocked: spam') })
  })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'blocked: spam')
})

test('gives up on a relay that never answers', async () => {
  const result = await publishToRelay('wss://slow.example/', event, {
    WebSocketImpl: fakeWebSocket(),
    timeoutMs: 20
  })

  assert.equal(result.ok, false)
  assert.match(result.reason, /no answer/)
})

test('a relay that cannot connect does not throw', async () => {
  const result = await publishToRelay('wss://dead.example/', event, {
    WebSocketImpl: fakeWebSocket({ 'wss://dead.example/': socket => socket.onerror() })
  })

  assert.deepEqual(result, { url: 'wss://dead.example/', ok: false, reason: 'connection failed' })
})

test('a single dead relay does not stop the others', async () => {
  const result = await publishNote({
    event,
    relays: ['wss://good.example/', 'wss://dead.example/'],
    WebSocketImpl: fakeWebSocket({
      'wss://good.example/': socket => reply(socket, true),
      'wss://dead.example/': socket => socket.onerror()
    })
  })

  assert.deepEqual(result.accepted, ['wss://good.example/'])
  assert.deepEqual(result.failed, [{ url: 'wss://dead.example/', reason: 'connection failed' }])
})

test('publishes to stacker news crosspost relays by default', () => {
  assert.ok(DEFAULT_RELAYS.includes('wss://relay.damus.io/'))
  assert.ok(DEFAULT_RELAYS.every(relay => relay.startsWith('wss://')))
})
