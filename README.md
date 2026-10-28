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

Every run (every 5 minutes):

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
4. **Scan.** Fetches the newest items, keeps top level posts younger than
   `ITEM_MAX_AGE_MINUTES` (default 60), and looks for x.com/twitter.com status
   links in the post URL, title and text.
5. **Reply.** For each post with links it posts one comment containing the
   rewritten links (one per line). Before posting it checks whether the bot
   already commented on that post — using `newComments` for the post — so a run
   that overlaps or repeats never posts twice. At most `MAX_COMMENTS_PER_RUN`
   (default 20) comments are posted per run.

## Setup

1. Create the repository secret **`SN_NSEC`** with the `nsec` of the @twiiit
   account (Settings → Secrets and variables → Actions → New repository secret).
   The pubkey of that nsec must be linked to the account as a nostr login method.
2. Make sure Actions are enabled. The default branch is scanned every 5 minutes;
   the workflow can also be started manually (Settings → Actions → sn-twiiit bot
   → Run workflow), which defaults to a **dry run**.
3. **Fund the bot account.** Stacker News charges ~1 sat per comment, paid from
   the account's credits/reward sats. Buy a small amount of credits for @twiiit
   (a few thousand sats lasts a very long time). Without a balance, new accounts
   only get 5 free comments per month; after that the comment is created as an
   *unpaid*, invisible-to-others draft — the bot detects this, stops the run and
   fails the workflow so you notice.

## Funding

The bot is funded by zaps. Every comment it posts has a zap button, and zaps to
it land in the account's cowboy credits, which pay for the next comments.

So it does not beg on every reply, the ask is a low balance signal only: below
`SN_LOW_BALANCE_SATS` (default 100, i.e. ~100 replies left) each comment gets a
small GFM footnote — a superscript marker next to the links and a muted line at
the bottom:

```
https://twiiit.com/jack/status/20 [^1]

[^1]: bot · funded by zaps — zap this comment or send sats to twiiit@rizful.com
```

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
| `ITEM_MAX_AGE_MINUTES` | `60` | Ignore posts older than this |
| `MAX_ITEMS` | `100` | How many recent items to fetch |
| `MAX_COMMENTS_PER_RUN` | `20` | Comment limit per run |
| `POST_DELAY_MS` | `5000` | Pause between comments |
| `SN_LOW_BALANCE_SATS` | `100` | Balance (sats + cowboy credits) below which replies invite zaps |
| `SN_FUNDING_FOOTER` | `bot · funded by zaps — …` | Text of that footnote |

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
- If the account has nostr crossposting enabled, replies are published as notes
  too. The funding footnote is markdown: clients that understand footnotes show a
  small note at the bottom, plain text clients show the `[^1]:` line literally.
  Stacker News also supports `<sub>…</sub>`, which is a drop-in alternative in
  `buildComment` if the footnote looks bad on nostr.
- GitHub disables scheduled workflows in public repositories after 60 days
  without repository activity. If the bot goes quiet, re-enable the workflow in
  the Actions tab (or push any commit, e.g. a touch to this README).
