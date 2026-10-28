import test from 'node:test'
import assert from 'node:assert/strict'

import { buildScheduleRequest } from '../scripts/schedule-cron.mjs'

const base = { qstashToken: 'qstash-secret', githubToken: 'github-secret' }

test('dispatch schedule points at the workflow dispatch endpoint', () => {
  const request = buildScheduleRequest(base)

  assert.equal(
    request.url,
    'https://qstash.upstash.io/v2/schedules/https://api.github.com/repos/twiiit/sn/actions/workflows/bot.yml/dispatches'
  )
  assert.equal(request.method, 'POST')
  assert.equal(request.headers['upstash-cron'], '*/5 * * * *')
  assert.equal(request.headers['upstash-schedule-id'], 'sn-twiiit-dispatch')
})

test('dispatches a real run on main, never a dry run', () => {
  const body = JSON.parse(buildScheduleRequest(base).body)

  assert.equal(body.ref, 'main')
  // string on purpose: the REST API takes string inputs, and the workflow's
  // manual default is dry_run=true
  assert.equal(body.inputs.dry_run, 'false')
})

test('forwards the GitHub token without reusing the QStash credential', () => {
  const { headers } = buildScheduleRequest(base)

  assert.equal(headers.authorization, 'Bearer qstash-secret')
  assert.equal(headers['upstash-forward-authorization'], 'Bearer github-secret')
  assert.equal(headers['upstash-forward-accept'], 'application/vnd.github+json')
  // the GitHub token must never travel as a QStash header
  assert.ok(!Object.entries(headers).some(([name, value]) => name === 'authorization' && String(value).includes('github-secret')))
})

test('honours overrides for repo, ref and cron', () => {
  const request = buildScheduleRequest({ ...base, repo: 'someone/else', workflow: 'other.yml', ref: 'release', cron: '*/10 * * * *' })

  assert.match(request.url, /repos\/someone\/else\/actions\/workflows\/other\.yml\/dispatches$/)
  assert.equal(request.headers['upstash-cron'], '*/10 * * * *')
  assert.equal(JSON.parse(request.body).ref, 'release')
})

test('refuses to build a request without both credentials', () => {
  assert.throws(() => buildScheduleRequest({ githubToken: 'github-secret' }), /QSTASH_TOKEN/)
  assert.throws(() => buildScheduleRequest({ qstashToken: 'qstash-secret' }), /GITHUB_DISPATCH_TOKEN/)
  assert.throws(() => buildScheduleRequest({ ...base, repo: 'nope' }), /owner\/name/)
})
