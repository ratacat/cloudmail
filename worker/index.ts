import PostalMime from "postal-mime";
import { extractVerification } from "../src/core/extract";
import type { EmailIntent, IntentKind } from "../src/contracts/types";

interface Env {
  DB: D1Database;
  API_KEY: string; // set via `wrangler secret put API_KEY`
  /** Optional Workers-AI binding; when present, inbound mail is intent-classified. */
  AI?: Ai;
}

interface StoredEmail {
  id: number;
  sender: string;
  recipient: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  received_at: string;
  read: number;
  /** JSON-encoded EmailIntent, or null when classification was unavailable. */
  intent: string | null;
}

/** Wire shape returned to clients: `intent` decoded from its stored JSON string. */
interface EmailWire extends Omit<StoredEmail, "intent"> {
  intent: EmailIntent | null;
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** Long-poll cap: never block a request longer than this. */
const MAX_WAIT_SEC = 25;
/** Re-query cadence while long-polling. */
const POLL_INTERVAL_MS = 1500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Parse `?wait=` into a bounded millisecond budget (0 when absent/invalid). */
function parseWaitMs(url: URL): number {
  const raw = url.searchParams.get("wait");
  if (raw === null) return 0;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.min(sec, MAX_WAIT_SEC) * 1000;
}

/** Parse `?limit=` into an integer in [1, 100], defaulting to 20 on absent/invalid. */
function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 20;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), 100);
}

/** Decode the stored `intent` JSON column into a typed object (null on any issue). */
function decodeIntent(raw: string | null): EmailIntent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EmailIntent;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Malformed stored JSON — treat as absent rather than failing the request.
  }
  return null;
}

/** Convert a DB row to the client wire shape (decoding `intent`). */
function toWire(row: StoredEmail): EmailWire {
  return { ...row, intent: decodeIntent(row.intent) };
}

const VALID_KINDS: ReadonlySet<IntentKind> = new Set([
  "verification",
  "magic_link",
  "password_reset",
  "two_factor",
  "marketing",
  "transactional",
  "other",
]);

/**
 * Best-effort Workers-AI intent classification of an inbound email.
 * Returns null on ANY failure (no binding, model error, bad JSON, bad shape)
 * so storage never depends on AI availability.
 */
async function classifyIntent(
  env: Env,
  subject: string | null,
  body: string,
): Promise<EmailIntent | null> {
  if (!env.AI) return null;
  try {
    const prompt = [
      "Classify this inbound email. Respond with ONLY a JSON object:",
      '{"kind": one of ["verification","magic_link","password_reset","two_factor","marketing","transactional","other"],',
      '"service": short service/brand name or null,',
      '"action_url": the primary verification/login/reset URL or null,',
      '"confidence": number 0..1}',
      "",
      `Subject: ${subject ?? ""}`,
      `Body: ${body.slice(0, 4000)}`,
    ].join("\n");

    const res = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
      messages: [
        {
          role: "system",
          content: "You are an email classifier. Output only compact JSON.",
        },
        { role: "user", content: prompt },
      ],
    })) as { response?: string };

    const text = res?.response;
    if (typeof text !== "string") return null;

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    const kind = parsed.kind;
    if (typeof kind !== "string" || !VALID_KINDS.has(kind as IntentKind)) {
      return null;
    }
    const service =
      typeof parsed.service === "string" && parsed.service.length > 0
        ? parsed.service
        : null;
    const action_url =
      typeof parsed.action_url === "string" && parsed.action_url.length > 0
        ? parsed.action_url
        : null;
    const confidenceRaw = parsed.confidence;
    const confidence =
      typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
        ? Math.max(0, Math.min(1, confidenceRaw))
        : 0;

    return { kind: kind as IntentKind, service, action_url, confidence };
  } catch {
    // Any failure: fall back to no classification.
    return null;
  }
}

function requireAuth(request: Request, env: Env): Response | null {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!env.API_KEY || token !== env.API_KEY) {
    return json({ error: "unauthorized" }, 401);
  }
  return null;
}

/** Build a WHERE clause from optional recipient + since filters. */
function buildFilter(
  recipient: string | null,
  since: string | null,
): { clause: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (recipient) {
    where.push("recipient = ?");
    args.push(recipient);
  }
  if (since) {
    where.push("received_at >= ?");
    args.push(since);
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", args };
}

/** Most recent row matching the filter, or null. */
async function latestRow(
  env: Env,
  recipient: string | null,
  since: string | null,
): Promise<StoredEmail | null> {
  const { clause, args } = buildFilter(recipient, since);
  return env.DB.prepare(
    `SELECT * FROM emails ${clause} ORDER BY received_at DESC, id DESC LIMIT 1`,
  )
    .bind(...args)
    .first<StoredEmail>();
}

/** Highest id matching the recipient filter (long-poll baseline). */
async function maxId(env: Env, recipient: string | null): Promise<number> {
  const { clause, args } = buildFilter(recipient, null);
  const row = await env.DB.prepare(
    `SELECT id FROM emails ${clause} ORDER BY id DESC LIMIT 1`,
  )
    .bind(...args)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

/**
 * Resolve the most recent matching row, optionally long-polling until a row
 * NEWER than `baselineId` appears or the wait budget elapses. The baseline is
 * the highest matching id at request start (or the id implied by `?since`),
 * so an already-present older email never counts as "new" for a poll.
 */
async function awaitLatest(
  env: Env,
  recipient: string | null,
  since: string | null,
  waitMs: number,
): Promise<StoredEmail | null> {
  let row = await latestRow(env, recipient, since);
  if (waitMs <= 0) return row;

  // A `?since` filter already scopes to new mail; otherwise anchor on the
  // current max id so we only return rows that arrive during the poll.
  const baselineId = since ? 0 : await maxId(env, recipient);
  if (row && row.id > baselineId) return row;

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    row = await latestRow(env, recipient, since);
    if (row && row.id > baselineId) return row;
  }
  return row && row.id > baselineId ? row : null;
}

/** Whether a row yields at least one verification code or link. */
function rowHasCode(row: StoredEmail): boolean {
  const found = extractVerification(row.text || row.html || "");
  return found.code !== null || found.links.length > 0;
}

/**
 * Like {@link awaitLatest}, but the result must actually CONTAIN a code/link.
 * Without `?wait`, returns the newest matching row only if it has a code (else
 * null). With `?wait`, polls until a code-bearing row appears or the budget
 * elapses — so `code --wait` blocks for a usable code, not just any new mail.
 */
async function awaitCode(
  env: Env,
  recipient: string | null,
  since: string | null,
  waitMs: number,
): Promise<StoredEmail | null> {
  const initial = await latestRow(env, recipient, since);
  if (waitMs <= 0) return initial && rowHasCode(initial) ? initial : null;

  if (initial && rowHasCode(initial)) return initial;

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, deadline - Date.now()));
    const row = await latestRow(env, recipient, since);
    if (row && rowHasCode(row)) return row;
  }
  return null;
}

export default {
  // ---- Inbound email: parse + optional AI intent + store ----
  async email(message, env: Env, _ctx): Promise<void> {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);

    const body = parsed.text || parsed.html || "";
    const intent = await classifyIntent(env, parsed.subject ?? null, body);

    await env.DB.prepare(
      `INSERT INTO emails (sender, recipient, subject, text, html, message_id, in_reply_to, intent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        message.from,
        message.to,
        parsed.subject ?? null,
        parsed.text ?? null,
        parsed.html ?? null,
        message.headers.get("message-id"),
        message.headers.get("in-reply-to"),
        intent ? JSON.stringify(intent) : null,
      )
      .run();
  },

  // ---- Read API ----
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "cloudmail" });
    }

    const unauthorized = requireAuth(request, env);
    if (unauthorized) return unauthorized;

    const recipient = url.searchParams.get("to"); // optional filter
    const limit = parseLimit(url);

    // GET /latest -> single most recent email (?to=, ?since=ISO, ?wait=<sec> long-poll)
    if (path === "/latest") {
      const since = url.searchParams.get("since");
      const waitMs = parseWaitMs(url);
      const row = await awaitLatest(env, recipient, since, waitMs);
      return json({ email: row ? toWire(row) : null });
    }

    // GET /messages -> list (optionally ?to=, ?limit=, ?unread=1)
    if (path === "/messages") {
      const where: string[] = [];
      const args: unknown[] = [];
      if (recipient) {
        where.push("recipient = ?");
        args.push(recipient);
      }
      if (url.searchParams.get("unread") === "1") {
        where.push("read = 0");
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { results } = await env.DB.prepare(
        `SELECT * FROM emails ${clause} ORDER BY received_at DESC, id DESC LIMIT ?`,
      )
        .bind(...args, limit)
        .all<StoredEmail>();
      return json({ count: results.length, emails: results.map(toWire) });
    }

    // GET /messages/:id -> single email by id; marks it read
    const idMatch = path.match(/^\/messages\/(\d+)$/);
    if (idMatch) {
      const id = Number(idMatch[1]);
      const row = await env.DB.prepare(`SELECT * FROM emails WHERE id = ?`)
        .bind(id)
        .first<StoredEmail>();
      if (!row) return json({ error: "not found" }, 404);
      await env.DB.prepare(`UPDATE emails SET read = 1 WHERE id = ?`).bind(id).run();
      return json({ email: toWire(row) });
    }

    // GET /verification-code -> extract code/link from most recent email
    // (?to=, ?since=ISO, ?wait=<sec> long-poll)
    if (path === "/verification-code") {
      const since = url.searchParams.get("since");
      const waitMs = parseWaitMs(url);
      const row = await awaitCode(env, recipient, since, waitMs);
      if (!row) return json({ error: "no code" }, 404);
      const found = extractVerification(row.text || row.html || "");
      return json({
        email_id: row.id,
        from: row.sender,
        subject: row.subject,
        received_at: row.received_at,
        ...found,
        intent: decodeIntent(row.intent),
      });
    }

    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
