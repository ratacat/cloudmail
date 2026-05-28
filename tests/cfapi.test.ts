import { test, expect, describe } from "bun:test";
import { CloudflareApi, type CfAuth } from "../src/cloudflare/api";
import { CloudmailError } from "../src/contracts/errors";

const AUTH: CfAuth = { token: "tok-123", accountId: "acct-abc" };

/** Build a fake fetch that returns a canned JSON body with a given status. */
function fakeFetch(
  body: unknown,
  init: { status?: number; capture?: (url: string, req: RequestInit | undefined) => void } = {},
): typeof fetch {
  const status = init.status ?? 200;
  return (async (input: string | URL | Request, req?: RequestInit) => {
    init.capture?.(String(input), req);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("CloudflareApi.listZones", () => {
  test("returns mapped zones on success", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch({
        success: true,
        errors: [],
        result: [
          { id: "z1", name: "a.com", status: "active", extra: "ignored" },
          { id: "z2", name: "b.com", status: "pending" },
        ],
      }),
    );
    const zones = await cf.listZones();
    expect(zones).toEqual([
      { id: "z1", name: "a.com", status: "active" },
      { id: "z2", name: "b.com", status: "pending" },
    ]);
  });

  test("sends Bearer token and hits v4 base", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch(
        { success: true, errors: [], result: [] },
        {
          capture: (url, req) => {
            seenUrl = url;
            seenHeaders = (req?.headers as Record<string, string>) ?? {};
          },
        },
      ),
    );
    await cf.listZones();
    expect(seenUrl).toContain("https://api.cloudflare.com/client/v4/zones");
    expect(seenHeaders.Authorization).toBe("Bearer tok-123");
  });

  test("throws CF_API on success:false with cf message", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch({
        success: false,
        errors: [{ code: 1000, message: "Invalid API token" }],
        result: null,
      }),
    );
    let caught: unknown;
    try {
      await cf.listZones();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CloudmailError);
    const err = caught as CloudmailError;
    expect(err.code).toBe("CF_API");
    expect(err.message).toContain("Invalid API token");
    expect(err.suggestions.length).toBeGreaterThan(0);
  });

  test("throws CF_API on non-2xx HTTP status", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch(
        { success: false, errors: [{ code: 9109, message: "Unauthorized" }], result: null },
        { status: 403 },
      ),
    );
    const err = await cf.listZones().catch((e) => e);
    expect(err).toBeInstanceOf(CloudmailError);
    expect((err as CloudmailError).code).toBe("CF_API");
    expect((err as CloudmailError).message).toContain("Unauthorized");
  });
});

describe("CloudflareApi.getEmailRouting", () => {
  test("returns enabled/status", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch({
        success: true,
        errors: [],
        result: { enabled: true, status: "ready", name: "x" },
      }),
    );
    const r = await cf.getEmailRouting("z1");
    expect(r).toEqual({ enabled: true, status: "ready" });
  });

  test("hits the zone email routing endpoint", async () => {
    let seenUrl = "";
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch(
        { success: true, errors: [], result: { enabled: false, status: "disabled" } },
        { capture: (url) => (seenUrl = url) },
      ),
    );
    await cf.getEmailRouting("zone-xyz");
    expect(seenUrl).toContain("/zones/zone-xyz/email/routing");
  });

  test("throws CF_API on failure", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch({ success: false, errors: [{ code: 1, message: "boom" }], result: null }),
    );
    const err = await cf.getEmailRouting("z1").catch((e) => e);
    expect((err as CloudmailError).code).toBe("CF_API");
  });
});

describe("CloudflareApi.listRoutingRules", () => {
  test("returns mapped rules", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch({
        success: true,
        errors: [],
        result: [
          {
            id: "r1",
            matchers: [{ type: "literal", field: "to", value: "a@x.com" }],
            actions: [{ type: "worker", value: ["w"] }],
            enabled: true,
          },
        ],
      }),
    );
    const rules = await cf.listRoutingRules("z1");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.id).toBe("r1");
    expect(rules[0]?.enabled).toBe(true);
    expect(Array.isArray(rules[0]?.matchers)).toBe(true);
  });

  test("hits the rules endpoint", async () => {
    let seenUrl = "";
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch(
        { success: true, errors: [], result: [] },
        { capture: (url) => (seenUrl = url) },
      ),
    );
    await cf.listRoutingRules("z9");
    expect(seenUrl).toContain("/zones/z9/email/routing/rules");
  });

  test("throws CF_API on failure", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch({ success: false, errors: [{ code: 2, message: "nope" }], result: null }),
    );
    const err = await cf.listRoutingRules("z1").catch((e) => e);
    expect((err as CloudmailError).code).toBe("CF_API");
    expect((err as CloudmailError).message).toContain("nope");
  });
});

describe("CloudflareApi.createWorkerRoutingRule", () => {
  test("POSTs a worker rule and returns it", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch(
        {
          success: true,
          errors: [],
          result: {
            id: "new1",
            matchers: [{ type: "literal", field: "to", value: "drop@x.com" }],
            actions: [{ type: "worker", value: ["mailworker"] }],
            enabled: true,
          },
        },
        {
          capture: (url, req) => {
            seenUrl = url;
            seenMethod = req?.method ?? "";
            seenBody = req?.body ? JSON.parse(String(req.body)) : undefined;
          },
        },
      ),
    );
    const rule = await cf.createWorkerRoutingRule("z1", "drop@x.com", "mailworker");
    expect(rule.id).toBe("new1");
    expect(seenUrl).toContain("/zones/z1/email/routing/rules");
    expect(seenMethod).toBe("POST");
    expect(JSON.stringify(seenBody)).toContain("drop@x.com");
    expect(JSON.stringify(seenBody)).toContain("mailworker");
  });

  test("throws CF_API on failure", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch({
        success: false,
        errors: [{ code: 3, message: "rule exists" }],
        result: null,
      }),
    );
    const err = await cf.createWorkerRoutingRule("z1", "a@x.com", "w").catch((e) => e);
    expect((err as CloudmailError).code).toBe("CF_API");
    expect((err as CloudmailError).message).toContain("rule exists");
  });

  test("falls back to a generic message when cf returns no errors array", async () => {
    const cf = new CloudflareApi(
      AUTH,
      fakeFetch({ success: false, errors: [], result: null }, { status: 500 }),
    );
    const err = await cf.createWorkerRoutingRule("z1", "a@x.com", "w").catch((e) => e);
    expect((err as CloudmailError).code).toBe("CF_API");
    expect((err as CloudmailError).message.length).toBeGreaterThan(0);
  });
});
