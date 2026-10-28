// Detection and rewriting of x.com / twitter.com status links.

// Matches things like:
//   https://x.com/jack/status/20?s=20
//   http://www.twitter.com/jack/statuses/20
//   x.com/jack/status/20
// The negative lookbehind keeps it from matching inside longer hostnames
// (e.g. "notx.com/...") or already-rewritten links.
const STATUS_LINK = /(?<![\w@.\/-])(?:https?:\/\/)?(?:www\.|mobile\.|m\.)?(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/gi

/**
 * Finds every distinct x.com/twitter.com status link in the given strings.
 * @param {...(string|null|undefined)} texts
 * @returns {{ handle: string, id: string, key: string }[]}
 */
export function findStatusLinks (...texts) {
  const links = []
  const seen = new Set()

  for (const text of texts) {
    if (typeof text !== 'string' || text === '') continue
    for (const match of text.matchAll(STATUS_LINK)) {
      const handle = match[1]
      const id = match[2]
      const key = `${handle.toLowerCase()}/status/${id}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ handle, id, key })
    }
  }

  return links
}

/**
 * Builds the redirector URL for a status link.
 * Redirectors (like twiiit.com) accept a nitter-style path and forward it to a
 * working nitter instance: https://twiiit.com/<handle>/status/<id>
 */
export function toRedirectUrl (link, redirectorBaseUrl) {
  const base = redirectorBaseUrl.replace(/\/+$/, '')
  return `${base}/${link.handle}/status/${link.id}`
}

/**
 * The comment body the bot posts: one rewritten link per line.
 *
 * An optional footer is appended as a GFM footnote (`[^1]` + a definition),
 * which stacker.news renders as a small superscript marker plus a muted line at
 * the bottom - so the links stay the only thing the comment is about.
 */
export function buildComment (links, redirectorBaseUrl, { footer } = {}) {
  const body = links.map(link => toRedirectUrl(link, redirectorBaseUrl)).join('\n')
  const text = typeof footer === 'string' ? footer.trim() : ''
  if (text === '') return body

  return `${body} [^1]\n\n[^1]: ${text}`
}

/**
 * The body of the nostr note: the same rewritten links, plus a pointer to the
 * stacker.news post so note readers can find the discussion. No markdown, since
 * relays hand the content to clients as plain text.
 */
export function buildNoteContent (links, redirectorBaseUrl, { snItemUrl } = {}) {
  const body = links.map(link => toRedirectUrl(link, redirectorBaseUrl)).join('\n')
  return snItemUrl ? `${body}\n\n${snItemUrl}` : body
}
