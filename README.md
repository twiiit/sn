# sn-twiiit

A small bot for [Stacker News](https://stacker.news/twiiit) that watches new posts
and, whenever a post links to `x.com` / `twitter.com`, replies with the same link
pointing at a privacy-friendly [nitter](https://github.com/zedeus/nitter)
redirector instead — [twiiit.com](https://twiiit.com) by default.

```
post:  https://x.com/jack/status/20
reply: https://twiiit.com/jack/status/20
```

It is a spiritual successor to [ekzyis/nitterbot](https://github.com/ekzyis/nitterbot),
which ran as [@nitter](https://stacker.news/nitter) and is no longer active.

The bot logs in as **@twiiit** with a nostr secret key (`nsec`) and runs on GitHub
Actions on a schedule, so there is no server to maintain.

## How it works

Every run (scheduled every 5 minutes — see [Coverage](#coverage) for how often
GitHub actually runs it):

1. **Pick a redirector.** Reads the redirector list from the
   [shitter wiki](https://codeberg.org/shitter/shitter/wiki/Instances#redirectors),
   then health checks candidates in order — `twiiit.com` first, followed by the
   other redirectors from the wiki, followed by a small built-in fallback list.
   The first one that answers `/<user>/status/<id>` with a success or a redirect
   (and does not redirect back to x.com) is used. If the wiki is unreachable the
   built-in list is used; if nothing is healthy the bot refuses to post.
2. **Log in.** Asks stacker.news for a login challenge (`createAuth`), signs it
   with the nsec (a NIP-98 style `kind 27235` event), and exchanges it for a
   session cookie via `/api/auth/callback/nostr`. It then verifies that the
   session belongs to `SN_BOT_NAME` (`twiiit`) and aborts otherwise.
3. **Check the balance.** Reads the account's `sats` + cowboy credits and logs
   them. Comments are paid from both (~1 sat each), so the balance is roughly how
   many replies the bot can still post. When it drops below
   `SN_LOW_BALANCE_SATS` (default 100), replies get a one line footnote inviting
   readers to zap them — see [Funding](#funding).
4. **Scan.** Reads the newest items back to `ITEM_MAX_AGE_MINUTES` (default 180),
   keeping top level posts, and looks for x.com/twitter.com status links in the
   post URL, title and text. stacker.news caps a request at 100 items, so the
   window is covered by following the feed's cursor back a page at a time (at
   most `MAX_PAGES`, default 5) — see [Coverage](#coverage).
5. **Reply.** For each post with links it posts one comment containing the
   rewritten links (one per line). Before posting it checks whether the bot
   already commented on that post — using `newComments` for the post — so a run
   that overlaps or repeats never posts twice. At most `MAX_COMMENTS_PER_RUN`
   (default 20) comments are posted per run.
6. **Crosspost.** Once a comment is actually paid for, the same links are signed
   as a nostr note with the bot's key and published to relays — see
   [Nostr notes](#nostr-notes).

## Setup

1. Create the repository secret **`SN_NSEC`** with the `nsec` of the @twiiit
   account (Settings → Secrets and variables → Actions → New repository secret).
   The pubkey of that nsec must be linked to the account as a nostr login method.
2. Make sure Actions are enabled. The default branch is scanned on a 5 minute
   cron; the workflow can also be started manually (Settings → Actions →
   sn-twiiit bot → Run workflow), which defaults to a **dry run**.
3. **Fund the bot account.** Stacker News charges ~1 sat per comment, paid from
   the account's credits/reward sats. Buy a small amount of credits for @twiiit
   (a few thousand sats lasts a very long time). Without a balance, new accounts
   only get 5 free comments per month; after that the comment is created as an
   *unpaid*, invisible-to-others draft — the bot detects this, stops the run and
   fails the workflow so you notice.

## Nostr notes

Stacker News does not crosspost comments (its crossposter is wired to the post
form and the manual share button), so the bot publishes its own `kind 1` notes
with the same `nsec` it logs in with — no extra secret. A note contains the
rewritten links plus a link to the stacker.news post:

```
https://twiiit.com/jack/status/20

https://stacker.news/items/1603795
```

Relays are [the ones stacker.news crossposts to](https://github.com/stackernews/stacker.news/blob/master/lib/nostr.js)
(`DEFAULT_RELAYS` in [src/nostr.js](src/nostr.js)), so notes land where SN
crossposts land; `NOSTR_RELAYS` overrides them with a comma separated list, and
`NOSTR_DISABLED=1` turns note publishing off.

Notes are best effort: each relay is published to independently, a relay that is
down, blocks datacenter IPs or never answers cannot hold up the run, and a note
that reaches zero relays is logged and reported in the step summary without
failing the workflow — the stacker.news comment already worked.

Zaps on the notes go to the `lud16` in the bot's nostr profile
(`twiiit@rizful.com`), so the note itself carries no donation text.

## Funding

The bot is funded by zaps. Every comment it posts has a zap button, and zaps to
it land in the account's cowboy credits, which pay for the next comments.

So it does not beg on every reply, the ask is a low balance signal only: below
`SN_LOW_BALANCE_SATS` (default 100, i.e. ~100 replies left) each comment gets a
small GFM footnote — a superscript marker next to the links and a muted line at
the bottom:

```
https://twiiit.com/jack/status/20 [^1]

[^1]: bot · funded by zaps — zap this comment or send sats to `twiiit@rizful.com`
```

The address is wrapped in backticks because stacker.news autolinks bare email
addresses and renders the visible text as `mailto:twiiit@rizful.com`.

The footnote text is `SN_FUNDING_FOOTER`, so the address can be changed without
touching the bot. Once the balance is back above the threshold, the footnote
disappears by itself. Set `SN_LOW_BALANCE_SATS=0` to never show it.

### Optional repository variable

| Variable | Default | Meaning |
| --- | --- | --- |
| `SN_REDIRECTOR` | `twiiit.com` | Preferred redirector host. Still health checked; if it is down the bot falls back to the wiki list. |
| `SN_LOW_BALANCE_SATS` | `100` | Invite zaps in replies while the balance is below this. `0` disables the footer. |

### Optional environment overrides

Set these in the workflow `env:` block or locally in `.env`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SN_BASE_URL` | `https://stacker.news` | Stacker News instance |
| `SN_BOT_NAME` | `twiiit` | Expected account name (safety check) |
| `DRY_RUN` | off | Log what would be commented, post nothing |
| `ITEM_MAX_AGE_MINUTES` | `180` | Ignore posts older than this (the scan window) |
| `MAX_ITEMS` | `100` | Items per request; 100 is stacker.news' maximum |
| `MAX_PAGES` | `5` | How many pages to read per run at most |
| `MAX_COMMENTS_PER_RUN` | `20` | Comment limit per run |
| `POST_DELAY_MS` | `5000` | Pause between comments |
| `SN_LOW_BALANCE_SATS` | `100` | Balance (sats + cowboy credits) below which replies invite zaps |
| `SN_FUNDING_FOOTER` | `bot · funded by zaps — …` | Text of that footnote |
| `NOSTR_RELAYS` | stacker.news crosspost relays | Comma separated relay list for notes |
| `NOSTR_DISABLED` | off | Do not publish notes, only comment on stacker.news |

## Coverage

GitHub does not guarantee when a scheduled workflow runs. Its
[docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
note that `schedule` "can be delayed during periods of high loads", that high
load includes the start of every hour, and that "some queued jobs may be
dropped". In practice a `*/5` cron on a small repository runs far less often:
measured here on 2026-10-28, four scheduled runs landed at 10:15, 11:02, 11:45
and 12:23 — roughly every 40 minutes. Each run itself is quick (13–40s), so the
spacing is the scheduler, not a slow or blocked run.

That is why the window is 180 minutes rather than 60: it needs to be wider than
the worst gap between runs, and much wider than the average one. A post that
appears just after a run still has to survive two or three missed runs before it
ages out. Overlapping windows cost nothing, because a post the bot already
replied to is skipped.

The scan reads as many pages as the window needs: 100 items currently covers
about 3.7 hours of stacker.news posts (~27/hour), so the default window fits in a
single page, and busier periods page further back automatically. If `MAX_PAGES`
is reached before the window, the run logs a warning and reports it in the step
summary instead of silently scanning less than it claims.

A dry run that needs to look further back than 100 items is the one case where
`MAX_ITEMS` alone used to matter; it is now the page size, and `MAX_PAGES` sets
the depth.

## Local development

```sh
npm install
cp .env.example .env   # add your nsec
DRY_RUN=true npm run dev
npm test
```

`npm run dev` loads `.env` via Node's `--env-file`.

## Notes and limitations

- Only top level posts are checked. Links that appear inside comments are ignored.
- A post that already got a bot reply is skipped forever, even if the redirector
  used in that reply later stops working. Deleting the bot comment makes the bot
  reply again on the next run (as long as the post is still within the age window).
- The bot posts as a normal user, so comments are subject to Stacker News' rules
  and spam limits. Keep `MAX_COMMENTS_PER_RUN` and the delay polite.
- Redirector health is checked from the GitHub Actions runner, which is a
  datacenter IP: a redirector may look healthy there but be rate limiting for
  some end users. The wiki list itself is the best source of truth for how well
  instances are doing.
- The funding footnote only exists on stacker.news: it is markdown, and notes
  are published as plain text, so it is deliberately left out of the note body
  (zaps on the note go through the `lud16` in the bot's nostr profile). If you
  ever move the ask into the note, avoid the footnote syntax — clients without
  footnote support show `[^1]:` literally. Stacker News itself also supports
  `<sub>…</sub>` if you prefer a smaller inline line.
- GitHub disables scheduled workflows in public repositories after 60 days
  without repository activity, and a scheduled run is not documented as counting
  as activity by itself — so a bot that only runs on cron can quietly die. The
  [keepalive](.github/workflows/keepalive.yml) workflow commits a timestamp to
  `.github/keepalive` on the 1st and 15th of every month, which is real activity
  on the default branch and keeps both workflows enabled. If it ever misses more
  than that, GitHub emails a warning and disables them: re-enable with
  `gh workflow enable keepalive` and `gh workflow enable 'sn-twiiit bot'`.
