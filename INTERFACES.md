# cloudmail — frozen module interfaces (v1)

Every module implements exactly these signatures. Contracts in `src/contracts/`
(`exit.ts`, `errors.ts`, `types.ts`, `envelope.ts`) are FROZEN — import, never edit.
Throw `CloudmailError(code, message, suggestions)` for all failures. Bun runtime,
`bun test`. Each module + its test file is owned by one agent; do not edit other
modules' files.

## src/core/extract.ts  (pure, no I/O — owned with worker)
```ts
import type { VerificationResult } from "../contracts/types";
// Pure heuristic extraction of codes + links from a body string.
export function extractVerification(body: string): Pick<VerificationResult,"code"|"codes"|"links">;
```
- Codes: 4–8 digit groups (strip spaces/hyphens) + labeled OTP/PIN/code alnum 4–8.
- Links: http(s) URLs whose text matches verif|confirm|activat|magic|token|login|signin|reset.
- `code` = first code found or null. Deterministic ordering (insertion order).

## src/core/profile.ts  (config — the "any account" seam)
```ts
import type { Profile, ProfileStore } from "../contracts/types";
export const CONFIG_PATH: string;                 // ~/.cloudmail/profiles.json (honor $CLOUDMAIL_HOME)
export function loadStore(): ProfileStore;         // {} default if absent; never throws on missing
export function saveStore(store: ProfileStore): void;
export function resolveProfile(name?: string): Profile; // name|active|$CLOUDMAIL_* env; throws PROFILE_MISSING
export function setProfile(p: Profile, makeActive?: boolean): void;
export function setActive(name: string): void;     // throws PROFILE_MISSING if unknown
```
- Env override: `CLOUDMAIL_WORKER_URL` + `CLOUDMAIL_API_KEY` form an ephemeral "env" profile that wins when set.
- File mode 0600. JSON.

## src/core/mailbox.ts  (HTTP client to the worker read API)
```ts
import type { Email, VerificationResult, Profile } from "../contracts/types";
export interface ListOpts { to?: string; limit?: number; unread?: boolean; }
export interface LatestOpts { to?: string; since?: string; }
export interface CodeOpts { to?: string; since?: string; waitMs?: number; }
export class Mailbox {
  constructor(profile: Pick<Profile,"workerUrl"|"apiKey">, fetchImpl?: typeof fetch);
  latest(o?: LatestOpts): Promise<Email | null>;         // GET /latest
  list(o?: ListOpts): Promise<Email[]>;                  // GET /messages
  get(id: number): Promise<Email>;                       // GET /messages/:id ; NOT_FOUND
  code(o?: CodeOpts): Promise<VerificationResult>;       // GET /verification-code; NO_CODE if none; long-poll if waitMs
  waitFor(o?: LatestOpts & { timeoutMs?: number }): Promise<Email>; // poll latest+since until new; TIMEOUT
}
```
- Map HTTP 401→AUTH, 404→NOT_FOUND/NO_CODE, network throw→NETWORK, 5xx→CF_API.
- `fetchImpl` injectable for tests (no live network in unit tests).
- Long-poll: prefer worker `?wait=` param; `waitFor` client-polls every 2s up to timeout.

## src/cloudflare/api.ts  (Cloudflare REST adapter — admin/provisioning)
```ts
export interface CfAuth { token: string; accountId: string; }
export interface Zone { id: string; name: string; status: string; }
export interface RoutingRule { id: string; matchers: unknown[]; actions: unknown[]; enabled: boolean; }
export class CloudflareApi {
  constructor(auth: CfAuth, fetchImpl?: typeof fetch);
  listZones(): Promise<Zone[]>;
  getEmailRouting(zoneId: string): Promise<{ enabled: boolean; status: string }>;
  listRoutingRules(zoneId: string): Promise<RoutingRule[]>;
  createWorkerRoutingRule(zoneId: string, address: string, worker: string): Promise<RoutingRule>;
}
```
- All calls hit api.cloudflare.com/client/v4. Non-2xx → CloudmailError(CF_API,...) with the CF error message + suggestions.
- `fetchImpl` injectable for tests.

## src/format/render.ts  (Strategy: human vs json)
```ts
import type { Envelope } from "../contracts/envelope";
export type Mode = "json" | "human";
export function resolveMode(flags: { json?: boolean; human?: boolean }, isTTY: boolean): Mode;
// json => stdout TTY? false => json. --json forces json, --human forces human.
export function renderHuman(env: Envelope): string;   // dense, token-efficient lines
export function emit(env: Envelope, mode: Mode, out?: (s: string) => void): void;
// json: pretty JSON. human: renderHuman. Always one trailing newline.
export function truncate(s: string | null, max?: number): string; // "…(+N chars, --full)" suffix
```

## src/cli/parse.ts  (arg parsing)
```ts
export interface ParsedArgs {
  command: string | null;          // null => no command (help)
  positionals: string[];
  flags: Record<string, string | boolean>;  // --to x, --json, -n 5
  json: boolean; human: boolean; full: boolean; quiet: boolean; profile?: string;
}
export function parseArgs(argv: string[]): ParsedArgs;  // throws BAD_ARGS on malformed
```

## src/cli/dispatch.ts + src/cli/commands/*.ts  (Command pattern)
```ts
import type { Envelope } from "../contracts/envelope";
export interface CommandCtx { args: ParsedArgs; isTTY: boolean; }
export interface Command {
  name: string; summary: string;            // <=70 chars, for ~100-token help
  usage?: string; run(ctx: CommandCtx): Promise<Envelope>;
}
export const COMMANDS: Command[];            // latest,list,get,code,wait,config,status,doctor,robot-docs
export function dispatch(args: ParsedArgs, isTTY: boolean): Promise<{ env: Envelope; exit: number }>;
export function helpText(): string;          // ~100 token dense list; bare invocation prints this
export function robotDocs(): object;         // machine schema of all commands+flags+exit codes
```

## src/mcp/server.ts  (MCP server mode)
```ts
export function startMcpServer(profileName?: string): Promise<void>; // stdio MCP
// tools: cloudmail_latest, cloudmail_list, cloudmail_get, cloudmail_code, cloudmail_wait
// thin wrappers over Mailbox; return JSON envelopes.
```

## bin/cloudmail.ts  (entry)
- Parse argv → dispatch → emit(env, mode) → process.exit(exit).
- Bare `cloudmail` (no command) prints helpText() to stdout, exit 0.
- `cloudmail mcp` → startMcpServer().

## worker/index.ts  (deployed Worker — receive-only)
- email(): parse (postal-mime) → optional Workers-AI intent classify (graceful fallback) → store in D1.
- fetch(): GET /health (public), /latest, /messages, /messages/:id, /verification-code — all bearer-auth.
- `?wait=<sec>` on /latest and /verification-code: long-poll up to N sec (cap 25s) for a new matching email.
- Imports extractVerification from ../src/core/extract.ts. Uses src/contracts/types.ts shapes.
