import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  WIKI_URL,
  FALLBACK_HOSTS,
  normalizeHost,
  parseRedirectorHosts,
  checkRedirector,
  selectRedirector
} from '../src/redirectors.js'

const fixture = await readFile(new URL('./fixtures/shitter-instances.html', import.meta.url), 'utf8')

function fakeResponse ({ status = 200, location, body = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name.toLowerCase() === 'location' ? location : null) },
    text: async () => body
  }
}

test('normalizes redirector hosts', () => {
  assert.equal(normalizeHost('twiiit.com'), 'twiiit.com')
  assert.equal(normalizeHost('https://Twiiit.com/'), 'twiiit.com')
  assert.equal(normalizeHost(' http://twit.0r.cx '), 'twit.0r.cx')
  assert.equal(normalizeHost('ftp://twiiit.com'), null)
  assert.equal(normalizeHost(''), null)
  assert.equal(normalizeHost(null), null)
})

test('parses only the redirectors section of the wiki page', () => {
  assert.deepEqual(parseRedirectorHosts(fixture), ['nitt.tr', 'twit.0r.cx', 'xxcancel.com', 'twiiit.com'])
})

test('returns no redirectors when the section is missing', () => {
  assert.deepEqual(parseRedirectorHosts('<h3 id="user-content-working">Working</h3>'), [])
  assert.deepEqual(parseRedirectorHosts(''), [])
})

test('accepts redirecting and directly served redirectors', async () => {
  const redirecting = await checkRedirector('twiiit.com', {
    fetchImpl: async () => fakeResponse({ status: 302, location: 'https://nitter.example/jack/status/20' })
  })
  assert.equal(redirecting.ok, true)

  const direct = await checkRedirector('xxcancel.com', {
    fetchImpl: async () => fakeResponse({ status: 200 })
  })
  assert.equal(direct.ok, true)
})

test('rejects unavailable redirectors and redirects back to x.com', async () => {
  const unavailable = await checkRedirector('nitt.tr', {
    fetchImpl: async () => fakeResponse({ status: 503 })
  })
  assert.equal(unavailable.ok, false)

  const backToX = await checkRedirector('bad.example', {
    fetchImpl: async () => fakeResponse({ status: 302, location: 'https://x.com/jack/status/20' })
  })
  assert.equal(backToX.ok, false)

  const networkError = await checkRedirector('down.example', {
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') }
  })
  assert.equal(networkError.ok, false)
  assert.match(networkError.error, /ENOTFOUND/)
})

test('prefers twiiit.com and falls back to other redirectors', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(url)
    if (url === WIKI_URL) return fakeResponse({ body: fixture })
    if (url.startsWith('https://twiiit.com/')) return fakeResponse({ status: 503 })
    if (url.startsWith('https://nitt.tr/')) return fakeResponse({ status: 502 })
    return fakeResponse({ status: 302, location: 'https://nitter.example/jack/status/20' })
  }

  const selected = await selectRedirector({ fetchImpl, log: () => {} })

  assert.equal(selected.host, 'twit.0r.cx')
  assert.equal(selected.baseUrl, 'https://twit.0r.cx')
  assert.deepEqual(selected.attempts.map(a => a.host), ['twiiit.com', 'nitt.tr', 'twit.0r.cx'])
})

test('uses built-in fallbacks when the wiki is unreachable', async () => {
  const fetchImpl = async (url) => {
    if (url === WIKI_URL) throw new Error('ENOTFOUND')
    return fakeResponse({ status: 302, location: 'https://nitter.example/jack/status/20' })
  }

  const selected = await selectRedirector({ fetchImpl, log: () => {} })

  assert.equal(selected.host, FALLBACK_HOSTS[0])
  assert.ok(selected.wikiError)
})

test('returns null when nothing is healthy', async () => {
  const fetchImpl = async (url) => {
    if (url === WIKI_URL) return fakeResponse({ body: fixture })
    return fakeResponse({ status: 503 })
  }

  assert.equal(await selectRedirector({ fetchImpl, log: () => {} }), null)
})
