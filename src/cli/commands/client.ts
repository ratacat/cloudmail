import type { Envelope } from "../../contracts/envelope";
import { ok } from "../../contracts/envelope";
import { CloudmailError, ErrorCode } from "../../contracts/errors";
import type { Profile } from "../../contracts/types";
import { Mailbox } from "../../core/mailbox";
import { resolveProfile } from "../../core/profile";
import type { CommandCtx } from "../dispatch";

/** Build a Mailbox from the resolved profile (env > named > active). */
function mailboxFor(ctx: CommandCtx): { box: Mailbox; profile: Profile } {
  const profile = resolveProfile(ctx.args.profile);
  return { box: new Mailbox(profile), profile };
}

/** A string flag value, or undefined when absent/boolean. */
function strFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Parse a numeric flag; BAD_ARGS when present but not a positive integer. */
function numFlag(flags: Record<string, string | boolean>, name: string): number | undefined {
  const v = flags[name];
  if (v === undefined || v === true) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new CloudmailError(ErrorCode.BAD_ARGS, `Flag --${name} must be a positive integer.`, [
      `Example: --${name} 5.`,
    ]);
  }
  return n;
}

/** Resolve the recipient filter: --to flag wins, else the profile default. */
function recipient(ctx: CommandCtx, profile: Profile): string | undefined {
  return strFlag(ctx.args.flags, "to") ?? profile.defaultTo;
}

export async function runLatest(ctx: CommandCtx): Promise<Envelope> {
  const { box, profile } = mailboxFor(ctx);
  const email = await box.latest({
    ...optional("to", recipient(ctx, profile)),
    ...optional("since", strFlag(ctx.args.flags, "since")),
  });
  if (email === null) {
    throw new CloudmailError(ErrorCode.NOT_FOUND, "Mailbox is empty.", [
      "Wait for an email, or use `cloudmail wait` to block until one arrives.",
    ]);
  }
  return ok("latest", email);
}

export async function runList(ctx: CommandCtx): Promise<Envelope> {
  const { box, profile } = mailboxFor(ctx);
  const limit = numFlag(ctx.args.flags, "limit");
  const emails = await box.list({
    ...optional("to", recipient(ctx, profile)),
    ...(limit !== undefined ? { limit } : {}),
    ...(ctx.args.flags["unread"] === true ? { unread: true } : {}),
  });
  return ok("list", emails);
}

export async function runGet(ctx: CommandCtx): Promise<Envelope> {
  const idRaw = ctx.args.positionals[0];
  if (idRaw === undefined) {
    throw new CloudmailError(ErrorCode.BAD_ARGS, "get requires an email id.", [
      "Usage: get <id>. Run `cloudmail list` for ids.",
    ]);
  }
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new CloudmailError(ErrorCode.BAD_ARGS, `Invalid email id "${idRaw}".`, [
      "Pass a positive integer id.",
    ]);
  }
  const { box } = mailboxFor(ctx);
  const email = await box.get(id);
  return ok("get", email);
}

export async function runCode(ctx: CommandCtx): Promise<Envelope> {
  const { box, profile } = mailboxFor(ctx);
  const waitMs = waitFlagMs(ctx);
  const result = await box.code({
    ...optional("to", recipient(ctx, profile)),
    ...optional("since", strFlag(ctx.args.flags, "since")),
    ...(waitMs !== undefined ? { waitMs } : {}),
  });
  return ok("code", result);
}

export async function runWait(ctx: CommandCtx): Promise<Envelope> {
  const { box, profile } = mailboxFor(ctx);
  const timeoutMs = waitFlagMs(ctx) ?? 30_000;
  const email = await box.waitFor({
    ...optional("to", recipient(ctx, profile)),
    ...optional("since", strFlag(ctx.args.flags, "since")),
    timeoutMs,
  });
  return ok("wait", email);
}

/** Resolve a `--wait <seconds>` / `--timeout <seconds>` flag into milliseconds. */
function waitFlagMs(ctx: CommandCtx): number | undefined {
  const secs = numFlag(ctx.args.flags, "wait") ?? numFlag(ctx.args.flags, "timeout");
  return secs === undefined ? undefined : secs * 1000;
}

/** Build a single-key object only when the value is present, for clean spreads. */
function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
  return value !== undefined && value.length > 0 ? ({ [key]: value } as Record<K, string>) : {};
}
