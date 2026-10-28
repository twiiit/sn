#!/usr/bin/env node
// Gives the bot a dependable cadence by having cron-job.org call GitHub's
// workflow_dispatch API every few minutes.
//
// GitHub's own scheduler is best effort: this repo's `*/5` cron actually ran
// roughly every 40 minutes (see README "Coverage"), which is slow enough for
// posts to age out. cron-job.org is a cron for arbitrary URLs, so it can poke
// GitHub on time without any server running here.
//
//   npm run schedule             create or update the job
//   npm run schedule -- --check  check the GitHub token and workflow only
//   npm run schedule -- --show   list this repo's job
//   npm run schedule -- --history last executions, with HTTP status
//   npm run schedule -- --delete remove the job
//
// Needs, in .env (never in the repository):
//   GITHUB_DISPATCH_TOKEN  fine grained PAT with "Actions: read and write"
//   CRONJOB_API_KEY        cron-job.org Console -> Settings -> API key

import { pathToFileURL } from 'node:url'

const DEFAULT_REPO = 'twiiit/sn'
const DEFAULT_WORKFLOW = 'bot.yml'
const DEFAULT_REF = 'main'
const DEFAULT_INTERVAL_MINUTES = 5
const DEFAULT_API_URL = 'https://api.cron-job.org'
const GITHUB_API = 'https://api.github.com'

// cron-job.org takes explicit minutes rather than a cron expression
export function dispatchMinutes (intervalMinutes = DEFAULT_INTERVAL_MINUTES) {
  const interval = Number(intervalMinutes)
  if (!Number.isInteger(interval) || interval < 1 || interval > 60) {
    throw new Error('interval must be a whole number of minutes between 1 and 60')
  }
  if (60 % interval !== 0) {
    throw new Error(`interval must divide 60 evenly, otherwise the schedule drifts (got ${interval})`)
  }

  const minutes = []
  for (let minute = 0; minute < 60; minute += interval) minutes.push(minute)
  return minutes
}

export function jobTitle (repo) {
  return `sn-twiiit dispatch (${repo})`
}

/**
 * The cron-job.org job that dispatches this repo's workflow. Pure so the shape
 * can be tested without touching either service.
 */
export function buildJob ({
  repo = DEFAULT_REPO,
  workflow = DEFAULT_WORKFLOW,
  ref = DEFAULT_REF,
  intervalMinutes = DEFAULT_INTERVAL_MINUTES,
  githubToken,
  title
} = {}) {
  if (!repo || !repo.includes('/')) throw new Error('repo must look like "owner/name"')
  if (!githubToken) throw new Error('GITHUB_DISPATCH_TOKEN is not set')

  return {
    url: `${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}/dispatches`,
    title: title ?? jobTitle(repo),
    enabled: true,
    // keep response headers for 2 days so a failure can be inspected later
    saveResponses: true,
    // 1 = POST
    requestMethod: 1,
    requestTimeout: 30,
    schedule: {
      timezone: 'UTC',
      expiresAt: 0,
      hours: [-1],
      mdays: [-1],
      minutes: dispatchMinutes(intervalMinutes),
      months: [-1],
      wdays: [-1]
    },
    extendedData: {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      // `dry_run` is explicit on purpose: the workflow defaults a manual
      // dispatch to a dry run, and the scheduler must never trip over that.
      body: JSON.stringify({ ref, inputs: { dry_run: 'false' } })
    },
    notification: {
      // cron-job.org disables a job after 25 consecutive failures (an expired
      // PAT is the usual cause), so say so early instead of silently going quiet
      onFailure: true,
      onFailureCount: 3,
      onDisable: true
    }
  }
}

function readConfig () {
  return {
    repo: process.env.DISPATCH_REPO || DEFAULT_REPO,
    workflow: process.env.DISPATCH_WORKFLOW || DEFAULT_WORKFLOW,
    ref: process.env.DISPATCH_REF || DEFAULT_REF,
    intervalMinutes: Number(process.env.DISPATCH_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES),
    apiUrl: process.env.CRONJOB_API_URL || DEFAULT_API_URL,
    apiKey: process.env.CRONJOB_API_KEY,
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
  const res = await fetch(`${GITHUB_API}/repos/${repo}/actions/workflows/${workflow}`, {
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
}

async function main () {
  const args = new Set(process.argv.slice(2))
  const config = readConfig()

  if (!config.apiKey) return fail('CRONJOB_API_KEY is not set (cron-job.org Console -> Settings -> API key)')
  if (!config.githubToken) return fail('GITHUB_DISPATCH_TOKEN is not set (fine grained PAT, Actions: read and write)')

  const api = config.apiUrl.replace(/\/+$/, '')
  const headers = {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json'
  }

  const listJobs = async () => {
    const res = await fetch(`${api}/jobs`, { headers })
    if (!res.ok) throw new Error(`could not list cron-job.org jobs (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    return (await res.json()).jobs ?? []
  }

  const title = jobTitle(config.repo)

  if (args.has('--show')) {
    const jobs = await listJobs()
    if (jobs.length === 0) return console.log('no jobs on this account')
    for (const job of jobs) {
      const minutes = job.schedule?.minutes?.join(',') ?? ''
      console.log(`${job.jobId} | ${job.enabled ? 'enabled ' : 'disabled'} | minutes: ${minutes} | ${job.url}${job.title ? ` | ${job.title}` : ''}`)
    }
    return
  }

  if (args.has('--check')) {
    await checkGithub(config)
    return
  }

  const existing = (await listJobs()).find(job => job.title === title)

  if (args.has('--delete')) {
    if (!existing) return console.log(`no job titled "${title}" to delete; the workflow keeps its own */5 fallback cron`)
    const res = await fetch(`${api}/jobs/${existing.jobId}`, { method: 'DELETE', headers })
    if (!res.ok) return fail(`could not delete job ${existing.jobId} (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    console.log(`deleted job ${existing.jobId}; the workflow keeps its own */5 fallback cron`)
    return
  }

  const job = buildJob(config)

  if (args.has('--history')) {
    if (!existing) return fail(`no job titled "${title}" — run "npm run schedule" first`)
    const res = await fetch(`${api}/jobs/${existing.jobId}/history`, { headers })
    if (!res.ok) return fail(`could not read history (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`)
    const { history = [] } = await res.json()
    if (history.length === 0) return console.log('no executions yet')
    for (const entry of history.slice(0, 8)) {
      const when = new Date(entry.date * 1000).toISOString()
      console.log(`${when} | ${entry.statusText} | HTTP ${entry.httpStatus} | planned ${new Date(entry.datePlanned * 1000).toISOString()} | ${Math.round((entry.jitter ?? 0) / 100) / 10}s jitter`)
    }
    return
  }

  await checkGithub(config)

  // reuse the existing job so re-running never stacks up duplicate schedules
  const res = existing
    ? await fetch(`${api}/jobs/${existing.jobId}`, { method: 'PATCH', headers, body: JSON.stringify({ job }) })
    : await fetch(`${api}/jobs`, { method: 'PUT', headers, body: JSON.stringify({ job }) })
  const text = await res.text().catch(() => '')

  if (!res.ok) {
    return fail(`cron-job.org refused the job (HTTP ${res.status}): ${text.slice(0, 300)}`)
  }

  const jobId = existing ? existing.jobId : JSON.parse(text || '{}').jobId

  const details = await fetch(`${api}/jobs/${jobId}`, { headers }).then(r => (r.ok ? r.json() : null)).catch(() => null)
  const next = details?.jobDetails?.nextExecution
  const confirmed = details?.jobDetails?.schedule?.minutes?.join(',')

  console.log(`${existing ? 'updated' : 'created'} job ${jobId}: ${job.url}`)
  console.log(`every ${config.intervalMinutes} min (minutes ${confirmed ?? job.schedule.minutes.join(',')}), POST ${job.extendedData.body}`)
  if (next) console.log(`next execution: ${new Date(next * 1000).toISOString()}`)
  console.log(`tokens: cron-job.org ${mask(config.apiKey)}, github ${mask(config.githubToken)}`)
  console.log('verify with: npm run schedule -- --history')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => fail(error.message))
}
