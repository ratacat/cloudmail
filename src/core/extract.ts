import type { VerificationResult } from "../contracts/types";

/**
 * Pure heuristic extraction of verification codes and links from an email body.
 *
 * Ported from the deployed worker's `extractVerification` and kept deterministic
 * and insertion-ordered so the worker read API and the CLI agree exactly.
 *
 * - Codes: 4–8 digit groups (space/hyphen grouping stripped) plus labeled
 *   OTP/PIN/code/password alphanumeric tokens of length 4–8 (uppercased).
 * - Links: http(s) URLs whose text matches a verification-intent keyword.
 * - `code` is the first code found (insertion order), or null.
 */
export function extractVerification(
  body: string,
): Pick<VerificationResult, "code" | "codes" | "links"> {
  const text = body || "";

  // Bare numeric codes, phone-aware. We scan maximal "number tokens" — runs of
  // digits plus common number separators — and only treat a token as a code when
  // it has 4–8 total digits and is NOT phone-shaped. A phone like
  // "1-800-555-0199" is one 11-digit token (dropped for length), so no 7-digit
  // fragment can leak out of it; parenthesized/`+`-prefixed numbers are dropped
  // as phone formatting regardless of length.
  const codeMatches = new Set<string>();
  const numTokenRe = /\d[\d\s().+-]*\d|\d/g;
  let m: RegExpExecArray | null;
  while ((m = numTokenRe.exec(text)) !== null) {
    const token = m[0];
    const digits = token.replace(/\D/g, "");
    if (digits.length < 4 || digits.length > 8) continue; // too short, or phone/long
    if (/[()+]/.test(token)) continue; // phone formatting, e.g. "(800) 555-0199"
    codeMatches.add(digits);
  }

  // Alphanumeric OTP-style codes near a label word.
  const labeledRe = /(?:code|otp|pin|password)[^\dA-Za-z]{0,12}([A-Z0-9]{4,8})\b/gi;
  while ((m = labeledRe.exec(text)) !== null) {
    const group = m[1];
    if (group === undefined) continue;
    codeMatches.add(group.toUpperCase());
  }

  // Verification / confirmation / magic links.
  const links = new Set<string>();
  const urlRe = /https?:\/\/[^\s<>"')]+/gi;
  while ((m = urlRe.exec(text)) !== null) {
    const url = m[0];
    if (/verif|confirm|activat|magic|token|login|signin|reset/i.test(url)) {
      links.add(url);
    }
  }

  const codes = [...codeMatches];
  return { code: codes[0] ?? null, codes, links: [...links] };
}
