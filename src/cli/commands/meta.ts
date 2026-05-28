import type { Envelope } from "../../contracts/envelope";
import { ok } from "../../contracts/envelope";
import { CloudmailError } from "../../contracts/errors";
import type { Profile } from "../../contracts/types";
import { loadStore, resolveProfile } from "../../core/profile";
import type { CommandCtx } from "../dispatch";

/** `status` — report the resolved profile + worker target without hitting the network. */
export async function runStatus(ctx: CommandCtx): Promise<Envelope> {
  const store = loadStore();
  let resolved: Profile | null = null;
  let resolveError: string | null = null;
  try {
    resolved = resolveProfile(ctx.args.profile);
  } catch (e) {
    resolveError = e instanceof CloudmailError ? e.message : String(e);
  }
  return ok("status", {
    profile: resolved?.name ?? null,
    workerUrl: resolved?.workerUrl ?? null,
    active: store.active || null,
    profiles: Object.keys(store.profiles),
    resolveError,
  });
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * `doctor` — diagnose configuration + connectivity. Never throws: it collects
 * check results and reports them, so agents can branch on `data.ok`.
 * Checks: profile resolves, then GET /health is reachable.
 */
export async function runDoctor(ctx: CommandCtx): Promise<Envelope> {
  const checks: Check[] = [];

  let profile: Profile | null = null;
  try {
    profile = resolveProfile(ctx.args.profile);
    checks.push({ name: "profile", ok: true, detail: `resolved "${profile.name}"` });
  } catch (e) {
    checks.push({
      name: "profile",
      ok: false,
      detail: e instanceof CloudmailError ? e.message : String(e),
    });
  }

  if (profile) {
    checks.push(await healthCheck(profile));
  } else {
    checks.push({ name: "health", ok: false, detail: "skipped — no profile" });
  }

  const allOk = checks.every((c) => c.ok);
  return ok("doctor", { ok: allOk, checks });
}

/** GET /health (public) on the worker; success when it responds 2xx. */
async function healthCheck(profile: Profile): Promise<Check> {
  const f = fetch;
  const base = profile.workerUrl.replace(/\/+$/, "");
  const url = `${base}/health`;
  try {
    const res = await f(url, { method: "GET" });
    if (res.ok) {
      return { name: "health", ok: true, detail: `GET /health -> ${res.status}` };
    }
    return { name: "health", ok: false, detail: `GET /health -> ${res.status}` };
  } catch (e) {
    return {
      name: "health",
      ok: false,
      detail: `unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
