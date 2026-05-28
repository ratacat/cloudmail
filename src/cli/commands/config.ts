import type { Envelope } from "../../contracts/envelope";
import { ok } from "../../contracts/envelope";
import { CloudmailError, ErrorCode } from "../../contracts/errors";
import type { Profile } from "../../contracts/types";
import { loadStore, setProfile, setActive } from "../../core/profile";
import type { CommandCtx } from "../dispatch";

const COMMAND = "config";

/** Read a string flag, returning undefined when absent (boolean true counts as absent value). */
function strFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

/**
 * `config <sub> …` — manage connection profiles.
 * Subcommands: get <name?>, set <name> --worker-url --api-key [opts], list, use <name>.
 */
export async function runConfig(ctx: CommandCtx): Promise<Envelope> {
  const sub = ctx.args.positionals[0];
  switch (sub) {
    case undefined:
    case "list":
      return configList();
    case "get":
      return configGet(ctx.args.positionals[1]);
    case "set":
      return configSet(ctx);
    case "use":
      return configUse(ctx.args.positionals[1]);
    default:
      throw new CloudmailError(ErrorCode.BAD_ARGS, `Unknown config subcommand "${sub}".`, [
        "Use: config get|set|list|use.",
      ]);
  }
}

function configList(): Envelope {
  const store = loadStore();
  const rows = Object.values(store.profiles).map((p) => ({
    name: p.name,
    active: p.name === store.active,
    workerUrl: p.workerUrl,
    domain: p.domain ?? null,
  }));
  return ok(COMMAND, rows);
}

function configGet(name?: string): Envelope {
  const store = loadStore();
  const target = name && name.length > 0 ? name : store.active;
  if (!target) {
    throw new CloudmailError(ErrorCode.PROFILE_MISSING, "No active profile to show.", [
      "Set one with `cloudmail config set <name> --worker-url <url> --api-key <key>`.",
    ]);
  }
  const profile = store.profiles[target];
  if (!profile) {
    throw new CloudmailError(ErrorCode.PROFILE_MISSING, `No profile named "${target}".`, [
      "Run `cloudmail config list` to see configured profiles.",
    ]);
  }
  return ok(COMMAND, redact(profile, target === store.active));
}

function configSet(ctx: CommandCtx): Envelope {
  const name = ctx.args.positionals[1];
  if (!name) {
    throw new CloudmailError(ErrorCode.BAD_ARGS, "config set requires a profile name.", [
      "Usage: config set <name> --worker-url <url> --api-key <key>.",
    ]);
  }
  const flags = ctx.args.flags;
  const workerUrl = strFlag(flags, "worker-url");
  const apiKey = strFlag(flags, "api-key");
  if (!workerUrl || !apiKey) {
    const missing = [!workerUrl ? "--worker-url" : null, !apiKey ? "--api-key" : null]
      .filter(Boolean)
      .join(", ");
    throw new CloudmailError(ErrorCode.BAD_ARGS, `config set is missing ${missing}.`, [
      "Usage: config set <name> --worker-url <url> --api-key <key>.",
    ]);
  }

  const profile: Profile = { name, workerUrl, apiKey };
  const defaultTo = strFlag(flags, "to") ?? strFlag(flags, "default-to");
  const accountId = strFlag(flags, "account-id");
  const zoneId = strFlag(flags, "zone-id");
  const domain = strFlag(flags, "domain");
  if (defaultTo) profile.defaultTo = defaultTo;
  if (accountId) profile.accountId = accountId;
  if (zoneId) profile.zoneId = zoneId;
  if (domain) profile.domain = domain;

  const makeActive = flags["active"] === true;
  setProfile(profile, makeActive);
  const store = loadStore();
  return ok(COMMAND, { name, saved: true, active: store.active === name });
}

function configUse(name?: string): Envelope {
  if (!name) {
    throw new CloudmailError(ErrorCode.BAD_ARGS, "config use requires a profile name.", [
      "Usage: config use <name>.",
    ]);
  }
  setActive(name); // throws PROFILE_MISSING when unknown
  return ok(COMMAND, { active: name });
}

/** Mask the apiKey so a casual `config get` does not splatter secrets. */
function redact(p: Profile, active: boolean): Record<string, unknown> {
  return {
    name: p.name,
    active,
    workerUrl: p.workerUrl,
    apiKey: maskKey(p.apiKey),
    defaultTo: p.defaultTo ?? null,
    accountId: p.accountId ?? null,
    zoneId: p.zoneId ?? null,
    domain: p.domain ?? null,
  };
}

function maskKey(key: string): string {
  if (key.length <= 4) return "****";
  return `${key.slice(0, 2)}…${key.slice(-2)}`;
}
