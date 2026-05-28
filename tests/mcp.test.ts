import { test, expect, describe } from "bun:test";
import {
  handleRpc,
  type McpDeps,
  type MailboxLike,
  type JsonRpcRequest,
} from "../src/mcp/server";
import { CloudmailError } from "../src/contracts/errors";
import type { Email, VerificationResult } from "../src/contracts/types";

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

function makeVerification(over: Partial<VerificationResult> = {}): VerificationResult {
  return {
    email_id: 1,
    from: "noreply@svc.test",
    subject: "Your code",
    received_at: "2026-05-28T10:00:00Z",
    code: "123456",
    codes: ["123456"],
    links: [],
    ...over,
  };
}

interface BoxOver {
  latest?: Email | null;
  list?: Email[];
  get?: Email | CloudmailError;
  code?: VerificationResult | CloudmailError;
  waitFor?: Email | CloudmailError;
}

/** Minimal Mailbox stub that records calls and returns canned values. */
function fakeMailbox(over: BoxOver = {}) {
  const calls: { method: string; arg: unknown }[] = [];
  const box: MailboxLike = {
    latest: async (o) => {
      calls.push({ method: "latest", arg: o });
      return over.latest ?? makeEmail();
    },
    list: async (o) => {
      calls.push({ method: "list", arg: o });
      return over.list ?? [makeEmail()];
    },
    get: async (id) => {
      calls.push({ method: "get", arg: id });
      if (over.get instanceof CloudmailError) throw over.get;
      return over.get ?? makeEmail({ id });
    },
    code: async (o) => {
      calls.push({ method: "code", arg: o });
      if (over.code instanceof CloudmailError) throw over.code;
      return over.code ?? makeVerification();
    },
    waitFor: async (o) => {
      calls.push({ method: "waitFor", arg: o });
      if (over.waitFor instanceof CloudmailError) throw over.waitFor;
      return over.waitFor ?? makeEmail();
    },
  };
  return { box, calls };
}

function deps(boxOver: BoxOver = {}): {
  d: McpDeps;
  calls: { method: string; arg: unknown }[];
} {
  const { box, calls } = fakeMailbox(boxOver);
  return { d: { getMailbox: () => box }, calls };
}

function req(method: string, params?: unknown, id: number | string | null = 1): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params };
}

describe("handleRpc initialize", () => {
  test("returns protocolVersion + serverInfo + capabilities", async () => {
    const { d } = deps();
    const res = await handleRpc(req("initialize"), d);
    expect(res).not.toBeNull();
    expect(res!.jsonrpc).toBe("2.0");
    expect(res!.id).toBe(1);
    const result = res!.result as Record<string, unknown>;
    expect(typeof result.protocolVersion).toBe("string");
    expect((result.serverInfo as Record<string, unknown>).name).toBe("cloudmail");
    expect((result.capabilities as Record<string, unknown>).tools).toBeDefined();
    expect(res!.error).toBeUndefined();
  });
});

describe("handleRpc notifications", () => {
  test("notifications/initialized returns null (no response)", async () => {
    const { d } = deps();
    const res = await handleRpc(req("notifications/initialized", undefined, null), d);
    expect(res).toBeNull();
  });

  test("request without id (notification) yields no response", async () => {
    const { d } = deps();
    const res = await handleRpc({ jsonrpc: "2.0", method: "tools/list" }, d);
    expect(res).toBeNull();
  });
});

describe("handleRpc tools/list", () => {
  test("lists the five cloudmail tools with input schemas", async () => {
    const { d } = deps();
    const res = await handleRpc(req("tools/list"), d);
    const tools = (res!.result as { tools: { name: string; inputSchema: unknown }[] }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "cloudmail_code",
      "cloudmail_get",
      "cloudmail_latest",
      "cloudmail_list",
      "cloudmail_wait",
    ]);
    for (const t of tools) {
      expect((t.inputSchema as Record<string, unknown>).type).toBe("object");
    }
  });
});

describe("handleRpc tools/call", () => {
  test("cloudmail_latest returns envelope JSON text", async () => {
    const { d, calls } = deps();
    const res = await handleRpc(
      req("tools/call", { name: "cloudmail_latest", arguments: { to: "a@x.test" } }),
      d,
    );
    const result = res!.result as { content: { type: string; text: string }[]; isError?: boolean };
    expect(result.isError).toBeFalsy();
    const block = result.content[0]!;
    expect(block.type).toBe("text");
    const env = JSON.parse(block.text);
    expect(env.ok).toBe(true);
    expect(env.meta.command).toBe("latest");
    expect(env.data.id).toBe(1);
    expect(calls[0]!.method).toBe("latest");
    expect(calls[0]!.arg).toEqual({ to: "a@x.test", since: undefined });
  });

  test("cloudmail_list passes limit/unread and wraps array", async () => {
    const { d, calls } = deps();
    const res = await handleRpc(
      req("tools/call", { name: "cloudmail_list", arguments: { limit: 5, unread: true } }),
      d,
    );
    const text = (res!.result as { content: { text: string }[] }).content[0]!.text;
    const env = JSON.parse(text);
    expect(env.ok).toBe(true);
    expect(Array.isArray(env.data)).toBe(true);
    expect(calls[0]!.arg).toEqual({ to: undefined, limit: 5, unread: true });
  });

  test("cloudmail_get coerces id to number", async () => {
    const { d, calls } = deps();
    const res = await handleRpc(
      req("tools/call", { name: "cloudmail_get", arguments: { id: "42" } }),
      d,
    );
    const env = JSON.parse((res!.result as { content: { text: string }[] }).content[0]!.text);
    expect(env.ok).toBe(true);
    expect(calls[0]!.method).toBe("get");
    expect(calls[0]!.arg).toBe(42);
  });

  test("cloudmail_get with missing id is a BAD_ARGS error envelope", async () => {
    const { d } = deps();
    const res = await handleRpc(req("tools/call", { name: "cloudmail_get", arguments: {} }), d);
    const result = res!.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0]!.text);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("BAD_ARGS");
  });

  test("cloudmail_code maps waitSec to waitMs", async () => {
    const { d, calls } = deps();
    await handleRpc(
      req("tools/call", { name: "cloudmail_code", arguments: { waitSec: 3 } }),
      d,
    );
    expect(calls[0]!.method).toBe("code");
    expect(calls[0]!.arg).toEqual({ to: undefined, since: undefined, waitMs: 3000 });
  });

  test("cloudmail_code NO_CODE surfaces as error envelope, not a thrown error", async () => {
    const { d } = deps({ code: new CloudmailError("NO_CODE", "No verification code found.", ["s"]) });
    const res = await handleRpc(req("tools/call", { name: "cloudmail_code", arguments: {} }), d);
    const result = res!.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0]!.text);
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe("NO_CODE");
    expect(env.error.suggestions).toEqual(["s"]);
  });

  test("cloudmail_wait maps timeoutSec to timeoutMs", async () => {
    const { d, calls } = deps();
    await handleRpc(
      req("tools/call", { name: "cloudmail_wait", arguments: { timeoutSec: 10, to: "z@x.test" } }),
      d,
    );
    expect(calls[0]!.method).toBe("waitFor");
    expect(calls[0]!.arg).toEqual({ to: "z@x.test", since: undefined, timeoutMs: 10000 });
  });

  test("unknown tool name yields BAD_ARGS error envelope", async () => {
    const { d } = deps();
    const res = await handleRpc(
      req("tools/call", { name: "cloudmail_nope", arguments: {} }),
      d,
    );
    const result = res!.result as { content: { text: string }[]; isError: boolean };
    expect(result.isError).toBe(true);
    const env = JSON.parse(result.content[0]!.text);
    expect(env.error.code).toBe("BAD_ARGS");
  });
});

describe("handleRpc method errors", () => {
  test("unknown method returns JSON-RPC error -32601", async () => {
    const { d } = deps();
    const res = await handleRpc(req("frobnicate"), d);
    expect(res!.result).toBeUndefined();
    expect(res!.error!.code).toBe(-32601);
  });

  test("tools/call with non-object params returns -32602 invalid params", async () => {
    const { d } = deps();
    const res = await handleRpc(req("tools/call", 42), d);
    expect(res!.error!.code).toBe(-32602);
  });
});
