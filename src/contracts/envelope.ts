import type { StructuredError } from "./errors";

/**
 * Stable JSON output envelope. Every command, in --json mode, emits exactly
 * this shape so agents can parse one schema for all commands.
 */
export interface Envelope<T = unknown> {
  ok: boolean;
  data: T | null;
  error: StructuredError | null;
  meta: EnvelopeMeta;
}

export interface EnvelopeMeta {
  command: string;
  /** Wall-clock duration in ms, when measured. */
  ms?: number;
}

export function ok<T>(command: string, data: T, meta: Partial<EnvelopeMeta> = {}): Envelope<T> {
  return { ok: true, data, error: null, meta: { command, ...meta } };
}

export function err(
  command: string,
  error: StructuredError,
  meta: Partial<EnvelopeMeta> = {},
): Envelope<never> {
  return { ok: false, data: null, error, meta: { command, ...meta } };
}
