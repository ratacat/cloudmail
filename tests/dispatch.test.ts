import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseArgs } from "../src/cli/parse";
import { COMMANDS, dispatch, helpText, robotDocs } from "../src/cli/dispatch";
import { ExitCode } from "../src/contracts/exit";
import { ErrorCode } from "../src/contracts/errors";

let home: string;
const savedEnv: Record<string, string | undefined> = {};

function snapEnv(...keys: string[]): void {
  for (const k of keys) savedEnv[k] = process.env[k];
}
function restoreEnv(): void {
  for (const k of Object.keys(savedEnv)) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  snapEnv("CLOUDMAIL_HOME", "CLOUDMAIL_WORKER_URL", "CLOUDMAIL_API_KEY");
  home = mkdtempSync(join(tmpdir(), "cloudmail-dispatch-"));
  process.env.CLOUDMAIL_HOME = home;
  delete process.env.CLOUDMAIL_WORKER_URL;
  delete process.env.CLOUDMAIL_API_KEY;
});

afterEach(() => {
  restoreEnv();
  rmSync(home, { recursive: true, force: true });
});

async function run(argvLine: string, isTTY = false) {
  const args = parseArgs(argvLine.split(" ").filter((s) => s.length > 0));
  return dispatch(args, isTTY);
}

describe("helpText", () => {
  test("is a dense single block listing all commands", () => {
    const help = helpText();
    expect(typeof help).toBe("string");
    for (const c of ["latest", "list", "get", "code", "wait", "config", "status", "doctor", "robot-docs"]) {
      expect(help).toContain(c);
    }
    // Dense — roughly under ~120 words.
    expect(help.split(/\s+/).length).toBeLessThan(160);
  });
});

describe("robotDocs", () => {
  test("returns a machine schema with commands, exit codes, error codes", () => {
    const docs = robotDocs() as Record<string, unknown>;
    expect(Array.isArray(docs.commands)).toBe(true);
    const names = (docs.commands as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["latest", "list", "get", "code", "wait", "config", "status", "doctor", "robot-docs"]) {
      expect(names).toContain(c);
    }
    expect(docs.exitCodes).toMatchObject({ OK: ExitCode.OK, TIMEOUT: ExitCode.TIMEOUT });
    expect(docs.errorCodes).toContain(ErrorCode.NOT_FOUND);
    expect(docs.errorCodes).toContain(ErrorCode.TIMEOUT);
  });
});

describe("COMMANDS", () => {
  test("exposes all commands with short summaries", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const c of ["latest", "list", "get", "code", "wait", "config", "status", "doctor", "robot-docs"]) {
      expect(names).toContain(c);
    }
    for (const c of COMMANDS) {
      expect(c.summary.length).toBeLessThanOrEqual(70);
      expect(typeof c.run).toBe("function");
    }
  });
});

describe("dispatch routing + error mapping", () => {
  test("unknown command -> UNKNOWN_COMMAND, exit BAD_ARGS", async () => {
    const { env, exit } = await run("frobnicate");
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe(ErrorCode.UNKNOWN_COMMAND);
    expect(exit).toBe(ExitCode.BAD_ARGS);
  });

  test("help command -> ok envelope with help text", async () => {
    const { env, exit } = await run("help");
    expect(env.ok).toBe(true);
    expect(exit).toBe(ExitCode.OK);
  });

  test("robot-docs command -> ok envelope with schema", async () => {
    const { env, exit } = await run("robot-docs");
    expect(env.ok).toBe(true);
    expect(exit).toBe(ExitCode.OK);
    expect((env.data as Record<string, unknown>).commands).toBeDefined();
  });

  test("client command with no profile -> PROFILE_MISSING, exit CONFIG", async () => {
    const { env, exit } = await run("latest");
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe(ErrorCode.PROFILE_MISSING);
    expect(exit).toBe(ExitCode.CONFIG);
  });
});

describe("config command", () => {
  test("set then get then list then use", async () => {
    let r = await run("config set acme --worker-url https://w.example.com --api-key secret123");
    expect(r.env.ok).toBe(true);
    expect(r.exit).toBe(ExitCode.OK);

    r = await run("config get acme");
    expect(r.env.ok).toBe(true);
    expect((r.env.data as Record<string, unknown>).name).toBe("acme");

    r = await run("config list");
    expect(r.env.ok).toBe(true);
    expect(Array.isArray(r.env.data)).toBe(true);

    r = await run("config set other --worker-url https://o.example.com --api-key k2");
    expect(r.env.ok).toBe(true);
    r = await run("config use acme");
    expect(r.env.ok).toBe(true);

    // both profiles exist; acme is active, other is not
    r = await run("config get other");
    expect(r.env.ok).toBe(true);
    expect((r.env.data as Record<string, unknown>).active).toBe(false);

    r = await run("config get acme");
    expect(r.env.ok).toBe(true);
    expect((r.env.data as Record<string, unknown>).active).toBe(true);
  });

  test("config use unknown -> PROFILE_MISSING", async () => {
    const r = await run("config use ghost");
    expect(r.env.ok).toBe(false);
    expect(r.env.error?.code).toBe(ErrorCode.PROFILE_MISSING);
    expect(r.exit).toBe(ExitCode.CONFIG);
  });

  test("config set missing required flags -> BAD_ARGS", async () => {
    const r = await run("config set bad --worker-url https://x.example.com");
    expect(r.env.ok).toBe(false);
    expect(r.env.error?.code).toBe(ErrorCode.BAD_ARGS);
  });

  test("config unknown subcommand -> BAD_ARGS", async () => {
    const r = await run("config wibble");
    expect(r.env.ok).toBe(false);
    expect(r.env.error?.code).toBe(ErrorCode.BAD_ARGS);
  });
});

describe("latest happy path via env profile + fake fetch", () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
    process.env.CLOUDMAIL_WORKER_URL = "https://worker.example.com";
    process.env.CLOUDMAIL_API_KEY = "key";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("latest returns the email payload", async () => {
    const email = {
      id: 7,
      sender: "no-reply@svc.com",
      recipient: "u@mail.test",
      subject: "Your code",
      text: "code 123456",
      html: null,
      message_id: "m1",
      in_reply_to: null,
      received_at: "2026-05-28T00:00:00Z",
      read: 0,
    };
    // Worker wraps the latest email as { email: ... }.
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ email }), { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;

    const { env, exit } = await run("latest");
    expect(env.ok).toBe(true);
    expect(exit).toBe(ExitCode.OK);
    expect((env.data as { id: number }).id).toBe(7);
  });

  test("latest with empty mailbox -> NOT_FOUND", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 204 })) as unknown as typeof fetch;
    const { env, exit } = await run("latest");
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe(ErrorCode.NOT_FOUND);
    expect(exit).toBe(ExitCode.NOT_FOUND);
  });

  test("worker 401 -> AUTH exit", async () => {
    globalThis.fetch = mock(async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    const { env, exit } = await run("latest");
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe(ErrorCode.AUTH);
    expect(exit).toBe(ExitCode.AUTH);
  });
});

describe("doctor", () => {
  let realFetch: typeof fetch;
  beforeEach(() => {
    realFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("no profile -> ok envelope reporting unhealthy profile check", async () => {
    const { env } = await run("doctor");
    // doctor never throws; it reports check results.
    expect(env.ok).toBe(true);
    const data = env.data as { checks: Array<{ name: string; ok: boolean }> };
    const profileCheck = data.checks.find((c) => c.name === "profile");
    expect(profileCheck?.ok).toBe(false);
  });

  test("with profile + reachable health -> all checks ok", async () => {
    process.env.CLOUDMAIL_WORKER_URL = "https://worker.example.com";
    process.env.CLOUDMAIL_API_KEY = "key";
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as unknown as typeof fetch;
    const { env, exit } = await run("doctor");
    expect(env.ok).toBe(true);
    expect(exit).toBe(ExitCode.OK);
    const data = env.data as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
    expect(data.ok).toBe(true);
    expect(data.checks.every((c) => c.ok)).toBe(true);
  });
});

describe("status", () => {
  test("reports active profile name when set", async () => {
    process.env.CLOUDMAIL_WORKER_URL = "https://worker.example.com";
    process.env.CLOUDMAIL_API_KEY = "key";
    const { env, exit } = await run("status");
    expect(env.ok).toBe(true);
    expect(exit).toBe(ExitCode.OK);
    expect((env.data as { profile: string }).profile).toBe("env");
  });
});
