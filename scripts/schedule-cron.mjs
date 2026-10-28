#!/usr/bin/env node
// Gives the bot a dependable cadence by having Upstash QStash call GitHub's
// workflow_dispatch API every 5 minutes.
//
// GitHub's own scheduler is best effort: this repo's `*/5` cron actually ran
// roughly every 40 minutes (see README "Coverage"), which is slow enough for
// posts to age out. QStash is a cron that calls a URL, so it does not need a
// server running here.
//
//   npm run schedule             create or update the schedule
//   npm run schedule -- --check  check the GitHub token and the workflow only
//   npm run schedule -- --show   list the schedules on the QStash account
//   npm run schedule -- --delete remove this schedule
//
// Needs, in .env (never in the repository):
//   GITHUB_DISPATCH_TOKEN  fine grained PAT with "Actions: read and write"
//   QSTASH_TOKEN           from the Upstash console

import { pathToFileURL } from 'node:url'

const DEFAULT_REPO = 'twiiit/sn'
const DEFAULT_WORKFLOW = 'bot.yml'
const DEFAULT_REF = 'main'
const DEFAULT_CRON = '*/5 * * * *'
const DEFAULT_SCHEDULE_ID = 'sn-twiiit-dispatch'
const DEFAULT_QSTASH_URL = 'https://qstash.upstash.io'
const GITHUB_API = 'https://api.github.com'

/**
 * The request that registers the schedule with QStash. Pure so it can be tested
 * without touching either service.
 */
export function buildScheduleRequest ({
  repo = DEFAULT_REPO,
  workflow = DEFAULT_WORKFLOW,
  ref = DEFAULT_REF,
  cron = DEFAULT_CRON,
  scheduleId = DEFAULT_SCHEDULE_ID,
  qstashToken,
  githubToken,
  qstashUrl = DEFAULT_QSTASH_URL
} = {}) {
  if (!repo || !repo.includes('/')) throw new Error('repo must look like "owner/name"')
  if (!qstashToken) throw new Error('QSTASH_TOKEN is not set')
  if (!githubToken) throw new Error('GITHUB_DISPATCH_TOKEN is not set')

  const destination = `${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}/dispatches`

  return {
    url: `${qstashUrl}/v2/schedules/${destination}`,
    method: 'POST',
    headers: {
      authorization: `Bearer ${qstashToken}`,
      'content-type': 'application/json',
      // when QStash should publish, and which schedule to overwrite on re-run
      'upstash-cron': cron,
      'upstash-schedule-id': scheduleId,
      // a GitHub blip should be retried, not skipped until the next tick
      'upstash-retries': '2',
      // Upstash-Forward-* is stripped and sent as a plain header to GitHub
      'upstash-forward-accept': 'application/vnd.github+json',
      'upstash-forward-authorization': `Bearer ${githubToken}`,
      'upstash-forward-x-github-api-version': '2022-11-28'
    },
    // `dry_run` is explicit on purpose: the workflow defaults a manual dispatch
    // to a dry run, and the dispatcher must never trip over that default.
    body: JSON.stringify({ ref, inputs: { dry_run: 'false' } })
  }
}

function readConfig () {
  return {
    repo: process.env.DISPATCH_REPO || DEFAULT_REPO,
    workflow: process.env.DISPATCH_WORKFLOW || DEFAULT_WORKFLOW,
    ref: process.env.DISPATCH_REF || DEFAULT_REF,
    cron: process.env.DISPATCH_CRON || DEFAULT_CRON,
    scheduleId: process.env.QSTASH_SCHEDULE_ID || DEFAULT_SCHEDULE_ID,
    qstashUrl: process.env.QSTASH_URL || DEFAULT_QSTASH_URL,
    qstashToken: process.env.QSTASH_TOKEN,
    githubToken: process.env.GITHUB_DISPATCH_TOKEN
  }
}

const mask = token => (token ? `${String(token).slice(0, 4)}…${String(token).slice(-4)}` : '(missing)')

function fail (message) {
  console.error(`error: ${message}`)
  process.exitCode = 1
}

/** Confirms the token can see the workflow and that it accepts a dispatch. */
async function checkGithub ({ repo, workflow, githubToken }) {
  const url = `${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}`
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    }
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`GitHub rejected GITHUB_DISPATCH_TOKEN (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }

  const data = await res.json()
  if (!String(data.state ?? '').includes('active')) {
    throw new Error(`workflow ${workflow} is "${data.state}", not active — enable it before scheduling (gh workflow enable '${workflow}')`)
  }

  console.log(`github: ${repo} ${data.name ?? workflow} is ${data.state}`)
  return data
}

async function main () {
  const args = new Set(process.argv.slice(2))
  const config = readConfig()

  if (!config.qstashToken) return fail('QSTASH_TOKEN is not set (see .env.example)')
  if (!config.githubToken) return fail('GITHUB_DISPATCH_TOKEN is not set (see .env.example)')

  const QSTASH_AUTH = { authorization: `Bearer ${config.qstashToken}` }

  if (args.has('--show')) {
    const res = await fetch(`${config.qstashUrl}/v2/schedules`, { headers: QSTASH_AUTH })
    if (!res.ok) return fail(`could not list schedules (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    const schedules = await res.json()
    if (schedules.length === 0) console.log('no schedules on this account')
    for (const schedule of schedules) {
      console.log(`${schedule.scheduleId} | ${schedule.cron} | ${schedule.destination}`)
    }
    return
  }

  if (args.has('--delete')) {
    const res = await fetch(`${config.qstashUrl}/v2/schedules/${config.scheduleId}`, { method: 'DELETE', headers: QSTASH_AUTH })
    if (!res.ok) return fail(`could not delete ${config.scheduleId} (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    console.log(`deleted schedule ${config.scheduleId}; the workflow keeps its own */5 fallback cron`)
    return
  }

  await checkGithub(config)
  if (args.has('--check')) return

  const request = buildScheduleRequest(config)
  const res = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body
  })
  const text = await res.text().catch(() => '')

  if (!res.ok) {
    return fail(`QStash refused the schedule (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }

  console.log(`scheduled ${config.cron} -> ${JSON.parse(request.body).ref} (dry_run=false)`)
  console.log(`schedule id: ${config.scheduleId} (${text.slice(0, 200)})`)
  console.log(`qstash token: ${mask(config.qstashToken)}, github token: ${mask(config.githubToken)}`)
  console.log('the first dispatch can take up to a minute to appear: gh run list --event workflow_dispatch')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => fail(error.message))
}
