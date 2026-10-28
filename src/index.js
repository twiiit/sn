#!/usr/bin/env node
// Scans recent stacker.news posts for x.com links and replies with the same
// links pointing at a working nitter redirector (twiiit.com by default).

import { appendFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import { StackerNewsClient, nsecToSecretKey, spendableSats, satsWithoutCredits, SN_MAX_PAGE_SIZE } from './stackernews.js'
import { selectRedirector } from './redirectors.js'
import { findStatusLinks, buildComment, buildNoteContent } from './links.js'
import { buildNote, publishNote, DEFAULT_RELAYS } from './nostr.js'

const log = (...args) => console.log(new Date().toISOString(), ...args)

// stacker.news pays ~1 sat per comment from the account balance and only writes
// it unpaid once that balance is gone. This footnote only shows up when the
// balance is low, so it never nags while the bot is funded.
//
// The address is in backticks on purpose: stacker.news autolinks bare emails and
// ends up rendering the visible text as "mailto:twiiit@rizful.com".
const DEFAULT_FUNDING_FOOTER = 'bot · funded by zaps — zap this comment or send sats to `twiiit@rizful.com`'

function envInt (name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative integer`)
  return value
}

function envBool (name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] ?? '').trim())
}

function envRelays (name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  return raw.split(',')
    .map(relay => relay.trim())
    .filter(Boolean)
    .map(relay => /^wss?:\/\//i.test(relay) ? relay : `wss://${relay}`)
}

function readConfig () {
  return {
    baseUrl: (process.env.SN_BASE_URL || 'https://stacker.news').trim(),
    nsec: process.env.SN_NSEC,
    botName: (process.env.SN_BOT_NAME || 'twiiit').trim(),
    preferredRedirector: process.env.SN_REDIRECTOR,
    dryRun: envBool('DRY_RUN'),
    maxItems: envInt('MAX_ITEMS', SN_MAX_PAGE_SIZE),
    maxPages: envInt('MAX_PAGES', 5),
    // GitHub's scheduler is best effort: a */5 cron can run 40+ minutes late, or
    // a run can be dropped entirely. A window wider than that keeps posts from
    // ageing out before a run sees them; dedupe makes the overlap harmless.
    maxAgeMinutes: envInt('ITEM_MAX_AGE_MINUTES', 180),
    maxCommentsPerRun: envInt('MAX_COMMENTS_PER_RUN', 20),
    postDelayMs: envInt('POST_DELAY_MS', 5000),
    lowBalanceSats: envInt('SN_LOW_BALANCE_SATS', 100),
    fundingFooter: (process.env.SN_FUNDING_FOOTER || DEFAULT_FUNDING_FOOTER).trim(),
    // stacker.news does not crosspost comments, so the bot publishes its own notes
    publishNotes: !envBool('NOSTR_DISABLED'),
    relays: envRelays('NOSTR_RELAYS', DEFAULT_RELAYS)
  }
}

async function writeStepSummary (markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (!path) return
  try {
    await appendFile(path, markdown.endsWith('\n') ? markdown : `${markdown}\n`)
  } catch (error) {
    log('could not write GitHub step summary:', error.message)
  }
}

function isCandidate (item, { now, maxAgeMs, botName }) {
  // top level posts only: the bot replies to posts, not to other comments
  if (item.parentId != null) return false
  // unpaid posts are not visible to others and cannot be commented on
  if (!item.paidAt) return false
  if (item.deletedAt) return false
  if (String(item.user?.name ?? '').toLowerCase() === botName.toLowerCase()) return false

  const createdAt = Date.parse(item.createdAt)
  if (!Number.isFinite(createdAt)) return false
  if (now - createdAt > maxAgeMs) return false

  return true
}

async function main () {
  const config = readConfig()
  if (!config.nsec) throw new Error('SN_NSEC is not set')

  const startedAt = Date.now()

  log(`looking for a working redirector (preferred: ${config.preferredRedirector?.trim() || 'twiiit.com'})`)
  const redirector = await selectRedirector({
    preferredHost: config.preferredRedirector,
    log
  })

  if (!redirector) throw new Error('no working nitter redirector found, refusing to post dead links')

  const sn = new StackerNewsClient({ baseUrl: config.baseUrl })

  log('logging in to stacker.news with nostr ...')
  const me = await sn.login(config.nsec)

  if (me.name.toLowerCase() !== config.botName.toLowerCase()) {
    throw new Error(`logged in as "${me.name}" but SN_BOT_NAME is "${config.botName}", refusing to comment`)
  }
  log(`logged in as ${me.name} (id ${me.id})`)

  const snSiteUrl = config.baseUrl.replace(/\/+$/, '')
  const noteKey = config.publishNotes ? nsecToSecretKey(config.nsec) : null
  if (config.publishNotes) log(`replies are also published as nostr notes to ${config.relays.length} relay(s)`)

  // 1 comment costs ~1 sat, so the balance is roughly the number of replies left
  const wallet = await sn.fetchWallet()
  // `sats` already includes the cowboy credits, so adding them counts twice
  const balance = spendableSats(wallet)
  const lowBalance = config.lowBalanceSats > 0 && balance < config.lowBalanceSats
  const footer = lowBalance ? config.fundingFooter : ''
  log(`balance: ${balance} sats (${satsWithoutCredits(wallet)} sats + ${wallet.credits} cowboy credits)` +
    (footer ? ` (below ${config.lowBalanceSats}, replies will invite zaps)` : ''))

  const maxAgeMs = config.maxAgeMinutes * 60_000
  const since = new Date(Date.now() - maxAgeMs)
  if (config.maxItems > SN_MAX_PAGE_SIZE) {
    log(`MAX_ITEMS is capped at ${SN_MAX_PAGE_SIZE} per page by stacker.news, extra pages are used instead`)
  }

  const { items, pages, truncated } = await sn.recentItemsSince({
    since,
    pageSize: config.maxItems,
    maxPages: config.maxPages,
    log
  })
  log(`fetched ${items.length} items from the last ${config.maxAgeMinutes} min (${pages} page(s))`)
  if (truncated) {
    log(`warning: hit MAX_PAGES (${config.maxPages}) before reaching ${config.maxAgeMinutes} min back, older posts in the window were not scanned`)
  }

  const candidates = items
    .filter(item => isCandidate(item, { now: Date.now(), maxAgeMs, botName: config.botName }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

  const stats = { scanned: candidates.length, withLinks: 0, commented: 0, alreadyCommented: 0, failed: 0, unpaid: 0, notesPublished: 0, notesFailed: 0 }

  for (const item of candidates) {
    if (stats.commented >= config.maxCommentsPerRun) {
      log(`reached MAX_COMMENTS_PER_RUN (${config.maxCommentsPerRun}), stopping`)
      break
    }
    if (stats.unpaid > 0) {
      log('a comment needs payment, stopping before creating more unpaid comments')
      break
    }

    const links = findStatusLinks(item.url, item.text, item.title)
    if (links.length === 0) continue
    stats.withLinks++

    const text = buildComment(links, redirector.baseUrl, { footer })
    log(`item ${item.id} (${item.user?.name}) has ${links.length} x.com link(s): ${text.replace(/\n/g, ' ')}`)

    try {
      const existing = await sn.findExistingBotComment({
        itemId: item.id,
        after: item.createdAt,
        botUserId: me.id,
        botName: config.botName
      })

      if (existing) {
        stats.alreadyCommented++
        log(`item ${item.id} already has a bot comment (${existing.id}), skipping`)
        continue
      }

      if (config.dryRun) {
        stats.commented++
        log(`[dry run] would comment on item ${item.id}:\n${text}`)
        if (config.publishNotes) {
          log(`[dry run] would publish note:\n${buildNoteContent(links, redirector.baseUrl, { snItemUrl: `${snSiteUrl}/items/${item.id}`, title: item.title })}`)
        }
        continue
      }

      const payIn = await sn.createComment({ parentId: item.id, text })
      const commentId = payIn.payerPrivates?.result?.id

      if (payIn.payInState === 'PAID') {
        stats.commented++
        log(`commented on item ${item.id} (comment ${commentId})`)

        // the note mirrors a comment that actually went through, and a relay
        // problem must never cost us the comment or the rest of the run
        if (config.publishNotes) {
          try {
            const event = buildNote({
              secretKey: noteKey,
              content: buildNoteContent(links, redirector.baseUrl, { snItemUrl: `${snSiteUrl}/items/${item.id}`, title: item.title })
            })
            const result = await publishNote({ event, relays: config.relays })

            if (result.accepted.length > 0) {
              stats.notesPublished++
              log(`published note ${event.id.slice(0, 8)} to ${result.accepted.length}/${config.relays.length} relays`)
            } else {
              stats.notesFailed++
              log(`no relay accepted note ${event.id.slice(0, 8)}: ${result.failed.map(f => `${f.url} (${f.reason})`).join(', ')}`)
            }
          } catch (error) {
            stats.notesFailed++
            log(`could not publish a note for item ${item.id}: ${error.message}`)
          }
        }
      } else {
        stats.unpaid++
        const sats = payIn.mcost != null ? Number(payIn.mcost) / 1000 : null
        const invoice = payIn.payerPrivates?.payInBolt11?.bolt11
        log(`comment ${commentId} on item ${item.id} was created but is NOT paid (state ${payIn.payInState}${sats != null ? `, ${sats} sats` : ''}).`)
        log('unpaid comments are only visible to the bot until the invoice is paid.')
        if (invoice) log(`invoice: ${invoice}`)
      }
    } catch (error) {
      stats.failed++
      log(`failed to handle item ${item.id}: ${error.message}`)
    }

    if (config.postDelayMs > 0) await sleep(config.postDelayMs)
  }

  const duration = ((Date.now() - startedAt) / 1000).toFixed(1)
  log(`done in ${duration}s: ${stats.withLinks} posts with links, ${stats.commented} commented, ${stats.alreadyCommented} already handled, ${stats.failed} failed, ${stats.unpaid} unpaid` +
    (config.publishNotes ? `, ${stats.notesPublished} notes published, ${stats.notesFailed} notes failed` : ''))

  await writeStepSummary([
    '### sn-twiiit run',
    '',
    `- redirector: \`${redirector.host}\`${redirector.attempts.length > 1 ? ` (after ${redirector.attempts.length - 1} unavailable)` : ''}`,
    `- balance: ${balance} sats (${satsWithoutCredits(wallet)} sats + ${wallet.credits} cowboy credits)${footer ? ' (low, zap footer added)' : ''}`,
    `- scanned: ${stats.scanned} posts from the last ${config.maxAgeMinutes} min (${pages} page(s)${truncated ? ', truncated by MAX_PAGES' : ''}), ${stats.withLinks} with x.com links`,
    `- commented: ${stats.commented}${config.dryRun ? ' (dry run)' : ''}`,
    `- already handled: ${stats.alreadyCommented}`,
    `- failed: ${stats.failed}`,
    `- unpaid: ${stats.unpaid}`,
    `- nostr notes: ${stats.notesPublished} published, ${stats.notesFailed} failed`,
    `- duration: ${duration}s`
  ].join('\n'))

  if (stats.unpaid > 0) {
    throw new Error('some comments were created unpaid and are not visible to others — fund the bot account with credits on stacker.news')
  }
  if (stats.failed > 0) {
    throw new Error(`${stats.failed} comment(s) failed`)
  }
}

main().catch(async error => {
  console.error(new Date().toISOString(), 'error:', error.message)
  await writeStepSummary(`### sn-twiiit run failed\n\n\`\`\`\n${error.message}\n\`\`\``)
  process.exitCode = 1
})
