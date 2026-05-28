import { test, expect, describe } from "bun:test";
import { extractVerification } from "../src/core/extract";

describe("extractVerification", () => {
  test("plain 6-digit code", () => {
    const r = extractVerification("Your code is 123456 — enter it now.");
    expect(r.code).toBe("123456");
    expect(r.codes).toEqual(["123456"]);
    expect(r.links).toEqual([]);
  });

  test("space-grouped code '123 456'", () => {
    const r = extractVerification("Verification code: 123 456");
    expect(r.codes).toContain("123456");
    expect(r.code).toBe("123456");
  });

  test("hyphenated code '123-456'", () => {
    const r = extractVerification("Use 123-456 to sign in.");
    expect(r.codes).toContain("123456");
    expect(r.code).toBe("123456");
  });

  test("labeled alphanumeric 'code: ABC123'", () => {
    const r = extractVerification("Your code: ABC123");
    expect(r.codes).toContain("ABC123");
    expect(r.code).toBe("ABC123");
  });

  test("labeled OTP/PIN variants are uppercased", () => {
    expect(extractVerification("OTP: ab12cd").codes).toContain("AB12CD");
    expect(extractVerification("PIN - 4821").codes).toContain("4821");
    expect(extractVerification("password: pa55wd").codes).toContain("PA55WD");
  });

  test("label must be adjacent (only non-alnum separators)", () => {
    // "is" sits between the label and the token, so it is not a labeled match.
    expect(extractVerification("OTP is xy99zz").codes).toEqual([]);
  });

  test("magic link with token is captured", () => {
    const body = "Click https://app.example.com/magic?token=xyz789 to log in.";
    const r = extractVerification(body);
    expect(r.links).toEqual(["https://app.example.com/magic?token=xyz789"]);
  });

  test("verification-keyword links captured, plain links ignored", () => {
    const body = [
      "Confirm: https://example.com/confirm/abc",
      "Home: https://example.com/dashboard",
      "Reset: https://example.com/reset?t=1",
    ].join("\n");
    const r = extractVerification(body);
    expect(r.links).toContain("https://example.com/confirm/abc");
    expect(r.links).toContain("https://example.com/reset?t=1");
    expect(r.links).not.toContain("https://example.com/dashboard");
  });

  test("marketing email with phone numbers does not yield a 10-digit phone as code", () => {
    const body =
      "Big sale! Call us at 1-800-555-0199 or 555-123-4567. Visit https://shop.example.com/deals";
    const r = extractVerification(body);
    // No marketing/store link (no verif keyword), and no full phone as code.
    expect(r.links).toEqual([]);
    expect(r.codes).not.toContain("18005550199");
    expect(r.codes).not.toContain("5551234567");
    expect(r.code).not.toBe("18005550199");
    // And no phone *fragment* leaks as a 4–8 digit code either.
    expect(r.codes).not.toContain("1800555");
    expect(r.codes).not.toContain("5550199");
    expect(r.codes).not.toContain("1234567");
    expect(r.code).toBeNull();
  });

  test("parenthesized phone is not a code", () => {
    const r = extractVerification("Call (800) 555-0199 for help.");
    expect(r.code).toBeNull();
    expect(r.codes).toEqual([]);
  });

  test("clean code adjacent to prose still extracted", () => {
    const r = extractVerification("Enter 482913 now");
    expect(r.code).toBe("482913");
  });

  test("empty body returns nulls/empties", () => {
    const r = extractVerification("");
    expect(r.code).toBeNull();
    expect(r.codes).toEqual([]);
    expect(r.links).toEqual([]);
  });

  test("no codes or links present returns nulls/empties", () => {
    const r = extractVerification("Hello there, just saying hi.");
    expect(r.code).toBeNull();
    expect(r.codes).toEqual([]);
    expect(r.links).toEqual([]);
  });

  test("deterministic insertion order for multiple codes", () => {
    const body = "First 111111 then 222222 and code: ABC123";
    const r = extractVerification(body);
    expect(r.codes).toEqual(["111111", "222222", "ABC123"]);
    expect(r.code).toBe("111111");
  });

  test("dedupes repeated codes preserving first position", () => {
    const r = extractVerification("123456 ... again 123456");
    expect(r.codes).toEqual(["123456"]);
  });

  test("digit code stays 4-8 digits long", () => {
    expect(extractVerification("pin 123").codes).toEqual([]); // too short
    expect(extractVerification("ref 123456789").codes).toEqual([]); // 9 digits too long
    expect(extractVerification("code 1234").codes).toContain("1234");
    expect(extractVerification("code 12345678").codes).toContain("12345678");
  });
});
