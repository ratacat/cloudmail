import { CloudmailError } from "../contracts/errors";

const CF_BASE = "https://api.cloudflare.com/client/v4";

export interface CfAuth {
  token: string;
  accountId: string;
}

export interface Zone {
  id: string;
  name: string;
  status: string;
}

export interface RoutingRule {
  id: string;
  matchers: unknown[];
  actions: unknown[];
  enabled: boolean;
}

/** Shape of the standard Cloudflare v4 JSON response envelope. */
interface CfResponse<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: unknown[];
  result?: T;
}

/**
 * Thin adapter over the Cloudflare REST API (api.cloudflare.com/client/v4).
 * Authenticates with a Bearer token and surfaces failures as CloudmailError(CF_API).
 * `fetchImpl` is injectable so unit tests never touch the network.
 */
export class CloudflareApi {
  private readonly auth: CfAuth;
  private readonly fetchImpl: typeof fetch;

  constructor(auth: CfAuth, fetchImpl: typeof fetch = fetch) {
    this.auth = auth;
    this.fetchImpl = fetchImpl;
  }

  async listZones(): Promise<Zone[]> {
    const result = await this.request<Array<Record<string, unknown>>>("GET", "/zones");
    const rows = Array.isArray(result) ? result : [];
    return rows.map((z) => ({
      id: String(z.id ?? ""),
      name: String(z.name ?? ""),
      status: String(z.status ?? ""),
    }));
  }

  async getEmailRouting(zoneId: string): Promise<{ enabled: boolean; status: string }> {
    const result = await this.request<Record<string, unknown>>(
      "GET",
      `/zones/${encodeURIComponent(zoneId)}/email/routing`,
    );
    const r = result ?? {};
    return {
      enabled: Boolean(r.enabled),
      status: String(r.status ?? ""),
    };
  }

  async listRoutingRules(zoneId: string): Promise<RoutingRule[]> {
    const result = await this.request<Array<Record<string, unknown>>>(
      "GET",
      `/zones/${encodeURIComponent(zoneId)}/email/routing/rules`,
    );
    const rows = Array.isArray(result) ? result : [];
    return rows.map((r) => this.toRule(r));
  }

  async createWorkerRoutingRule(
    zoneId: string,
    address: string,
    worker: string,
  ): Promise<RoutingRule> {
    const body = {
      enabled: true,
      name: `cloudmail ${address}`,
      matchers: [{ type: "literal", field: "to", value: address }],
      actions: [{ type: "worker", value: [worker] }],
    };
    const result = await this.request<Record<string, unknown>>(
      "POST",
      `/zones/${encodeURIComponent(zoneId)}/email/routing/rules`,
      body,
    );
    return this.toRule(result ?? {});
  }

  private toRule(r: Record<string, unknown>): RoutingRule {
    return {
      id: String(r.id ?? ""),
      matchers: Array.isArray(r.matchers) ? (r.matchers as unknown[]) : [],
      actions: Array.isArray(r.actions) ? (r.actions as unknown[]) : [],
      enabled: Boolean(r.enabled),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const url = `${CF_BASE}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.auth.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new CloudmailError(
        "CF_API",
        `Cloudflare request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        [
          "Check network connectivity to api.cloudflare.com.",
          "Retry the command.",
        ],
      );
    }

    let parsed: CfResponse<T> | null = null;
    try {
      parsed = (await res.json()) as CfResponse<T>;
    } catch {
      parsed = null;
    }

    if (!res.ok || !parsed || parsed.success === false) {
      throw this.toError(res.status, parsed);
    }

    return (parsed.result ?? null) as T | null;
  }

  private toError(status: number, parsed: CfResponse<unknown> | null): CloudmailError {
    const cfMessages = (parsed?.errors ?? [])
      .map((e) => {
        const code = e.code !== undefined ? ` (${e.code})` : "";
        return `${e.message ?? "unknown error"}${code}`;
      })
      .filter((m) => m.length > 0);
    const message =
      cfMessages.length > 0
        ? `Cloudflare API error: ${cfMessages.join("; ")}`
        : `Cloudflare API error: HTTP ${status}`;
    const suggestions = [
      "Verify the API token has Zone:Read and Email Routing edit permissions.",
      "Confirm the account ID and zone ID are correct for this token.",
    ];
    if (status === 401 || status === 403) {
      suggestions.unshift("The token appears unauthorized — regenerate it in the Cloudflare dashboard.");
    }
    return new CloudmailError("CF_API", message, suggestions);
  }
}
