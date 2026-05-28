#!/usr/bin/env bun
import { parseArgs } from "../src/cli/parse";
import { dispatch } from "../src/cli/dispatch";
import { resolveMode, emit } from "../src/format/render";
import { startMcpServer } from "../src/mcp/server";
import { CloudmailError, ErrorCode } from "../src/contracts/errors";
import { err } from "../src/contracts/envelope";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const isTTY = Boolean(process.stdout.isTTY);

  let args;
  try {
    args = parseArgs(argv);
  } catch (caught) {
    // Argument errors happen before we know the desired mode; default by TTY.
    const e =
      caught instanceof CloudmailError
        ? caught
        : new CloudmailError(ErrorCode.BAD_ARGS, String(caught), []);
    const mode = isTTY ? "human" : "json";
    emit(err("cloudmail", e.toStructured()), mode);
    return e.exitCode;
  }

  // `mcp` is a long-lived stdio server, not a one-shot command.
  if (args.command === "mcp") {
    await startMcpServer(args.profile);
    return 0;
  }

  const { env, exit } = await dispatch(args, isTTY);
  const mode = resolveMode({ json: args.json, human: args.human }, isTTY);
  emit(env, mode, undefined, args.full);
  return exit;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    // Last-resort guard: never crash without a structured line.
    const mode = process.stdout.isTTY ? "human" : "json";
    const ce =
      e instanceof CloudmailError
        ? e
        : new CloudmailError(ErrorCode.INTERNAL, e instanceof Error ? e.message : String(e), []);
    emit(err("cloudmail", ce.toStructured()), mode);
    process.exit(ce.exitCode);
  },
);
