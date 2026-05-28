import { test, expect, describe } from "bun:test";
import { parseArgs } from "../src/cli/parse";
import { CloudmailError, ErrorCode } from "../src/contracts/errors";

describe("parseArgs — boolean flags unread/active", () => {
  test("--unread is boolean true at end of argv", () => {
    expect(parseArgs(["list", "--unread"]).flags["unread"]).toBe(true);
  });
  test("--active is boolean true even when followed by another flag", () => {
    const a = parseArgs(["config", "set", "p", "--api-key", "k", "--active", "--json"]);
    expect(a.flags["active"]).toBe(true);
    expect(a.json).toBe(true);
    expect(a.flags["api-key"]).toBe("k");
  });
  test("a boolean flag rejects an = value", () => {
    expect(() => parseArgs(["list", "--unread=1"])).toThrow();
  });
});

describe("parseArgs — command + positionals", () => {
  test("first positional becomes command", () => {
    const p = parseArgs(["latest"]);
    expect(p.command).toBe("latest");
    expect(p.positionals).toEqual([]);
  });

  test("empty argv => null command", () => {
    const p = parseArgs([]);
    expect(p.command).toBeNull();
    expect(p.positionals).toEqual([]);
  });

  test("extra positionals after command are collected", () => {
    const p = parseArgs(["get", "42"]);
    expect(p.command).toBe("get");
    expect(p.positionals).toEqual(["42"]);
  });

  test("multiple positionals preserve order", () => {
    const p = parseArgs(["config", "set", "default"]);
    expect(p.command).toBe("config");
    expect(p.positionals).toEqual(["set", "default"]);
  });
});

describe("parseArgs — help shortcuts", () => {
  test("leading --help => command help", () => {
    const p = parseArgs(["--help"]);
    expect(p.command).toBe("help");
  });

  test("leading -h => command help", () => {
    const p = parseArgs(["-h"]);
    expect(p.command).toBe("help");
  });

  test("--help is leading only when it precedes a command", () => {
    // --help appears before any positional => help
    const p = parseArgs(["--help", "extra"]);
    expect(p.command).toBe("help");
  });

  test("--help after a command is a boolean flag, not the command", () => {
    const p = parseArgs(["latest", "--help"]);
    expect(p.command).toBe("latest");
    expect(p.flags["help"]).toBe(true);
  });
});

describe("parseArgs — boolean flags", () => {
  test("--json sets json true", () => {
    const p = parseArgs(["latest", "--json"]);
    expect(p.json).toBe(true);
    expect(p.flags["json"]).toBe(true);
  });

  test("--human sets human true", () => {
    const p = parseArgs(["latest", "--human"]);
    expect(p.human).toBe(true);
  });

  test("--full sets full true", () => {
    const p = parseArgs(["get", "1", "--full"]);
    expect(p.full).toBe(true);
  });

  test("--quiet sets quiet true", () => {
    const p = parseArgs(["latest", "--quiet"]);
    expect(p.quiet).toBe(true);
  });

  test("booleans default to false", () => {
    const p = parseArgs(["latest"]);
    expect(p.json).toBe(false);
    expect(p.human).toBe(false);
    expect(p.full).toBe(false);
    expect(p.quiet).toBe(false);
  });

  test("multiple booleans combine", () => {
    const p = parseArgs(["list", "--json", "--full", "--quiet"]);
    expect(p.json).toBe(true);
    expect(p.full).toBe(true);
    expect(p.quiet).toBe(true);
    expect(p.human).toBe(false);
  });
});

describe("parseArgs — value flags (space form)", () => {
  test("--to value", () => {
    const p = parseArgs(["list", "--to", "alias@x.com"]);
    expect(p.flags["to"]).toBe("alias@x.com");
  });

  test("--since value", () => {
    const p = parseArgs(["latest", "--since", "2026-01-01"]);
    expect(p.flags["since"]).toBe("2026-01-01");
  });

  test("--wait value", () => {
    const p = parseArgs(["code", "--wait", "30"]);
    expect(p.flags["wait"]).toBe("30");
  });

  test("--limit value", () => {
    const p = parseArgs(["list", "--limit", "10"]);
    expect(p.flags["limit"]).toBe("10");
  });

  test("--profile value sets profile field", () => {
    const p = parseArgs(["latest", "--profile", "work"]);
    expect(p.flags["profile"]).toBe("work");
    expect(p.profile).toBe("work");
  });
});

describe("parseArgs — value flags (= form)", () => {
  test("--to=value", () => {
    const p = parseArgs(["list", "--to=alias@x.com"]);
    expect(p.flags["to"]).toBe("alias@x.com");
  });

  test("--limit=5", () => {
    const p = parseArgs(["list", "--limit=5"]);
    expect(p.flags["limit"]).toBe("5");
  });

  test("--profile=work sets profile field", () => {
    const p = parseArgs(["latest", "--profile=work"]);
    expect(p.profile).toBe("work");
  });

  test("--flag= empty value yields empty string", () => {
    const p = parseArgs(["list", "--to="]);
    expect(p.flags["to"]).toBe("");
  });

  test("= form value can itself contain = signs", () => {
    const p = parseArgs(["list", "--to=a=b@x.com"]);
    expect(p.flags["to"]).toBe("a=b@x.com");
  });
});

describe("parseArgs — short flags", () => {
  test("-n is limit", () => {
    const p = parseArgs(["list", "-n", "5"]);
    expect(p.flags["limit"]).toBe("5");
  });

  test("-p is profile", () => {
    const p = parseArgs(["latest", "-p", "work"]);
    expect(p.profile).toBe("work");
    expect(p.flags["profile"]).toBe("work");
  });

  test("-n=5 = form", () => {
    const p = parseArgs(["list", "-n=5"]);
    expect(p.flags["limit"]).toBe("5");
  });
});

describe("parseArgs — malformed", () => {
  test("value-expecting flag at end with no value throws BAD_ARGS", () => {
    expect(() => parseArgs(["list", "--to"])).toThrow(CloudmailError);
    try {
      parseArgs(["list", "--to"]);
    } catch (e) {
      expect(e).toBeInstanceOf(CloudmailError);
      expect((e as CloudmailError).code).toBe(ErrorCode.BAD_ARGS);
    }
  });

  test("-n at end with no value throws BAD_ARGS", () => {
    try {
      parseArgs(["list", "-n"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CloudmailError);
      expect((e as CloudmailError).code).toBe(ErrorCode.BAD_ARGS);
    }
  });

  test("value flag followed by another flag throws BAD_ARGS", () => {
    try {
      parseArgs(["list", "--to", "--json"]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as CloudmailError).code).toBe(ErrorCode.BAD_ARGS);
    }
  });

  test("--profile at end with no value throws BAD_ARGS", () => {
    expect(() => parseArgs(["latest", "--profile"])).toThrow(CloudmailError);
  });
});

describe("parseArgs — mixed real-world", () => {
  test("full command line parses cleanly", () => {
    const p = parseArgs([
      "code",
      "--to",
      "signup@x.com",
      "--wait=30",
      "-p",
      "work",
      "--json",
    ]);
    expect(p.command).toBe("code");
    expect(p.flags["to"]).toBe("signup@x.com");
    expect(p.flags["wait"]).toBe("30");
    expect(p.profile).toBe("work");
    expect(p.json).toBe(true);
  });

  test("positionals and flags interleave", () => {
    const p = parseArgs(["get", "--json", "99"]);
    expect(p.command).toBe("get");
    expect(p.positionals).toEqual(["99"]);
    expect(p.json).toBe(true);
  });

  test("value-form flag value that looks numeric stays a string", () => {
    const p = parseArgs(["list", "--limit", "0"]);
    expect(p.flags["limit"]).toBe("0");
    expect(typeof p.flags["limit"]).toBe("string");
  });

  test("a value that looks like a flag is accepted via = form", () => {
    const p = parseArgs(["list", "--to=--weird@x.com"]);
    expect(p.flags["to"]).toBe("--weird@x.com");
  });
});
