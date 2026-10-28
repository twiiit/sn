// Picks a working nitter *redirector* to point x.com links at.
//
// The list of redirectors is maintained by the shitter wiki:
// https://codeberg.org/shitter/shitter/wiki/Instances#redirectors
// It is re-read on every run so the bot can pick up new redirectors, and each
// candidate is health checked before it is used. twiiit.com is preferred, but a
// different redirector is used automatically when twiiit.com is not available.

export const WIKI_URL = 'https://codeberg.org/shitter/shitter/wiki/Instances'
export const PREFERRED_HOST = 'twiiit.com'
// Used when the wiki cannot be fetched, so the bot still has a safe default.
export const FALLBACK_HOSTS = ['twiiit.com', 'twit.0r.cx', 'nitt.tr', 'xxcancel.com']

const HEALTH_PATH = '/jack/status/20'
const USER_AGENT = 'sn-twiiit-bot (+https://github.com/twiiit/sn)'
// A redirector that sends us back to x.com is not doing its job.
const ORIGIN_REDIRECT = /^(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)(?:[/:?#]|$)/i

/**
 * Turns "https://twiiit.com/", "twiiit.com" or "HTTP://Twiiit.com/x" into "twiiit.com".
 * @returns {string|null}
 */
export function normalizeHost (value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null

  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * Extracts redirector hosts from the rendered shitter wiki page.
 * Only the "Redirectors" section is considered.
 * @param {string} html
 * @returns {string[]}
 */
export function parseRedirectorHosts (html) {
  if (typeof html !== 'string') return []

  const headingIndex = html.search(/id="(?:user-content-)?redirectors"/i)
  if (headingIndex === -1) return []

  // Everything after the heading, up to the next heading, is the section body.
  const afterHeading = html.slice(headingIndex)
  const headingEnd = afterHeading.search(/<\/h[1-6]>/i)
  const body = headingEnd === -1 ? afterHeading : afterHeading.slice(headingEnd)
  const nextHeading = body.search(/<h[1-6][\s>]/i)
  const section = nextHeading === -1 ? body : body.slice(0, nextHeading)

  const hosts = []
  for (const match of section.matchAll(/href="(https?:\/\/[^"#?]+)"/gi)) {
    const host = normalizeHost(match[1])
    if (host && !hosts.includes(host)) hosts.push(host)
  }

  return hosts
}

/**
 * Fetches and parses the redirector list. Returns [] instead of throwing so a
 * wiki outage never stops the bot.
 * @returns {Promise<{ hosts: string[], error?: Error }>}
 */
export async function fetchWikiRedirectorHosts ({ fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  try {
    const res = await fetchImpl(WIKI_URL, {
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { hosts: parseRedirectorHosts(await res.text()) }
  } catch (error) {
    return { hosts: [], error }
  }
}

/**
 * Health checks a redirector: it must answer the status path with a success or
 * redirect response, and must not redirect back to x.com.
 * @returns {Promise<{ host: string, ok: boolean, status?: number, location?: string, error?: string }>}
 */
export async function checkRedirector (host, { fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  const url = `https://${host}${HEALTH_PATH}`

  try {
    const res = await fetchImpl(url, {
      redirect: 'manual',
      headers: { accept: 'text/html,*/*', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs)
    })

    const status = res.status
    const location = res.headers.get('location') ?? undefined

    if (status >= 200 && status < 300) return { host, ok: true, status, location }

    if (status >= 300 && status < 400) {
      if (!location) return { host, ok: false, status, error: 'redirect without location' }

      let target
      try {
        target = new URL(location, url)
      } catch {
        return { host, ok: false, status, location, error: 'invalid redirect location' }
      }

      if (ORIGIN_REDIRECT.test(target.href)) {
        return { host, ok: false, status, location: target.href, error: 'redirects back to x.com' }
      }

      return { host, ok: true, status, location: target.href }
    }

    return { host, ok: false, status, error: `unexpected status ${status}` }
  } catch (error) {
    return { host, ok: false, error: error?.message ?? String(error) }
  }
}

/**
 * Resolves the redirector to use for this run.
 *
 * Order: explicit override (SN_REDIRECTOR) -> twiiit.com -> other redirectors
 * from the wiki -> built-in fallbacks. The first healthy one wins.
 *
 * @returns {Promise<{ host: string, baseUrl: string, attempts: Awaited<ReturnType<typeof checkRedirector>>[], wikiError?: Error } | null>}
 */
export async function selectRedirector ({
  fetchImpl = globalThis.fetch,
  preferredHost,
  log = () => {},
  timeoutMs
} = {}) {
  const preferred = normalizeHost(preferredHost) ?? PREFERRED_HOST
  const { hosts: wikiHosts, error: wikiError } = await fetchWikiRedirectorHosts({ fetchImpl })

  if (wikiError) log(`could not read redirector list from wiki (${wikiError.message}), using built-in fallbacks`)
  if (!wikiError && wikiHosts.length === 0) log('redirector section not found on wiki page, using built-in fallbacks')

  const candidates = []
  for (const host of [preferred, ...wikiHosts, ...FALLBACK_HOSTS]) {
    if (host && !candidates.includes(host)) candidates.push(host)
  }

  const attempts = []
  for (const host of candidates) {
    const check = await checkRedirector(host, { fetchImpl, timeoutMs })
    attempts.push(check)

    if (check.ok) {
      log(`using redirector ${host}${check.location ? ` (-> ${check.location})` : ''}`)
      return { host, baseUrl: `https://${host}`, attempts, wikiError }
    }

    log(`redirector ${host} is not available: ${check.error ?? `HTTP ${check.status}`}`)
  }

  return null
}
