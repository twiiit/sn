// Minimal Stacker News client: nostr login (nsec) + the GraphQL calls the bot needs.
//
// Login mirrors what stacker.news' own frontend does:
//   1. createAuth            -> { k1 } challenge
//   2. sign a kind 27235 event containing the challenge with the nsec
//   3. POST it to /api/auth/callback/nostr (NextAuth credentials provider)
//   4. keep the session cookie and use it for GraphQL requests

import { finalizeEvent } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'

const DEFAULT_BASE_URL = 'https://stacker.news'
const USER_AGENT = 'sn-twiiit-bot (+https://github.com/twiiit/sn)'
const REQUEST_TIMEOUT_MS = 30_000

// stacker.news validates `limit` as an int scalar with a maximum of 100 and
// rejects anything above it ("code=maximum"), so looking further back needs
// cursor pages instead of one bigger request.
export const SN_MAX_PAGE_SIZE = 100

/**
 * Spendable sats for a comment. stacker.news already folds the cowboy credits
 * into `sats` (see `fetchWallet`), so these must never be added together.
 * @param {{ sats?: number, credits?: number }} wallet
 */
export function spendableSats ({ sats } = {}) {
  return Number(sats ?? 0)
}

/** The part of the balance that is not cowboy credits. */
export function satsWithoutCredits ({ sats, credits } = {}) {
  return Math.max(0, Number(sats ?? 0) - Number(credits ?? 0))
}

export class SnApiError extends Error {
  constructor (message, { status, errors } = {}) {
    super(message)
    this.name = 'SnApiError'
    this.status = status
    this.errors = errors
  }
}

/**
 * Builds the NIP-98 style event stacker.news expects for nostr login.
 * @param {{ k1: string, baseUrl: string, secretKey: Uint8Array }} options
 */
export function buildAuthEvent ({ k1, baseUrl, secretKey }) {
  return finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['challenge', k1],
      ['u', baseUrl],
      ['method', 'GET']
    ],
    content: 'Stacker News Authentication'
  }, secretKey)
}

/**
 * Accepts an nsec (or a raw 64 char hex secret key) and returns the secret key bytes.
 * @param {string} nsec
 * @returns {Uint8Array}
 */
export function nsecToSecretKey (nsec) {
  const value = String(nsec ?? '').trim().replace(/^["']|["']$/g, '')
  if (value === '') throw new Error('missing nsec')

  if (/^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(value.match(/.{2}/g).map(byte => parseInt(byte, 16)))
  }

  let decoded
  try {
    decoded = decode(value)
  } catch {
    throw new Error('SN_NSEC is not a valid nsec')
  }

  if (decoded.type !== 'nsec') throw new Error(`SN_NSEC must be an nsec, got ${decoded.type}`)
  return decoded.data
}

export class StackerNewsClient {
  constructor ({ baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetchImpl = fetchImpl
    this.cookies = new Map()
  }

  cookieHeader () {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  storeCookies (res) {
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : []

    for (const cookie of setCookies) {
      const [pair] = cookie.split(';')
      const index = pair.indexOf('=')
      if (index <= 0) continue
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim())
    }
  }

  async request (path, { method = 'GET', headers = {}, body } = {}) {
    const cookie = this.cookieHeader()
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'user-agent': USER_AGENT,
        ...(cookie ? { cookie } : {}),
        ...headers
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    this.storeCookies(res)
    return res
  }

  async gql (query, variables) {
    const res = await this.request('/api/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(variables ? { query, variables } : { query })
    })

    const payload = await res.json().catch(() => null)

    if (!res.ok) {
      const detail = payload?.errors?.map(e => e.message).join('; ')
      throw new SnApiError(`GraphQL request failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`, { status: res.status })
    }

    if (payload?.errors?.length) {
      throw new SnApiError(payload.errors.map(e => e.message).join('; '), { errors: payload.errors })
    }

    return payload?.data ?? {}
  }

  /**
   * Signs in with a nostr secret key and returns the logged in user.
   * @param {string} nsec
   * @returns {Promise<{ id: string, name: string }>}
   */
  async login (nsec) {
    const secretKey = nsecToSecretKey(nsec)

    const { createAuth } = await this.gql('mutation { createAuth { k1 } }')
    const k1 = createAuth?.k1
    if (!k1) throw new SnApiError('could not create a login challenge')

    const event = buildAuthEvent({ k1, baseUrl: this.baseUrl, secretKey })

    const csrfRes = await this.request('/api/auth/csrf', { headers: { accept: 'application/json' } })
    const { csrfToken } = await csrfRes.json().catch(() => ({}))
    if (!csrfToken) throw new SnApiError('could not get a CSRF token')

    const res = await this.request('/api/auth/callback/nostr', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body: new URLSearchParams({
        csrfToken,
        event: JSON.stringify(event),
        callbackUrl: this.baseUrl,
        json: 'true'
      }).toString()
    })

    const body = await res.json().catch(() => ({}))

    if (res.status >= 400) {
      const reason = decodeURIComponent(String(body?.url ?? '').split('error=').pop() || '') || `HTTP ${res.status}`
      throw new SnApiError(`nostr login failed: ${reason}`, { status: res.status })
    }

    const hasSession = [...this.cookies.keys()].some(name => name.includes('session-token'))
    if (!hasSession) throw new SnApiError('nostr login did not return a session cookie')

    const { me } = await this.gql('query { me { id name } }')
    if (!me) throw new SnApiError('nostr login succeeded but the session is not authenticated')

    return me
  }

  /**
   * The account's spendable balance.
   *
   * `sats` is already the total: stacker.news resolves it as
   * `msatsToSats(msats) + msatsToSats(mcredits)` and documents the split as
   * `sats - credits === msatsToSats(msats)` (api/resolvers/user.js), which is
   * also what its affordability check uses (`msats + mcredits`). So `credits`
   * is a part of `sats`, not a separate bucket - adding them counts the cowboy
   * credits twice.
   * @returns {Promise<{ sats: number, credits: number, freeCommentsLeft: number }>}
   */
  async fetchWallet () {
    const { me } = await this.gql(`
      query {
        me {
          id
          privates {
            sats
            credits
            freeCommentsLeft
          }
        }
      }
    `)

    const privates = me?.privates
    if (!privates) throw new SnApiError('could not read the account balance (is the session authenticated?)')

    return {
      sats: Number(privates.sats ?? 0),
      credits: Number(privates.credits ?? 0),
      freeCommentsLeft: Number(privates.freeCommentsLeft ?? 0)
    }
  }

  /**
   * One page of the newest items, newest first, plus the cursor that walks back
   * to the next page.
   */
  async recentItemsPage ({ limit = SN_MAX_PAGE_SIZE, cursor = null } = {}) {
    const requested = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : SN_MAX_PAGE_SIZE
    const pageSize = Math.min(Math.max(requested, 1), SN_MAX_PAGE_SIZE)

    const { items } = await this.gql(`
      query ($limit: Limit!, $cursor: String) {
        items(sort: "new", type: "all", limit: $limit, cursor: $cursor) {
          cursor
          items {
            id
            parentId
            createdAt
            paidAt
            deletedAt
            title
            url
            text
            user { id name }
          }
        }
      }
    `, { limit: pageSize, cursor: cursor ?? null })

    return { items: items?.items ?? [], cursor: items?.cursor ?? null }
  }

  /** Recent items, newest first. */
  async recentItems ({ limit = SN_MAX_PAGE_SIZE } = {}) {
    const { items } = await this.recentItemsPage({ limit })
    return items
  }

  /**
   * Items newer than `since`, newest first.
   *
   * One page only covers as many posts as stacker.news received in that time, so
   * the window is filled by paging backwards until the last page reaches `since`
   * (or the feed ends). `maxPages` keeps a runaway loop impossible.
   *
   * @returns {Promise<{ items: object[], pages: number, truncated: boolean }>}
   */
  async recentItemsSince ({ since, pageSize = SN_MAX_PAGE_SIZE, maxPages = 5, log = () => {} }) {
    const sinceMs = new Date(since).getTime()
    if (!Number.isFinite(sinceMs)) throw new Error('recentItemsSince needs a valid `since` date')

    const requested = Number.isFinite(Number(pageSize)) ? Math.trunc(Number(pageSize)) : SN_MAX_PAGE_SIZE
    const effectivePageSize = Math.min(Math.max(requested, 1), SN_MAX_PAGE_SIZE)
    const pageLimit = Math.max(1, Math.trunc(Number(maxPages)) || 1)

    const collected = []
    const seen = new Set()
    let cursor = null
    let pages = 0
    let reason = 'max-pages'

    while (pages < pageLimit) {
      const page = await this.recentItemsPage({ limit: effectivePageSize, cursor })
      pages++

      for (const item of page.items) {
        if (seen.has(item.id)) continue
        seen.add(item.id)
        collected.push(item)
      }

      const oldest = page.items.reduce((min, item) => {
        const time = Date.parse(item.createdAt)
        return Number.isFinite(time) && (min == null || time < min) ? time : min
      }, null)

      if (page.items.length > 0) {
        log(`page ${pages}: ${page.items.length} item(s), oldest ${page.items.at(-1).createdAt}`)
      }

      if (page.items.length === 0) {
        reason = 'end-of-feed'
        break
      }
      if (oldest != null && oldest <= sinceMs) {
        reason = 'reached-since'
        break
      }
      if (page.items.length < effectivePageSize || !page.cursor) {
        reason = 'end-of-feed'
        break
      }

      cursor = page.cursor
    }

    return { items: collected, pages, truncated: reason === 'max-pages' }
  }

  /**
   * Returns a comment the bot already wrote below the given item, if any.
   * `newComments` returns everything posted under the item after `after`,
   * which is enough to make the bot idempotent without keeping local state.
   */
  async findExistingBotComment ({ itemId, after, botUserId, botName }) {
    const { newComments } = await this.gql(`
      query ($itemId: ID, $after: Date) {
        newComments(itemId: $itemId, after: $after) {
          comments { id userId text user { id name } }
        }
      }
    `, { itemId: String(itemId), after })

    const comments = newComments?.comments ?? []
    return comments.find(comment => {
      if (botUserId != null && Number(comment.userId) === Number(botUserId)) return true
      return String(comment.user?.name ?? '').toLowerCase() === String(botName).toLowerCase()
    }) ?? null
  }

  /**
   * Posts a comment and returns the resulting payIn, which tells us whether the
   * comment was paid for (and therefore visible to everyone) or not.
   */
  async createComment ({ parentId, text }) {
    const { upsertComment } = await this.gql(`
      mutation ($parentId: ID!, $text: String!) {
        upsertComment(parentId: $parentId, text: $text) {
          id
          mcost
          payInState
          payerPrivates {
            payInBolt11 { bolt11 expiresAt }
            result { ... on Item { id } }
          }
        }
      }
    `, { parentId: String(parentId), text })

    if (!upsertComment) throw new SnApiError('comment was not created')
    return upsertComment
  }
}
