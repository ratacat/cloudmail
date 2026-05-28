# cloudmail — agent guide

A robot-mode CLI that gives an AI agent a **disposable email identity** on *any*
Cloudflare account. Built for the signup → verification-code flow: provision an
inbox, then read mail and pull codes/links with dense, machine-parseable output.

## What it is

- **Client** (hot path): `latest`, `list`, `get`, `code`, `wait` — read mail, extract codes.
- **Admin**: `init`, `status`, `doctor`, `config` — provision/manage the stack on a chosen account.
- **Deployable artifact**: a Cloudflare Worker (`worker/`) + D1 that receives mail via Email
  Routing, parses it (postal-mime), optionally classifies intent (Workers AI), and exposes a
  bearer-authed read API. Receive-only by design.

## Robot-mode contract (stable — agents depend on it)

- `--json` on every command; `{ ok, data, error, meta }` envelope. Auto-JSON when stdout is not a TTY.
- Bare `cloudmail` prints a ~100-token help list. `cloudmail robot-docs --json` emits the full schema.
- Structured errors: `{ code, message, suggestions[] }`.
- Exit codes: `0` ok · `1` not-found · `2` bad-args · `3` auth · `4` config · `5` cf-api · `6` network · `124` timeout.

## Layout

```
bin/cloudmail.ts     entry: parse → dispatch → emit → exit
src/contracts/       FROZEN shared types: exit, errors, envelope, types
src/cli/             parse.ts, dispatch.ts, commands/        (Command pattern)
src/format/          render.ts — human vs json                (Strategy)
src/core/            mailbox.ts (worker client), profile.ts (multi-account), extract.ts (pure)
src/cloudflare/      api.ts — Cloudflare REST adapter          (Adapter = "any account" seam)
src/mcp/             server.ts — stdio MCP server mode
worker/              deployed Worker (email handler + read API) + schema.sql + wrangler.jsonc
tests/               bun test, one file per module
INTERFACES.md        the frozen per-module interface spec
```

## Conventions

- Runtime **Bun**. `import type` for type-only imports (verbatimModuleSyntax is on).
- All failures throw `CloudmailError(code, message, suggestions)` from `src/contracts/errors`.
- Inject `fetch` into clients; **unit tests never hit the live network**.
- `src/contracts/` is frozen — extend by appending, never edit existing shapes.

## Commands

```sh
bun test                 # run the suite
bun run typecheck        # tsc --noEmit
bun run cli -- <args>    # run the CLI locally
bun run worker:deploy    # deploy the worker (from worker/)
```

## Multi-account

Profiles live in `~/.cloudmail/profiles.json` (or `$CLOUDMAIL_HOME`). `--profile <name>`
switches accounts; `CLOUDMAIL_WORKER_URL` + `CLOUDMAIL_API_KEY` form an ephemeral env profile.

## Roadmap (deferred from v1)

Disposable aliases + TTL (catch-all routing) · send/reply · webhooks on arrival ·
attachments → R2 · FTS search + threading · human-approval hold for sensitive mail.

## Security

This address is an identity root — password resets and magic links land here. Keep the
worker `API_KEY` secret; require human approval before an agent creates accounts or clicks
sensitive links. The worker is receive-only.
