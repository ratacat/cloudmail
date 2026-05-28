import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, mkdirSync, existsSync, readFileSync, statSync } from "fs";
import { CloudmailError } from "../src/contracts/errors";
import type { Profile } from "../src/contracts/types";

// Each test gets a fresh CLOUDMAIL_HOME so we never touch the real config.
let home: string;
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ["CLOUDMAIL_HOME", "CLOUDMAIL_WORKER_URL", "CLOUDMAIL_API_KEY"] as const;

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  home = join(tmpdir(), `cloudmail-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  process.env.CLOUDMAIL_HOME = home;
  delete process.env.CLOUDMAIL_WORKER_URL;
  delete process.env.CLOUDMAIL_API_KEY;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  if (home && existsSync(home)) rmSync(home, { recursive: true, force: true });
});

// Import fresh so module reads current env. profile.ts derives paths at call
// time (functions read env each call), so a single static import is fine.
import { CONFIG_PATH, loadStore, saveStore, resolveProfile, setProfile, setActive } from "../src/core/profile";

// Per-test config path (helpers re-resolve $CLOUDMAIL_HOME internally).
const cfgPath = () => join(home, "profiles.json");

const sample = (over: Partial<Profile> = {}): Profile => ({
  name: "alpha",
  workerUrl: "https://alpha.example.com",
  apiKey: "key-alpha",
  ...over,
});

describe("CONFIG_PATH", () => {
  // CONFIG_PATH is resolved at module import (ESM imports run before this file's
  // top-level statements), so it reflects the home present at import time and
  // always ends in profiles.json. Per-test homing is exercised via the helpers.
  test("points at a profiles.json file", () => {
    expect(CONFIG_PATH.endsWith("profiles.json")).toBe(true);
  });
});

describe("loadStore", () => {
  test("returns empty default when file absent, never throws", () => {
    const store = loadStore();
    expect(store).toEqual({ active: "", profiles: {} });
  });
});

describe("setProfile + saveStore + reload", () => {
  test("persists a profile and reloads it", () => {
    setProfile(sample());
    const reloaded = loadStore();
    expect(reloaded.profiles.alpha).toEqual(sample());
  });

  test("file is written with mode 0600", () => {
    setProfile(sample());
    const mode = statSync(cfgPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("saveStore writes valid JSON", () => {
    saveStore({ active: "alpha", profiles: { alpha: sample() } });
    const raw = readFileSync(cfgPath(), "utf8");
    expect(JSON.parse(raw)).toEqual({ active: "alpha", profiles: { alpha: sample() } });
  });

  test("setProfile with makeActive sets active", () => {
    setProfile(sample(), true);
    expect(loadStore().active).toBe("alpha");
  });

  test("first profile becomes active automatically when none set", () => {
    setProfile(sample());
    expect(loadStore().active).toBe("alpha");
  });

  test("adding a second profile does not steal active", () => {
    setProfile(sample(), true);
    setProfile(sample({ name: "beta", workerUrl: "https://beta.example.com", apiKey: "key-beta" }));
    expect(loadStore().active).toBe("alpha");
  });
});

describe("setActive", () => {
  test("sets active to a known profile", () => {
    setProfile(sample());
    setProfile(sample({ name: "beta", workerUrl: "https://b.example.com", apiKey: "kb" }));
    setActive("beta");
    expect(loadStore().active).toBe("beta");
  });

  test("throws PROFILE_MISSING for unknown profile", () => {
    setProfile(sample());
    try {
      setActive("ghost");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudmailError);
      expect((e as CloudmailError).code).toBe("PROFILE_MISSING");
    }
  });
});

describe("resolveProfile", () => {
  test("resolves named profile", () => {
    setProfile(sample());
    setProfile(sample({ name: "beta", workerUrl: "https://b.example.com", apiKey: "kb" }));
    expect(resolveProfile("beta").name).toBe("beta");
  });

  test("resolves active profile when no name given", () => {
    setProfile(sample(), true);
    expect(resolveProfile().name).toBe("alpha");
  });

  test("env profile wins over file when CLOUDMAIL_WORKER_URL + CLOUDMAIL_API_KEY set", () => {
    setProfile(sample(), true);
    process.env.CLOUDMAIL_WORKER_URL = "https://env.example.com";
    process.env.CLOUDMAIL_API_KEY = "env-key";
    const p = resolveProfile();
    expect(p.name).toBe("env");
    expect(p.workerUrl).toBe("https://env.example.com");
    expect(p.apiKey).toBe("env-key");
  });

  test("env profile wins even when a name is requested", () => {
    setProfile(sample(), true);
    process.env.CLOUDMAIL_WORKER_URL = "https://env.example.com";
    process.env.CLOUDMAIL_API_KEY = "env-key";
    expect(resolveProfile("alpha").name).toBe("env");
  });

  test("partial env (only worker url) does NOT form an env profile", () => {
    setProfile(sample(), true);
    process.env.CLOUDMAIL_WORKER_URL = "https://env.example.com";
    expect(resolveProfile().name).toBe("alpha");
  });

  test("throws PROFILE_MISSING with suggestions when nothing resolves", () => {
    try {
      resolveProfile();
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudmailError);
      expect((e as CloudmailError).code).toBe("PROFILE_MISSING");
      expect((e as CloudmailError).suggestions.length).toBeGreaterThan(0);
    }
  });

  test("throws PROFILE_MISSING when named profile unknown", () => {
    setProfile(sample(), true);
    try {
      resolveProfile("nope");
      throw new Error("expected throw");
    } catch (e) {
      expect((e as CloudmailError).code).toBe("PROFILE_MISSING");
    }
  });

  test("throws PROFILE_MISSING when active points at missing profile", () => {
    saveStore({ active: "gone", profiles: {} });
    try {
      resolveProfile();
      throw new Error("expected throw");
    } catch (e) {
      expect((e as CloudmailError).code).toBe("PROFILE_MISSING");
    }
  });
});
