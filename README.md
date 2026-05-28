# cloudmail

**An email inbox your AI agent can actually use.**

Agents constantly hit "check your email for a verification code" during signup. cloudmail
gives them a real email address on a domain you own (via Cloudflare), and a tiny command to
read what arrives — so an agent can sign itself up for things and grab the code, on its own.

```
someone emails  you@yourdomain  →  Cloudflare receives it  →  stored in your account
                                                                      ↓
                                              cloudmail latest / code / wait
```

Receive-only. No inbox to babysit, no IMAP, no server to run.

---

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/ratacat/cloudmail/main/install.sh | bash
```

Needs [Bun](https://bun.sh) and git. Installs a `cloudmail` launcher into `~/.local/bin`.

**Uninstall:**

```sh
curl -fsSL https://raw.githubusercontent.com/ratacat/cloudmail/main/install.sh | bash -s -- --uninstall
```

## Try it

```sh
cloudmail                 # help (run with no args anytime)
cloudmail latest          # show the newest email that arrived
cloudmail code --wait 60  # wait up to 60s for a verification code/link
cloudmail list            # recent emails
```

If you haven't pointed it at an inbox yet, see **Set up an inbox** below.

## Set up an inbox

You need one Cloudflare account with a domain on it. Then save a profile:

```sh
cloudmail config set me \
  --worker-url https://mail.yourdomain.tld \
  --api-key <your-worker-key> \
  --active
```

The worker that receives mail lives in [`worker/`](worker/) — `bun install` then
`bun run worker:deploy` deploys it, and a Cloudflare Email Routing rule points your address at
it. `cloudmail init` (one-command provisioning) is on the roadmap.

---

# For agents

Everything below is what an AI agent needs. cloudmail is built so an agent never has to
scrape human text: stable JSON, predictable exit codes, and a self-describing schema.

## Robot-mode guarantees

| Feature | Behavior |
|---------|----------|
| JSON output | `--json` on every command; envelope `{ ok, data, error, meta }`. **Auto-JSON when piped.** |
| Tiny help | bare `cloudmail` ≈100 tokens; `cloudmail robot-docs --json` = full machine schema |
| Structured errors | `{ code, message, suggestions[] }` |
| Exit codes | `0` ok · `1` not-found · `2` bad-args · `3` auth · `4` config · `5` cf-api · `6` network · `124` timeout |
| Token-efficient | email bodies truncated unless `--full`; everything else dense |

Discover the whole surface in one call:

```sh
cloudmail robot-docs --json
```

## Commands

```
latest     [--to A] [--since ISO]            newest email (one object)
list       [--limit N] [-n N] [--unread]     recent emails, newest first
get        <id>                              one email by id; marks it read
code       [--to A] [--since ISO] [--wait S] extract verification code/link (long-poll w/ --wait)
wait       [--to A] [--timeout S]            block until a new email arrives
config     get|set|list|use                  manage profiles (multi-account)
status                                       resolved profile + worker target
doctor                                       profile + worker reachability (never errors out)
robot-docs                                   machine schema of commands + codes
mcp                                          run as a stdio MCP server
```

Typical agent flow — sign up, then:

```sh
cloudmail code --wait 90 --json   # poll for the code that the signup just triggered
```

## MCP mode

```sh
cloudmail mcp   # stdio MCP server exposing: cloudmail_latest, _list, _get, _code, _wait
```

## Multi-account / config

Profiles live in `~/.cloudmail/profiles.json` (mode 0600). Switch with `--profile`/`-p`, or
set `CLOUDMAIL_WORKER_URL` + `CLOUDMAIL_API_KEY` for an ephemeral env profile (wins over saved).

```sh
cloudmail config set work --worker-url https://mail.acme.dev --api-key $KEY
cloudmail -p work latest
```

## Architecture

```
bin/cloudmail.ts     entry: parse → dispatch → emit → exit
src/contracts/       FROZEN shared types: exit, errors, envelope, types
src/cli/             parse.ts, dispatch.ts, commands/        (Command pattern)
src/format/          render.ts — human vs json                (Strategy)
src/core/            mailbox.ts (worker client), profile.ts (multi-account), extract.ts (pure)
src/cloudflare/      api.ts — Cloudflare REST adapter          (Adapter = "any account" seam)
src/mcp/             server.ts — stdio MCP server
worker/              deployed Worker: Email Routing + D1 + Workers-AI intent + long-poll
```

See [`AGENTS.md`](AGENTS.md) and [`INTERFACES.md`](INTERFACES.md) for conventions and the
frozen per-module contracts.

## Develop

```sh
bun test
bun run typecheck
bun run cli -- latest --json
```

## Security

This address is an identity root — password resets and magic links arrive here. Keep the
worker `API_KEY` secret and require human approval before an agent creates accounts or clicks
sensitive links. The worker is receive-only by design.

## License

MIT
