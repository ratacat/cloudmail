/**
 * Process exit codes. Stable contract — agents branch on these.
 * Mirrors GNU conventions where sensible (124 = timeout).
 */
export const ExitCode = {
  OK: 0,
  NOT_FOUND: 1,
  BAD_ARGS: 2,
  AUTH: 3,
  CONFIG: 4,
  CF_API: 5,
  NETWORK: 6,
  TIMEOUT: 124,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
