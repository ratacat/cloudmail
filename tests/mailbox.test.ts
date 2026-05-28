import { test, expect, describe } from "bun:test";
import { Mailbox } from "../src/core/mailbox";
import { CloudmailError } from "../src/contracts/errors";
import type { Email, VerificationResult } from "../src/contracts/types";

const PROFILE = { workerUrl: "https://mail.example.test", apiKey: "k-secret" };

function makeEmail(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    sender: "noreply@svc.test",
    recipient: "u@mail.example.test",
    subject: "Your code",
    text: "code 123456",
    html: null,
    message_id: "<m1>",
    in_reply_to: null,
    received_at: "2026-05-28T10:00:00Z",
    read: 0,
    ...over,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- Real worker wire shapes (the client must unwrap these). ---
const latestBody = (email: Email | null) => jsonResponse({ email });
const getBody = (email: Email | null) => jsonResponse({ email });
const listBody = (emails: Email[]) => jsonResponse({ count: emails.length, emails });

/** Records each request and returns canned responses via a handler. */
function recordingFetch(handler: (req: Request) => Response | Promise<Response>) {
  const calls: { url: string; method: string; headers: Headers }[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const urlStr = typeof input === "string" ? input : input.toString();
    const req = new Request(urlStr, init);
    calls.push({ url: req.url, method: req.method, headers: req.headers });
    return handler(req);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("Mailbox.latest", () => {
  test("GETs /latest with bearer auth and unwraps {email}", async () => {
    const email = makeEmail();
    const { impl, calls } = recordingFetch(() => latestBody(email));
    const mb = new Mailbox(PROFILE, impl);
    const got = await mb.latest();
    expect(got).toEqual(email);
    expect(calls.length).toBe(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://mail.example.test/latest");
    expect(c.method).toBe("GET");
    expect(c.headers.get("authorization")).toBe("Bearer k-secret");
  });

  test("builds query params from to and since", async () => {
    const { impl, calls } = recordingFetch(() => latestBody(makeEmail()));
    const mb = new Mailbox(PROFILE, impl);
    await mb.latest({ to: "alice@x.test", since: "2026-05-28T09:00:00Z" });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/latest");
    expect(u.searchParams.get("to")).toBe("alice@x.test");
    expect(u.searchParams.get("since")).toBe("2026-05-28T09:00:00Z");
  });

  test("returns null when worker reports no email ({email:null})", async () => {
    const { impl } = recordingFetch(() => latestBody(null));
    const mb = new Mailbox(PROFILE, impl);
    expect(await mb.latest()).toBeNull();
  });

  test("returns null on 204 empty body", async () => {
    const { impl } = recordingFetch(() => new Response(null, { status: 204 }));
    const mb = new Mailbox(PROFILE, impl);
    expect(await mb.latest()).toBeNull();
  });
});

describe("Mailbox.list", () => {
  test("GETs /messages and unwraps {emails}", async () => {
    const emails = [makeEmail({ id: 2 }), makeEmail({ id: 1 })];
    const { impl, calls } = recordingFetch(() => listBody(emails));
    const mb = new Mailbox(PROFILE, impl);
    const got = await mb.list();
    expect(got).toEqual(emails);
    expect(new URL(calls[0]!.url).pathname).toBe("/messages");
  });

  test("builds to, limit; sends unread=1 (worker contract)", async () => {
    const { impl, calls } = recordingFetch(() => listBody([]));
    const mb = new Mailbox(PROFILE, impl);
    await mb.list({ to: "b@x.test", limit: 5, unread: true });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("to")).toBe("b@x.test");
    expect(u.searchParams.get("limit")).toBe("5");
    expect(u.searchParams.get("unread")).toBe("1");
  });

  test("omits unread param when false", async () => {
    const { impl, calls } = recordingFetch(() => listBody([]));
    const mb = new Mailbox(PROFILE, impl);
    await mb.list({ unread: false });
    expect(new URL(calls[0]!.url).searchParams.has("unread")).toBe(false);
  });
});

describe("Mailbox.get", () => {
  test("GETs /messages/:id and unwraps {email}", async () => {
    const email = makeEmail({ id: 42 });
    const { impl, calls } = recordingFetch(() => getBody(email));
    const mb = new Mailbox(PROFILE, impl);
    const got = await mb.get(42);
    expect(got).toEqual(email);
    expect(new URL(calls[0]!.url).pathname).toBe("/messages/42");
  });

  test("404 -> NOT_FOUND", async () => {
    const { impl } = recordingFetch(() => jsonResponse({ error: "nope" }, 404));
    const mb = new Mailbox(PROFILE, impl);
    await expect(mb.get(99)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Mailbox.code", () => {
  test("GETs /verification-code and parses the (bare) result", async () => {
    const vr: VerificationResult = {
      email_id: 1,
      from: "svc@test",
      subject: "code",
      received_at: "2026-05-28T10:00:00Z",
      code: "123456",
      codes: ["123456"],
      links: [],
    };
    const { impl, calls } = recordingFetch(() => jsonResponse(vr));
    const mb = new Mailbox(PROFILE, impl);
    const got = await mb.code();
    expect(got).toEqual(vr);
    expect(new URL(calls[0]!.url).pathname).toBe("/verification-code");
  });

  test("builds to, since, wait(seconds) params from waitMs", async () => {
    const { impl, calls } = recordingFetch(() =>
      jsonResponse({
        email_id: 1,
        from: "s",
        subject: null,
        received_at: "t",
        code: "1",
        codes: ["1"],
        links: [],
      }),
    );
    const mb = new Mailbox(PROFILE, impl);
    await mb.code({ to: "c@x.test", since: "2026-05-28T09:00:00Z", waitMs: 8000 });
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get("to")).toBe("c@x.test");
    expect(u.searchParams.get("since")).toBe("2026-05-28T09:00:00Z");
    expect(u.searchParams.get("wait")).toBe("8");
  });

  test("404 -> NO_CODE", async () => {
    const { impl } = recordingFetch(() => jsonResponse({ error: "none" }, 404));
    const mb = new Mailbox(PROFILE, impl);
    await expect(mb.code()).rejects.toMatchObject({ code: "NO_CODE" });
  });
});

describe("Mailbox error mapping", () => {
  test("401 -> AUTH", async () => {
    const { impl } = recordingFetch(() => jsonResponse({ error: "bad key" }, 401));
    const mb = new Mailbox(PROFILE, impl);
    await expect(mb.latest()).rejects.toMatchObject({ code: "AUTH" });
  });

  test("500 -> CF_API", async () => {
    const { impl } = recordingFetch(() => jsonResponse({ error: "boom" }, 500));
    const mb = new Mailbox(PROFILE, impl);
    await expect(mb.list()).rejects.toMatchObject({ code: "CF_API" });
  });

  test("503 -> CF_API", async () => {
    const { impl } = recordingFetch(() => new Response("unavailable", { status: 503 }));
    const mb = new Mailbox(PROFILE, impl);
    await expect(mb.list()).rejects.toMatchObject({ code: "CF_API" });
  });

  test("network reject -> NETWORK", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const mb = new Mailbox(PROFILE, impl);
    await expect(mb.latest()).rejects.toMatchObject({ code: "NETWORK" });
  });

  test("thrown errors are CloudmailError instances", async () => {
    const { impl } = recordingFetch(() => jsonResponse({}, 401));
    const mb = new Mailbox(PROFILE, impl);
    try {
      await mb.latest();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudmailError);
    }
  });
});

describe("Mailbox.waitFor", () => {
  test("resolves with a newer email after polling latest+since", async () => {
    const old = makeEmail({ id: 1, received_at: "2026-05-28T10:00:00Z" });
    const fresh = makeEmail({ id: 2, received_at: "2026-05-28T11:00:00Z" });
    let poll = 0;
    const { impl, calls } = recordingFetch(() => {
      poll += 1;
      if (poll < 3) return latestBody(null);
      return latestBody(fresh);
    });
    const mb = new Mailbox(PROFILE, impl);
    const got = await mb.waitFor({
      to: "u@x.test",
      since: old.received_at,
      timeoutMs: 5000,
      pollMs: 1,
    });
    expect(got).toEqual(fresh);
    expect(poll).toBe(3);
    expect(new URL(calls[0]!.url).searchParams.get("since")).toBe(old.received_at);
  });

  test("ignores emails not newer than since", async () => {
    const since = "2026-05-28T10:00:00Z";
    const sameOrOlder = makeEmail({ id: 1, received_at: since });
    const fresh = makeEmail({ id: 5, received_at: "2026-05-28T10:00:01Z" });
    let poll = 0;
    const { impl } = recordingFetch(() => {
      poll += 1;
      if (poll < 2) return latestBody(sameOrOlder);
      return latestBody(fresh);
    });
    const mb = new Mailbox(PROFILE, impl);
    const got = await mb.waitFor({ since, timeoutMs: 5000, pollMs: 1 });
    expect(got.id).toBe(5);
  });

  test("times out -> TIMEOUT when no new email arrives", async () => {
    const { impl } = recordingFetch(() => latestBody(null));
    const mb = new Mailbox(PROFILE, impl);
    await expect(
      mb.waitFor({ since: "2026-05-28T10:00:00Z", timeoutMs: 5, pollMs: 1 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  test("with no since, resolves on first email that appears", async () => {
    const fresh = makeEmail({ id: 7, received_at: "2026-05-28T12:00:00Z" });
    let poll = 0;
    const { impl } = recordingFetch(() => {
      poll += 1;
      if (poll < 2) return latestBody(null);
      return latestBody(fresh);
    });
    const mb = new Mailbox(PROFILE, impl);
    const got = await mb.waitFor({ timeoutMs: 5000, pollMs: 1 });
    expect(got.id).toBe(7);
  });
});

describe("Mailbox url normalization", () => {
  test("trailing slash on workerUrl does not double up", async () => {
    const { impl, calls } = recordingFetch(() => latestBody(makeEmail()));
    const mb = new Mailbox({ workerUrl: "https://mail.example.test/", apiKey: "k" }, impl);
    await mb.latest();
    expect(calls[0]!.url).toBe("https://mail.example.test/latest");
  });
});
