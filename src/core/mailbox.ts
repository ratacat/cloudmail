import type { Email, VerificationResult, Profile } from "../contracts/types";
import { CloudmailError } from "../contracts/errors";

export interface ListOpts {
  to?: string;
  limit?: number;
  unread?: boolean;
}

export interface LatestOpts {
  to?: string;
  since?: string;
}

export interface CodeOpts {
  to?: string;
  since?: string;
  /** Long-poll the worker up to this many ms (sent as `?wait=<seconds>`). */
  waitMs?: number;
}

/** Default client poll interval for {@link Mailbox.waitFor}, per the worker spec. */
const DEFAULT_POLL_MS = 2000;

/**
 * HTTP client to the deployed worker read API. All requests carry a
 * `Bearer <apiKey>` Authorization header. Failures are surfaced as
 * {@link CloudmailError} with a stable code:
 *   401 -> AUTH, 404 -> NOT_FOUND (get) / NO_CODE (code),
 *   >=500 -> CF_API, network reject -> NETWORK.
 */
export class Mailbox {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(profile: Pick<Profile, "workerUrl" | "apiKey">, fetchImpl?: typeof fetch) {
    if (!profile.workerUrl) {
      throw new CloudmailError("CONFIG_MISSING", "Profile has no workerUrl.", [
        "Set workerUrl on the active profile (cloudmail config).",
      ]);
    }
    if (!profile.apiKey) {
      throw new CloudmailError("AUTH", "Profile has no apiKey.", [
        "Set apiKey on the active profile (cloudmail config).",
      ]);
    }
    // Strip a single trailing slash so path joins never double up.
    this.base = profile.workerUrl.replace(/\/+$/, "");
    this.apiKey = profile.apiKey;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /** GET /latest — newest matching email, or null when the mailbox is empty. */
  async latest(o: LatestOpts = {}): Promise<Email | null> {
    const url = this.url("/latest", { to: o.to, since: o.since });
    const res = await this.request(url);
    return this.parseEmailOrNull(res);
  }

  /** GET /messages — list of matching emails (newest first per the worker). */
  async list(o: ListOpts = {}): Promise<Email[]> {
    const params: Record<string, string | undefined> = { to: o.to };
    if (o.limit !== undefined) params.limit = String(o.limit);
    if (o.unread) params.unread = "1"; // worker honors `unread=1`
    const url = this.url("/messages", params);
    const res = await this.request(url);
    // Worker wraps the list as { count, emails: Email[] }.
    const body = await this.json<{ emails?: Email[] } | null>(res);
    return Array.isArray(body?.emails) ? body.emails : [];
  }

  /** GET /messages/:id — one email; NOT_FOUND when absent. */
  async get(id: number): Promise<Email> {
    const url = this.url(`/messages/${id}`, {});
    const res = await this.request(url, {
      404: () =>
        new CloudmailError("NOT_FOUND", `No email with id ${id}.`, [
          "Run `cloudmail list` to see available ids.",
        ]),
    });
    // Worker wraps the single email as { email: Email }.
    const body = await this.json<{ email?: Email | null } | null>(res);
    if (!body?.email) {
      throw new CloudmailError("NOT_FOUND", `No email with id ${id}.`, [
        "Run `cloudmail list` to see available ids.",
      ]);
    }
    return body.email;
  }

  /** GET /verification-code — extracted code/links; NO_CODE when none. */
  async code(o: CodeOpts = {}): Promise<VerificationResult> {
    const params: Record<string, string | undefined> = { to: o.to, since: o.since };
    if (o.waitMs !== undefined && o.waitMs > 0) {
      // Worker caps wait at 25s; express ms as whole seconds.
      params.wait = String(Math.ceil(o.waitMs / 1000));
    }
    const url = this.url("/verification-code", params);
    const res = await this.request(url, {
      404: () =>
        new CloudmailError("NO_CODE", "No verification code found.", [
          "Trigger the email again, or pass --wait to long-poll.",
          "Inspect the raw email with `cloudmail latest`.",
        ]),
    });
    const body = await this.json<VerificationResult | null>(res);
    if (!body) {
      throw new CloudmailError("NO_CODE", "No verification code found.", [
        "Trigger the email again, or pass --wait to long-poll.",
        "Inspect the raw email with `cloudmail latest`.",
      ]);
    }
    return body;
  }

  /**
   * Poll {@link latest} (carrying `since`) until an email newer than `since`
   * appears, then resolve it. Throws TIMEOUT after `timeoutMs`. The poll
   * interval defaults to 2s; tests may inject a small `pollMs`.
   */
  async waitFor(o: LatestOpts & { timeoutMs?: number; pollMs?: number } = {}): Promise<Email> {
    const timeoutMs = o.timeoutMs ?? 30_000;
    const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    const sinceMs = o.since ? Date.parse(o.since) : NaN;

    for (;;) {
      const email = await this.latest({ to: o.to, since: o.since });
      if (email && this.isNewer(email, sinceMs)) return email;
      if (Date.now() >= deadline) {
        throw new CloudmailError(
          "TIMEOUT",
          `No new email arrived within ${Math.round(timeoutMs / 1000)}s.`,
          ["Increase the timeout, or verify the email was actually sent."],
        );
      }
      // Do not overshoot the deadline while sleeping.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new CloudmailError(
          "TIMEOUT",
          `No new email arrived within ${Math.round(timeoutMs / 1000)}s.`,
          ["Increase the timeout, or verify the email was actually sent."],
        );
      }
      await this.sleep(Math.min(pollMs, remaining));
    }
  }

  /** Whether `email` is strictly newer than the `since` watermark (if any). */
  private isNewer(email: Email, sinceMs: number): boolean {
    if (Number.isNaN(sinceMs)) return true;
    const t = Date.parse(email.received_at);
    if (Number.isNaN(t)) return true;
    return t > sinceMs;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private url(path: string, params: Record<string, string | undefined>): string {
    const u = new URL(this.base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") u.searchParams.set(k, v);
    }
    return u.toString();
  }

  /**
   * Perform the request and map transport/HTTP failures to CloudmailError.
   * `overrides` lets a caller customize the error for specific statuses
   * (e.g. 404 -> NO_CODE on the verification endpoint).
   */
  private async request(
    url: string,
    overrides: Partial<Record<number, () => CloudmailError>> = {},
  ): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
        },
      });
    } catch (cause) {
      throw new CloudmailError(
        "NETWORK",
        `Could not reach the worker: ${cause instanceof Error ? cause.message : String(cause)}`,
        ["Check the workerUrl and your network connection."],
      );
    }

    if (res.ok) return res;

    const override = overrides[res.status];
    if (override) throw override();

    if (res.status === 401 || res.status === 403) {
      throw new CloudmailError("AUTH", "Worker rejected the API key.", [
        "Verify apiKey matches the worker's configured secret.",
      ]);
    }
    if (res.status === 404) {
      throw new CloudmailError("NOT_FOUND", "Resource not found.", [
        "Verify the path/id and the worker deployment.",
      ]);
    }
    if (res.status >= 500) {
      const detail = await this.errorDetail(res);
      throw new CloudmailError(
        "CF_API",
        `Worker error (${res.status})${detail ? `: ${detail}` : ""}.`,
        ["Retry shortly; check the worker logs (wrangler tail)."],
      );
    }
    const detail = await this.errorDetail(res);
    throw new CloudmailError(
      "CF_API",
      `Unexpected worker response (${res.status})${detail ? `: ${detail}` : ""}.`,
      ["Check the worker deployment and request shape."],
    );
  }

  /** Parse a JSON body, mapping malformed JSON to an INTERNAL error. */
  private async json<T>(res: Response): Promise<T> {
    if (res.status === 204) return null as T;
    const raw = await res.text();
    if (raw.trim() === "") return null as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new CloudmailError("CF_API", "Worker returned a non-JSON response.", [
        "Confirm the workerUrl points at the cloudmail worker.",
      ]);
    }
  }

  private async parseEmailOrNull(res: Response): Promise<Email | null> {
    // Worker wraps the latest email as { email: Email | null }.
    const body = await this.json<{ email?: Email | null } | null>(res);
    return body?.email ?? null;
  }

  /** Best-effort extraction of a worker error message for diagnostics. */
  private async errorDetail(res: Response): Promise<string | null> {
    try {
      const raw = await res.text();
      if (!raw.trim()) return null;
      try {
        const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown };
        const msg = parsed.error ?? parsed.message;
        return typeof msg === "string" ? msg : raw.slice(0, 200);
      } catch {
        return raw.slice(0, 200);
      }
    } catch {
      return null;
    }
  }
}
