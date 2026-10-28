// Publishing the bot's replies as nostr notes (kind 1).
//
// stacker.news does not crosspost comments (only posts submitted in the web UI
// and the manual share button), so the bot signs its own notes with the same
// nsec it logs in with. The relays are stacker.news' own crossposting defaults
// (lib/nostr.js in their repo), so notes land where SN crossposts land.
//
// A tiny WebSocket client is used instead of nostr-tools' SimplePool: a relay
// that refuses the connection (damus.io does that from some datacenter IPs)
// made the pool throw from inside its own error handler, which is not catchable
// and killed the whole run. Here every relay is isolated and can only fail on
// its own.

import { finalizeEvent } from 'nostr-tools/pure'

export const DEFAULT_RELAYS = [
  'wss://nostrue.com/',
  'wss://relay.damus.io/',
  'wss://relay.nostr.band/',
  'wss://relay.snort.social/',
  'wss://relay.primal.net/'
]

/**
 * Signs a kind 1 note with the bot's key.
 * @param {{ content: string, secretKey: Uint8Array, tags?: string[][], createdAt?: number }} options
 */
export function buildNote ({ content, secretKey, tags = [], createdAt = Math.floor(Date.now() / 1000) }) {
  return finalizeEvent({ kind: 1, created_at: createdAt, tags, content }, secretKey)
}

/**
 * Publishes one event to one relay and resolves with the outcome. It never
 * rejects and never throws: a dead relay must not take the run down with it.
 * @param {string} url
 * @param {{ id: string }} event
 * @param {{ WebSocketImpl?: typeof WebSocket, timeoutMs?: number }} options
 * @returns {Promise<{ url: string, ok: boolean, reason?: string }>}
 */
export function publishToRelay (url, event, { WebSocketImpl = globalThis.WebSocket, timeoutMs = 6_000 } = {}) {
  return new Promise(resolve => {
    let settled = false
    let socket
    let timer

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // detach first: closing a socket that never connected fires more error events
      try {
        if (socket) {
          socket.onopen = null
          socket.onmessage = null
          socket.onerror = null
          socket.onclose = null
          socket.close()
        }
      } catch {}
      resolve(result)
    }

    timer = setTimeout(() => finish({ url, ok: false, reason: `no answer within ${timeoutMs}ms` }), timeoutMs)

    try {
      socket = new WebSocketImpl(url)
    } catch (error) {
      finish({ url, ok: false, reason: error.message })
      return
    }

    socket.onopen = () => {
      try {
        socket.send(JSON.stringify(['EVENT', event]))
      } catch (error) {
        finish({ url, ok: false, reason: error.message })
      }
    }

    socket.onmessage = (message) => {
      try {
        const data = JSON.parse(message.data)
        if (data[0] !== 'OK' || data[1] !== event.id) return
        if (data[2] === true) finish({ url, ok: true })
        else finish({ url, ok: false, reason: String(data[3] || 'rejected by the relay') })
      } catch {
        // relays can send anything; a bad frame is not a publish failure yet
      }
    }

    socket.onerror = () => finish({ url, ok: false, reason: 'connection failed' })
    socket.onclose = () => finish({ url, ok: false, reason: 'closed before the relay accepted the note' })
  })
}

/**
 * Publishes a note to every relay and reports which ones took it. Relays that
 * are down, block datacenter IPs or are slow only shorten `accepted`; the note
 * is considered published as soon as one relay has it.
 * @param {{ event: { id: string }, relays?: string[], WebSocketImpl?: typeof WebSocket, timeoutMs?: number }} options
 * @returns {Promise<{ accepted: string[], failed: { url: string, reason: string }[] }>}
 */
export async function publishNote ({ event, relays = DEFAULT_RELAYS, WebSocketImpl, timeoutMs }) {
  const results = await Promise.all(
    relays.map(url => publishToRelay(url, event, { WebSocketImpl, timeoutMs }))
  )

  return {
    accepted: results.filter(result => result.ok).map(result => result.url),
    failed: results.filter(result => !result.ok).map(({ url, reason }) => ({ url, reason }))
  }
}
