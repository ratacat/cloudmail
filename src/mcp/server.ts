import type { Email, VerificationResult } from "../contracts/types";
import type { Envelope } from "../contracts/envelope";
import { ok, err } from "../contracts/envelope";
import { CloudmailError } from "../contracts/errors";
import { Mailbox } from "../core/mailbox";
import { resolveProfile } from "../core/profile";

/**
 * Minimal stdio MCP server for cloudmail. Speaks JSON-RPC 2.0 over
 * stdin/stdout (newline-delimited JSON). Handles `initialize`,
 * `tools/list`, and `tools/call`. The five tools are thin wrappers over
 * {@link Mailbox} and return the standard cloudmail JSON envelope as a
 * single text content block.
 *
 * Request handling is factored into the pure {@link handleRpc} so it can be
 * unit-tested with a fake Mailbox and no real stdio.
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "cloudmail", version: "0.1.0" } as const;

/** The subset of {@link Mailbox} the MCP tools depend on. */
export interface MailboxLike {
  latest(o?: { to?: string; since?: string }): Promise<Email | null>;
  list(o?: { to?: string; limit?: number; unread?: boolean }): Promise<Email[]>;
  get(id: number): Promise<Email>;
  code(o?: { to?: string; since?: string; waitMs?: number }): Promise<VerificationResult>;
  waitFor(o?: { to?: string; since?: string; timeoutMs?: number }): Promise<Email>;
}

/** Injected dependencies so request handling stays pure and testable. */
export interface McpDeps {
  getMailbox(): MailboxLike;
}

/** A parsed JSON-RPC 2.0 request. Notifications omit `id`. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

// JSON-RPC 2.0 standard error codes.
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Resolve the command's envelope from arguments + mailbox. */
  run(box: MailboxLike, args: Record<string, unknown>): Promise<Envelope>;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const TOOLS: ToolDef[] = [
  {
    name: "cloudmail_latest",
    description: "Newest matching email, or null when the mailbox is empty.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address filter." },
        since: { type: "string", description: "ISO timestamp; only emails after this." },
      },
    },
    async run(box, args) {
      const data = await box.latest({ to: str(args, "to"), since: str(args, "since") });
      return ok("latest", data);
    },
  },
  {
    name: "cloudmail_list",
    description: "List matching emails, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address filter." },
        limit: { type: "number", description: "Max emails to return." },
        unread: { type: "boolean", description: "Only unread emails." },
      },
    },
    async run(box, args) {
      const data = await box.list({
        to: str(args, "to"),
        limit: num(args, "limit"),
        unread: args.unread === true,
      });
      return ok("list", data);
    },
  },
  {
    name: "cloudmail_get",
    description: "Fetch one email by numeric id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number", description: "Email id." } },
      required: ["id"],
    },
    async run(box, args) {
      const id = num(args, "id");
      if (id === undefined) {
        throw new CloudmailError("BAD_ARGS", "cloudmail_get requires a numeric `id`.", [
          "Pass `id` from a cloudmail_list / cloudmail_latest result.",
        ]);
      }
      const data = await box.get(id);
      return ok("get", data);
    },
  },
  {
    name: "cloudmail_code",
    description: "Extract a verification code/links; optionally long-poll.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address filter." },
        since: { type: "string", description: "ISO timestamp; only emails after this." },
        waitSec: { type: "number", description: "Long-poll the worker up to N seconds." },
      },
    },
    async run(box, args) {
      const waitSec = num(args, "waitSec");
      const data = await box.code({
        to: str(args, "to"),
        since: str(args, "since"),
        waitMs: waitSec !== undefined ? waitSec * 1000 : undefined,
      });
      return ok("code", data);
    },
  },
  {
    name: "cloudmail_wait",
    description: "Block until a new email arrives, then return it.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address filter." },
        since: { type: "string", description: "Watermark; resolve on email newer than this." },
        timeoutSec: { type: "number", description: "Give up after N seconds (TIMEOUT)." },
      },
    },
    async run(box, args) {
      const timeoutSec = num(args, "timeoutSec");
      const data = await box.waitFor({
        to: str(args, "to"),
        since: str(args, "since"),
        timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
      });
      return ok("wait", data);
    },
  },
];

function rpcResult(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Wrap an envelope as the MCP tool-call result (single text content block). */
function toolResult(env: Envelope): { content: { type: "text"; text: string }[]; isError: boolean } {
  return {
    content: [{ type: "text", text: JSON.stringify(env, null, 2) }],
    isError: !env.ok,
  };
}

/** Map a thrown error to a cloudmail error envelope for the given command. */
function errorEnvelope(command: string, e: unknown): Envelope {
  if (e instanceof CloudmailError) return err(command, e.toStructured());
  const message = e instanceof Error ? e.message : String(e);
  return err(command, { code: "INTERNAL", message, suggestions: [] });
}

async function runToolCall(deps: McpDeps, params: unknown): Promise<unknown> {
  if (params === null || typeof params !== "object") {
    return null; // signal: caller should emit INVALID_PARAMS
  }
  const p = params as { name?: unknown; arguments?: unknown };
  const name = typeof p.name === "string" ? p.name : "";
  const args =
    p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {};

  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return toolResult(
      err("mcp", {
        code: "BAD_ARGS",
        message: `Unknown tool "${name}".`,
        suggestions: [`Known tools: ${TOOLS.map((t) => t.name).join(", ")}.`],
      }),
    );
  }

  const command = name.replace(/^cloudmail_/, "");
  try {
    const box = deps.getMailbox();
    const env = await tool.run(box, args);
    return toolResult(env);
  } catch (e) {
    return toolResult(errorEnvelope(command, e));
  }
}

/**
 * Pure JSON-RPC request handler. Returns the response object, or `null` for
 * notifications (requests without an `id`) which must not be answered.
 */
export async function handleRpc(
  request: JsonRpcRequest,
  deps: McpDeps,
): Promise<JsonRpcResponse | null> {
  // A notification carries no `id`. By the MCP convention, `notifications/*`
  // methods are always notifications and must never be answered.
  const isNotification = request.id === undefined || request.method.startsWith("notifications/");
  const id = request.id ?? null;

  switch (request.method) {
    case "initialize": {
      if (isNotification) return null;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    }
    case "tools/list": {
      if (isNotification) return null;
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }
    case "tools/call": {
      if (isNotification) return null;
      const result = await runToolCall(deps, request.params);
      if (result === null) {
        return rpcError(id, INVALID_PARAMS, "tools/call requires an object `params`.");
      }
      return rpcResult(id, result);
    }
    default: {
      // Notifications (e.g. notifications/initialized) are silently accepted.
      if (isNotification) return null;
      return rpcError(id, METHOD_NOT_FOUND, `Unknown method "${request.method}".`);
    }
  }
}

/**
 * Start the stdio MCP server: read newline-delimited JSON-RPC requests from
 * stdin, dispatch through {@link handleRpc}, and write responses to stdout.
 * Resolves when stdin closes.
 */
export async function startMcpServer(profileName?: string): Promise<void> {
  // Resolve the profile once at startup so misconfiguration fails fast and
  // visibly, before we begin the JSON-RPC loop.
  const profile = resolveProfile(profileName);
  const mailbox = new Mailbox(profile);
  const deps: McpDeps = { getMailbox: () => mailbox };

  const encoder = new TextEncoder();
  const write = (res: JsonRpcResponse): void => {
    process.stdout.write(encoder.encode(JSON.stringify(res) + "\n"));
  };

  let buffer = "";
  const flushLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest;
    } catch {
      // Cannot recover an id from unparseable input; emit a null-id parse error.
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } });
      return;
    }
    const res = await handleRpc(request, deps);
    if (res !== null) write(res);
  };

  for await (const chunk of process.stdin) {
    buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      await flushLine(line);
    }
  }
  // Process any trailing line without a terminating newline.
  if (buffer.trim() !== "") await flushLine(buffer);
}
