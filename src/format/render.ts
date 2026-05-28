import type { Envelope } from "../contracts/envelope";

export type Mode = "json" | "human";

const DEFAULT_MAX = 280;

/**
 * Resolve output mode. Explicit flags win: --json forces json, --human forces
 * human (--json beats --human if both set). With no flag, TTY => human,
 * non-TTY (pipe/agent) => json.
 */
export function resolveMode(flags: { json?: boolean; human?: boolean }, isTTY: boolean): Mode {
  if (flags.json) return "json";
  if (flags.human) return "human";
  return isTTY ? "human" : "json";
}

/**
 * Truncate a string to `max` chars, appending a dense hint about the dropped
 * tail. Null becomes "". Strings within `max` pass through unchanged.
 */
export function truncate(s: string | null, max: number = DEFAULT_MAX): string {
  if (s === null) return "";
  if (s.length <= max) return s;
  const dropped = s.length - max;
  return `${s.slice(0, max)}…(+${dropped} chars, --full)`;
}

/**
 * Email body fields are the only unbounded strings; truncate just those (unless
 * `--full`). Everything else — subjects, codes, urls, help, suggestions — is
 * bounded and renders in full so dense output stays complete.
 */
const BODY_KEYS = new Set(["text", "html", "body"]);

/**
 * Render an Envelope as dense, token-efficient human lines. Error envelopes
 * print the stable code, the message, and any suggestions. Ok envelopes print
 * their data: scalars directly, arrays one line per item, objects as key lines.
 * When `full` is false (default), email body fields are truncated.
 */
export function renderHuman(env: Envelope, full = false): string {
  if (!env.ok || env.error) {
    return renderError(env);
  }
  return renderData(env.data, full);
}

function renderError(env: Envelope): string {
  const e = env.error;
  if (!e) return `error: ${env.meta.command}`;
  const lines: string[] = [`${e.code}: ${e.message}`];
  for (const s of e.suggestions) {
    lines.push(`  - ${s}`);
  }
  return lines.join("\n");
}

function renderData(data: unknown, full: boolean): string {
  if (data === null || data === undefined) return "(none)";
  if (Array.isArray(data)) {
    if (data.length === 0) return "(empty)";
    return data.map((item) => renderItem(item, full)).join("\n");
  }
  if (typeof data === "object") {
    return renderObject(data as Record<string, unknown>, full);
  }
  return formatScalar(data);
}

/** One compact line for an array item: pipe-joined key=value pairs. */
function renderItem(item: unknown, full: boolean): string {
  if (item === null || item === undefined) return "(none)";
  if (typeof item !== "object") return formatScalar(item);
  const obj = item as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(obj)) {
    parts.push(`${key}=${formatField(key, obj[key], full)}`);
  }
  return parts.join(" | ");
}

/** Multi-line key block for a single object: one `key: value` per line. */
function renderObject(obj: Record<string, unknown>, full: boolean): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return "(empty)";
  return keys.map((key) => `${key}: ${formatField(key, obj[key], full)}`).join("\n");
}

/** Format a value for a named field, truncating only email body fields. */
function formatField(key: string, v: unknown, full: boolean): string {
  if (typeof v === "string" && BODY_KEYS.has(key) && !full) return truncate(v);
  return formatValue(v);
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (Array.isArray(v)) {
    if (v.length === 0) return "-";
    return v.map((x) => formatScalar(x)).join(", ");
  }
  if (typeof v === "object") return JSON.stringify(v);
  return formatScalar(v);
}

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "-";
  return String(v);
}

/**
 * Write the rendered envelope through `out` (default stdout) with exactly one
 * trailing newline. json mode pretty-prints; human mode uses renderHuman.
 */
export function emit(
  env: Envelope,
  mode: Mode,
  out: (s: string) => void = defaultOut,
  full = false,
): void {
  const body = mode === "json" ? JSON.stringify(env, null, 2) : renderHuman(env, full);
  out(`${body}\n`);
}

function defaultOut(s: string): void {
  process.stdout.write(s);
}
