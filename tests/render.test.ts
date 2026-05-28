import { test, expect, describe } from "bun:test";
import { resolveMode, renderHuman, emit, truncate } from "../src/format/render";
import { ok, err } from "../src/contracts/envelope";
import type { Envelope } from "../src/contracts/envelope";

describe("resolveMode", () => {
  test("--json forces json even on TTY", () => {
    expect(resolveMode({ json: true }, true)).toBe("json");
  });
  test("--human forces human even off TTY", () => {
    expect(resolveMode({ human: true }, false)).toBe("human");
  });
  test("TTY defaults to human", () => {
    expect(resolveMode({}, true)).toBe("human");
  });
  test("non-TTY defaults to json", () => {
    expect(resolveMode({}, false)).toBe("json");
  });
  test("--json wins over --human when both set", () => {
    expect(resolveMode({ json: true, human: true }, true)).toBe("json");
  });
});

describe("truncate", () => {
  test("null returns empty string", () => {
    expect(truncate(null)).toBe("");
  });
  test("short string passes through", () => {
    expect(truncate("hello")).toBe("hello");
  });
  test("string at max passes through", () => {
    const s = "x".repeat(280);
    expect(truncate(s)).toBe(s);
  });
  test("long string is truncated with suffix and char count", () => {
    const s = "y".repeat(300);
    const out = truncate(s);
    expect(out.startsWith("y".repeat(280))).toBe(true);
    expect(out).toContain("…(+20 chars, --full)");
  });
  test("custom max", () => {
    const out = truncate("abcdefghij", 4);
    expect(out).toBe("abcd…(+6 chars, --full)");
  });
});

describe("renderHuman", () => {
  test("error envelope shows code, message, suggestions", () => {
    const env = err("code", {
      code: "NO_CODE",
      message: "no verification code found",
      suggestions: ["wait longer with --wait 30", "check --to filter"],
    });
    const out = renderHuman(env);
    expect(out).toContain("NO_CODE");
    expect(out).toContain("no verification code found");
    expect(out).toContain("wait longer with --wait 30");
    expect(out).toContain("check --to filter");
  });

  test("error envelope without suggestions still renders code+message", () => {
    const env = err("get", { code: "NOT_FOUND", message: "no email id 5", suggestions: [] });
    const out = renderHuman(env);
    expect(out).toContain("NOT_FOUND");
    expect(out).toContain("no email id 5");
  });

  test("ok envelope with null data renders something non-empty", () => {
    const env = ok("latest", null);
    const out = renderHuman(env);
    expect(typeof out).toBe("string");
  });

  test("ok envelope with object data renders dense key lines", () => {
    const env = ok("code", { code: "123456", from: "a@b.com", links: ["http://x"] });
    const out = renderHuman(env);
    expect(out).toContain("123456");
    expect(out).toContain("a@b.com");
  });

  test("ok envelope with array data renders one line per item", () => {
    const env = ok("list", [
      { id: 1, subject: "hi" },
      { id: 2, subject: "yo" },
    ]);
    const out = renderHuman(env);
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  test("scalar string data renders directly", () => {
    const env = ok("status", "ok") as Envelope;
    const out = renderHuman(env);
    expect(out).toContain("ok");
  });

  test("non-body string fields render in full (no truncation)", () => {
    const help = "x".repeat(600);
    const env = ok("help", { help });
    const out = renderHuman(env);
    expect(out).toContain(help);
    expect(out).not.toContain("--full");
  });

  test("email body field is truncated by default, expanded with full=true", () => {
    const text = "y".repeat(600);
    const env = ok("get", { id: 1, text });
    expect(renderHuman(env)).toContain("…(+320 chars, --full)");
    expect(renderHuman(env, true)).toContain(text);
  });
});

describe("emit", () => {
  test("json mode emits pretty JSON with one trailing newline", () => {
    let captured = "";
    const env = ok("latest", { id: 1 });
    emit(env, "json", (s) => (captured += s));
    expect(captured.endsWith("\n")).toBe(true);
    expect(captured.endsWith("\n\n")).toBe(false);
    const parsed = JSON.parse(captured);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.id).toBe(1);
    expect(captured).toContain("\n  "); // pretty-printed indentation
  });

  test("human mode emits renderHuman with one trailing newline", () => {
    let captured = "";
    const env = ok("code", { code: "999" });
    emit(env, "human", (s) => (captured += s));
    expect(captured).toContain("999");
    expect(captured.endsWith("\n")).toBe(true);
    expect(captured.endsWith("\n\n")).toBe(false);
  });

  test("human error mode prints code and message", () => {
    let captured = "";
    const env = err("code", { code: "NO_CODE", message: "none", suggestions: ["retry"] });
    emit(env, "human", (s) => (captured += s));
    expect(captured).toContain("NO_CODE");
    expect(captured).toContain("none");
    expect(captured).toContain("retry");
    expect(captured.endsWith("\n")).toBe(true);
  });
});
