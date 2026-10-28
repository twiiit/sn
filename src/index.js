#!/usr/bin/env node
// Scans recent stacker.news posts for x.com links and replies with the same
// links pointing at a working nitter redirector (twiiit.com by default).

import { appendFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

import { StackerNewsClient } from './stackernews.js'
import { selectRedirector } from './redirectors.js'
import { findStatusLinks, buildComment } from './links.js'

const log = (...args) => console.log(new Date().toISOString(), ...args)

// stacker.news pays for each comment from sats + cowboy credits (~1 sat), and
// only writes it unpaid when both run out. This footnote only shows up when the
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

function readConfig () {
  return {
    baseUrl: (process.env.SN_BASE_URL || 'https://stacker.news').trim(),
    nsec: process.env.SN_NSEC,
    botName: (process.env.SN_BOT_NAME || 'twiiit').trim(),
    preferredRedirector: process.env.SN_REDIRECTOR,
    dryRun: envBool('DRY_RUN'),
    maxItems: envInt('MAX_ITEMS', 100),
    maxAgeMinutes: envInt('ITEM_MAX_AGE_MINUTES', 60),
    maxCommentsPerRun: envInt('MAX_COMMENTS_PER_RUN', 20),
    postDelayMs: envInt('POST_DELAY_MS', 5000),
    lowBalanceSats: envInt('SN_LOW_BALANCE_SATS', 100),
    fundingFooter: (process.env.SN_FUNDING_FOOTER || DEFAULT_FUNDING_FOOTER).trim()
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

  // 1 comment costs ~1 sat, so the balance is roughly the number of replies left
  const wallet = await sn.fetchWallet()
  const balance = wallet.sats + wallet.credits
  const lowBalance = config.lowBalanceSats > 0 && balance < config.lowBalanceSats
  const footer = lowBalance ? config.fundingFooter : ''
  log(`balance: ${wallet.sats} sats + ${wallet.credits} cowboy credits` +
    (footer ? ` (below ${config.lowBalanceSats}, replies will invite zaps)` : ''))

  const maxAgeMs = config.maxAgeMinutes * 60_000
  const items = await sn.recentItems({ limit: config.maxItems })
  log(`fetched ${items.length} recent items`)

  const candidates = items
    .filter(item => isCandidate(item, { now: Date.now(), maxAgeMs, botName: config.botName }))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))

  const stats = { scanned: candidates.length, withLinks: 0, commented: 0, alreadyCommented: 0, failed: 0, unpaid: 0 }

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
        continue
      }

      const payIn = await sn.createComment({ parentId: item.id, text })
      const commentId = payIn.payerPrivates?.result?.id

      if (payIn.payInState === 'PAID') {
        stats.commented++
        log(`commented on item ${item.id} (comment ${commentId})`)
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
  log(`done in ${duration}s: ${stats.withLinks} posts with links, ${stats.commented} commented, ${stats.alreadyCommented} already handled, ${stats.failed} failed, ${stats.unpaid} unpaid`)

  await writeStepSummary([
    '### sn-twiiit run',
    '',
    `- redirector: \`${redirector.host}\`${redirector.attempts.length > 1 ? ` (after ${redirector.attempts.length - 1} unavailable)` : ''}`,
    `- balance: ${wallet.sats} sats + ${wallet.credits} cowboy credits${footer ? ' (low, zap footer added)' : ''}`,
    `- scanned: ${stats.scanned} recent posts, ${stats.withLinks} with x.com links`,
    `- commented: ${stats.commented}${config.dryRun ? ' (dry run)' : ''}`,
    `- already handled: ${stats.alreadyCommented}`,
    `- failed: ${stats.failed}`,
    `- unpaid: ${stats.unpaid}`,
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
