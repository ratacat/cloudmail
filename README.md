# cloudmail

**Robot-mode email CLI for AI agents.** Give an agent a disposable email identity on
*any* Cloudflare account, then read mail and pull verification codes with dense,
machine-parseable output.

```
Email Routing (agent@yourdomain) → Worker → parse + classify → D1
                                                                 ↓
        cloudmail latest | code | wait        (bearer-authed read API)
```

Receive-only. Built with [Bun](https://bun.sh).

## Why

Agents constantly need to receive a verification email during signup. `cloudmail` makes
that one command — and every command is `--json`-clean, TTY-aware, and exits with
meaningful codes so an agent never has to scrape human text.

## Install

```sh
bun install
bun link            # exposes `cloudmail` on PATH
```

## Quick start

```sh
cloudmail                       # ~100-token help
cloudmail robot-docs --json     # full machine schema of every command

cloudmail latest                # newest email
cloudmail code --wait 60        # block up to 60s for the next verification code/link
cloudmail list --unread --json
cloudmail get 7                 # one email, marks read
```

## Robot-mode guarantees

| Feature | Behavior |
|---------|----------|
| JSON output | `--json` on every command; `{ ok, data, error, meta }`. Auto-JSON when piped. |
| Tiny help | bare `cloudmail` ≈100 tokens; `robot-docs` for the full schema |
| Structured errors | `{ code, message, suggestions[] }` |
| Exit codes | `0` ok · `1` not-found · `2` bad-args · `3` auth · `4` config · `5` cf-api · `6` network · `124` timeout |
| Token-efficient | bodies truncated unless `--full` |

## Multi-account

Profiles in `~/.cloudmail/profiles.json`. Switch with `--profile`, or set
`CLOUDMAIL_WORKER_URL` + `CLOUDMAIL_API_KEY` for an ephemeral env profile.

```sh
cloudmail config set work --worker-url https://mail.acme.dev --api-key $KEY
cloudmail --profile work latest
```

## MCP mode

```sh
cloudmail mcp        # stdio MCP server: cloudmail_latest / _list / _get / _code / _wait
```

## Provisioning a new inbox

```sh
cloudmail init       # picks a zone, creates D1, deploys the worker, wires the routing rule
```

See [`worker/`](worker/) for the deployed Worker, and [`AGENTS.md`](AGENTS.md) /
[`INTERFACES.md`](INTERFACES.md) for architecture and the frozen module contracts.

## Develop

```sh
bun test
bun run typecheck
bun run cli -- latest --json
```

## License

MIT
