import test from 'node:test'
import assert from 'node:assert/strict'

import { buildJob, dispatchMinutes, jobTitle } from '../scripts/schedule-cron.mjs'

const githubToken = 'github-secret'

test('job posts to the workflow dispatch endpoint every five minutes', () => {
  const job = buildJob({ githubToken })

  assert.equal(job.url, 'https://api.github.com/repos/twiiit/sn/actions/workflows/bot.yml/dispatches')
  assert.equal(job.enabled, true)
  assert.equal(job.requestMethod, 1)
  assert.deepEqual(job.schedule.minutes, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
  assert.deepEqual(job.schedule.hours, [-1])
  assert.equal(job.schedule.timezone, 'UTC')
})

test('dispatch body asks for a real run on main', () => {
  const body = JSON.parse(buildJob({ githubToken }).extendedData.body)

  assert.equal(body.ref, 'main')
  // string on purpose: the REST API takes string inputs, and the workflow's
  // manual default is dry_run=true
  assert.equal(body.inputs.dry_run, 'false')
})

test('sends the GitHub token as a request header, not in the URL or body', () => {
  const job = buildJob({ githubToken })

  assert.equal(job.extendedData.headers.Authorization, 'Bearer github-secret')
  assert.equal(job.extendedData.headers.Accept, 'application/vnd.github+json')
  assert.ok(!job.url.includes('github-secret'))
  assert.ok(!job.extendedData.body.includes('github-secret'))
})

test('notifies when the job starts failing or gets disabled', () => {
  const job = buildJob({ githubToken })

  // cron-job.org disables a job after 25 consecutive failures, which is what an
  // expired PAT looks like, so the first few failures should already be mailed
  assert.equal(job.notification.onFailure, true)
  assert.equal(job.notification.onFailureCount, 3)
  assert.equal(job.notification.onDisable, true)
})

test('converts an interval into the minutes cron-job.org expects', () => {
  assert.deepEqual(dispatchMinutes(5), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
  assert.deepEqual(dispatchMinutes(15), [0, 15, 30, 45])
  assert.deepEqual(dispatchMinutes(1).length, 60)
  // intervals that do not divide an hour would drift, so they are refused
  assert.throws(() => dispatchMinutes(7), /divide 60 evenly/)
  assert.throws(() => dispatchMinutes(0), /between 1 and 60/)
  assert.throws(() => dispatchMinutes(90), /between 1 and 60/)
})

test('names the job after the repo so re-runs find it again', () => {
  assert.equal(buildJob({ githubToken }).title, jobTitle('twiiit/sn'))
  assert.match(buildJob({ githubToken }).title, /twiiit\/sn/)
  assert.equal(buildJob({ githubToken, title: 'custom' }).title, 'custom')
})

test('honours overrides for repo, workflow and ref', () => {
  const job = buildJob({ githubToken, repo: 'someone/else', workflow: 'other.yml', ref: 'release', intervalMinutes: 15 })

  assert.equal(job.url, 'https://api.github.com/repos/someone/else/actions/workflows/other.yml/dispatches')
  assert.equal(JSON.parse(job.extendedData.body).ref, 'release')
  assert.deepEqual(job.schedule.minutes, [0, 15, 30, 45])
})

test('refuses to build a job without a token or a usable repo', () => {
  assert.throws(() => buildJob({}), /GITHUB_DISPATCH_TOKEN/)
  assert.throws(() => buildJob({ githubToken, repo: 'nope' }), /owner\/name/)
})
