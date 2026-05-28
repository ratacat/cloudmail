import type { Envelope } from "../contracts/envelope";
import { ok, err } from "../contracts/envelope";
import { CloudmailError, ErrorCode, exitCodeFor } from "../contracts/errors";
import { ExitCode } from "../contracts/exit";
import type { ParsedArgs } from "./parse";
import { runLatest, runList, runGet, runCode, runWait } from "./commands/client";
import { runConfig } from "./commands/config";
import { runStatus, runDoctor } from "./commands/meta";

/** Context handed to every command handler. */
export interface CommandCtx {
  args: ParsedArgs;
  isTTY: boolean;
}

/** A dispatchable CLI command (Command pattern). */
export interface Command {
  name: string;
  summary: string; // <= 70 chars, used to build the dense help block
  usage?: string;
  run(ctx: CommandCtx): Promise<Envelope>;
}

/** Every command in the CLI. The bin entry routes purely through this array. */
export const COMMANDS: Command[] = [
  {
    name: "latest",
    summary: "Show the newest received email",
    usage: "latest [--to <addr>] [--since <iso>]",
    run: runLatest,
  },
  {
    name: "list",
    summary: "List received emails (newest first)",
    usage: "list [--to <addr>] [-n <limit>] [--unread]",
    run: runList,
  },
  {
    name: "get",
    summary: "Fetch one email by id",
    usage: "get <id>",
    run: runGet,
  },
  {
    name: "code",
    summary: "Extract a verification code/link",
    usage: "code [--to <addr>] [--since <iso>] [--wait <sec>]",
    run: runCode,
  },
  {
    name: "wait",
    summary: "Block until a new email arrives",
    usage: "wait [--to <addr>] [--since <iso>] [--timeout <sec>]",
    run: runWait,
  },
  {
    name: "config",
    summary: "Manage profiles: get|set|list|use",
    usage: "config set <name> --worker-url <url> --api-key <key>",
    run: runConfig,
  },
  {
    name: "status",
    summary: "Show resolved profile + worker target",
    usage: "status",
    run: runStatus,
  },
  {
    name: "doctor",
    summary: "Diagnose profile + worker reachability",
    usage: "doctor",
    run: runDoctor,
  },
  {
    name: "robot-docs",
    summary: "Emit machine schema of commands+codes",
    usage: "robot-docs",
    run: async () => ok("robot-docs", robotDocs()),
  },
  {
    name: "help",
    summary: "Show this command list",
    usage: "help",
    run: async () => ok("help", { help: helpText() }),
  },
];

const BY_NAME: Map<string, Command> = new Map(COMMANDS.map((c) => [c.name, c]));

/**
 * Route parsed args to a command, run it, and return its envelope + process
 * exit code. Maps any thrown {@link CloudmailError} to an error envelope with
 * the matching exit code; success exits 0. A `--help` flag short-circuits to
 * the help command regardless of the named command.
 */
export async function dispatch(
  args: ParsedArgs,
  isTTY: boolean,
): Promise<{ env: Envelope; exit: number }> {
  const name = args.flags["help"] === true ? "help" : args.command;

  if (name === null || name === undefined) {
    return { env: ok("help", { help: helpText() }), exit: ExitCode.OK };
  }

  const command = BY_NAME.get(name);
  if (!command) {
    const e = new CloudmailError(
      ErrorCode.UNKNOWN_COMMAND,
      `Unknown command "${name}".`,
      [`Run \`cloudmail help\` for the command list.`],
    );
    return { env: err(name, e.toStructured()), exit: e.exitCode };
  }

  const start = Date.now();
  try {
    const env = await command.run({ args, isTTY });
    return { env, exit: ExitCode.OK };
  } catch (caught) {
    const e =
      caught instanceof CloudmailError
        ? caught
        : new CloudmailError(
            ErrorCode.INTERNAL,
            caught instanceof Error ? caught.message : String(caught),
            ["This is an unexpected internal error; rerun with --json for detail."],
          );
    const ms = Date.now() - start;
    return { env: err(command.name, e.toStructured(), { ms }), exit: e.exitCode };
  }
}

/**
 * Dense (~100-token) one-block command listing. Printed for a bare invocation.
 */
export function helpText(): string {
  const lines = ["cloudmail — read inbound email from a Cloudflare worker.", "", "commands:"];
  for (const c of COMMANDS) {
    lines.push(`  ${c.name.padEnd(11)} ${c.summary}`);
  }
  lines.push(
    "",
    "global: --json --human --full --quiet -p <profile> -h",
    "env: CLOUDMAIL_WORKER_URL CLOUDMAIL_API_KEY CLOUDMAIL_HOME",
  );
  return lines.join("\n");
}

/**
 * Machine-readable schema of the whole CLI: every command (name, summary,
 * usage, flags), the stable exit codes, and the error-code catalog. Agents
 * read this to learn the surface without scraping help text.
 */
export function robotDocs(): object {
  return {
    name: "cloudmail",
    description: "Read inbound email from a Cloudflare email worker.",
    commands: COMMANDS.map((c) => ({
      name: c.name,
      summary: c.summary,
      usage: c.usage ?? c.name,
      flags: FLAGS_BY_COMMAND[c.name] ?? [],
    })),
    globalFlags: [
      { name: "--json", description: "Force JSON output." },
      { name: "--human", description: "Force human output." },
      { name: "--full", description: "Do not truncate long fields." },
      { name: "--quiet", description: "Suppress non-essential output." },
      { name: "-p, --profile <name>", description: "Use a named profile." },
      { name: "-h, --help", description: "Show help." },
    ],
    env: ["CLOUDMAIL_WORKER_URL", "CLOUDMAIL_API_KEY", "CLOUDMAIL_HOME"],
    exitCodes: { ...ExitCode },
    errorCodes: Object.values(ErrorCode),
    errorExitMap: Object.fromEntries(
      Object.values(ErrorCode).map((code) => [code, exitCodeFor(code)]),
    ),
  };
}

/** Per-command flag documentation surfaced through {@link robotDocs}. */
const FLAGS_BY_COMMAND: Record<string, Array<{ name: string; description: string }>> = {
  latest: [
    { name: "--to <addr>", description: "Filter by recipient." },
    { name: "--since <iso>", description: "Only emails newer than this time." },
  ],
  list: [
    { name: "--to <addr>", description: "Filter by recipient." },
    { name: "-n, --limit <n>", description: "Max emails to return." },
    { name: "--unread", description: "Only unread emails." },
  ],
  get: [{ name: "<id>", description: "Email id (positional)." }],
  code: [
    { name: "--to <addr>", description: "Filter by recipient." },
    { name: "--since <iso>", description: "Only emails newer than this time." },
    { name: "--wait <sec>", description: "Long-poll up to N seconds for a code." },
  ],
  wait: [
    { name: "--to <addr>", description: "Filter by recipient." },
    { name: "--since <iso>", description: "Watermark; resolve only newer email." },
    { name: "--timeout <sec>", description: "Give up after N seconds (exit 124)." },
  ],
  config: [
    { name: "<sub>", description: "get | set | list | use." },
    { name: "--worker-url <url>", description: "Worker base URL (set)." },
    { name: "--api-key <key>", description: "Bearer API key (set)." },
    { name: "--to <addr>", description: "Default recipient filter (set)." },
    { name: "--domain <domain>", description: "Email domain (set)." },
    { name: "--account-id <id>", description: "Cloudflare account id (set)." },
    { name: "--zone-id <id>", description: "Cloudflare zone id (set)." },
    { name: "--active", description: "Make this profile active (set)." },
  ],
  status: [],
  doctor: [],
  "robot-docs": [],
  help: [],
};
