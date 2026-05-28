import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs";
import { CloudmailError, ErrorCode } from "../contracts/errors";
import type { Profile, ProfileStore } from "../contracts/types";

const ENV_PROFILE_NAME = "env";

/** Root directory holding the config file. Honors $CLOUDMAIL_HOME, else ~/.cloudmail. */
function configHome(): string {
  const override = process.env.CLOUDMAIL_HOME;
  return override && override.length > 0 ? override : join(homedir(), ".cloudmail");
}

function configPath(): string {
  return join(configHome(), "profiles.json");
}

/**
 * Path to the profiles file, resolved at module load from $CLOUDMAIL_HOME (or
 * ~/.cloudmail). All read/write helpers re-resolve the path internally so they
 * stay correct even if the environment changes after import.
 */
export const CONFIG_PATH: string = configPath();

function emptyStore(): ProfileStore {
  return { active: "", profiles: {} };
}

/** Load the profile store. Returns an empty store when the file is absent; never throws on missing. */
export function loadStore(): ProfileStore {
  const path = configPath();
  if (!existsSync(path)) return emptyStore();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new CloudmailError(
      ErrorCode.CONFIG_MISSING,
      `Failed to read config at ${path}: ${(e as Error).message}`,
      ["Check file permissions on the cloudmail config directory."],
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CloudmailError(
      ErrorCode.CONFIG_MISSING,
      `Config at ${path} is not valid JSON: ${(e as Error).message}`,
      [`Delete ${path} to reset, or fix the JSON by hand.`],
    );
  }
  if (parsed === null || typeof parsed !== "object") return emptyStore();
  const obj = parsed as Partial<ProfileStore>;
  return {
    active: typeof obj.active === "string" ? obj.active : "",
    profiles: obj.profiles && typeof obj.profiles === "object" ? obj.profiles : {},
  };
}

/** Persist the profile store to disk with mode 0600. */
export function saveStore(store: ProfileStore): void {
  const dir = configHome();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath();
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  // writeFileSync mode only applies on create; enforce 0600 unconditionally.
  chmodSync(path, 0o600);
}

/** Add or replace a profile. The first profile (or makeActive) becomes the active one. */
export function setProfile(p: Profile, makeActive?: boolean): void {
  const store = loadStore();
  store.profiles[p.name] = p;
  if (makeActive || store.active.length === 0) {
    store.active = p.name;
  }
  saveStore(store);
}

/** Set the active profile by name. Throws PROFILE_MISSING if unknown. */
export function setActive(name: string): void {
  const store = loadStore();
  const profile = store.profiles[name];
  if (!profile) {
    throw new CloudmailError(
      ErrorCode.PROFILE_MISSING,
      `No profile named "${name}".`,
      [
        `Run \`cloudmail config list\` to see configured profiles.`,
        `Create it with \`cloudmail config set ${name} --worker-url <url> --api-key <key>\`.`,
      ],
    );
  }
  store.active = name;
  saveStore(store);
}

/** Build an ephemeral env profile when both env vars are present, else null. */
function envProfile(): Profile | null {
  const workerUrl = process.env.CLOUDMAIL_WORKER_URL;
  const apiKey = process.env.CLOUDMAIL_API_KEY;
  if (workerUrl && workerUrl.length > 0 && apiKey && apiKey.length > 0) {
    return { name: ENV_PROFILE_NAME, workerUrl, apiKey };
  }
  return null;
}

/**
 * Resolve a profile in precedence order: env vars > named > active.
 * Throws PROFILE_MISSING with actionable suggestions when nothing resolves.
 */
export function resolveProfile(name?: string): Profile {
  const fromEnv = envProfile();
  if (fromEnv) return fromEnv;

  const store = loadStore();

  if (name !== undefined && name.length > 0) {
    const named = store.profiles[name];
    if (named) return named;
    throw new CloudmailError(
      ErrorCode.PROFILE_MISSING,
      `No profile named "${name}".`,
      [
        `Run \`cloudmail config list\` to see configured profiles.`,
        `Create it with \`cloudmail config set ${name} --worker-url <url> --api-key <key>\`.`,
        `Or set CLOUDMAIL_WORKER_URL and CLOUDMAIL_API_KEY for an ephemeral profile.`,
      ],
    );
  }

  if (store.active.length > 0) {
    const active = store.profiles[store.active];
    if (active) return active;
  }

  throw new CloudmailError(
    ErrorCode.PROFILE_MISSING,
    "No active cloudmail profile configured.",
    [
      `Create one with \`cloudmail config set <name> --worker-url <url> --api-key <key>\`.`,
      `Or set CLOUDMAIL_WORKER_URL and CLOUDMAIL_API_KEY in your environment.`,
      `List existing profiles with \`cloudmail config list\`.`,
    ],
  );
}
