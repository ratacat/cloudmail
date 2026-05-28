import { ExitCode } from "./exit";

/**
 * Stable error-code catalog. Each code maps to an exit code and carries
 * agent-actionable suggestions. New codes append here only.
 */
export const ErrorCode = {
  NOT_FOUND: "NOT_FOUND",
  NO_CODE: "NO_CODE",
  BAD_ARGS: "BAD_ARGS",
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  AUTH: "AUTH",
  CONFIG_MISSING: "CONFIG_MISSING",
  PROFILE_MISSING: "PROFILE_MISSING",
  CF_API: "CF_API",
  NETWORK: "NETWORK",
  TIMEOUT: "TIMEOUT",
  INTERNAL: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const EXIT_BY_CODE: Record<ErrorCode, ExitCode> = {
  NOT_FOUND: ExitCode.NOT_FOUND,
  NO_CODE: ExitCode.NOT_FOUND,
  BAD_ARGS: ExitCode.BAD_ARGS,
  UNKNOWN_COMMAND: ExitCode.BAD_ARGS,
  AUTH: ExitCode.AUTH,
  CONFIG_MISSING: ExitCode.CONFIG,
  PROFILE_MISSING: ExitCode.CONFIG,
  CF_API: ExitCode.CF_API,
  NETWORK: ExitCode.NETWORK,
  TIMEOUT: ExitCode.TIMEOUT,
  INTERNAL: ExitCode.CF_API,
};

export interface StructuredError {
  code: ErrorCode;
  message: string;
  suggestions: string[];
}

/**
 * The single error type thrown across the CLI. Carries a stable code,
 * a human message, and concrete next-step suggestions for an agent.
 */
export class CloudmailError extends Error {
  readonly code: ErrorCode;
  readonly suggestions: string[];

  constructor(code: ErrorCode, message: string, suggestions: string[] = []) {
    super(message);
    this.name = "CloudmailError";
    this.code = code;
    this.suggestions = suggestions;
  }

  get exitCode(): ExitCode {
    return EXIT_BY_CODE[this.code];
  }

  toStructured(): StructuredError {
    return { code: this.code, message: this.message, suggestions: this.suggestions };
  }
}

export function exitCodeFor(code: ErrorCode): ExitCode {
  return EXIT_BY_CODE[code];
}
