import { CloudmailError, ErrorCode } from "../contracts/errors";

export interface ParsedArgs {
  command: string | null; // null => no command (help)
  positionals: string[];
  flags: Record<string, string | boolean>; // --to x, --json, -n 5
  json: boolean;
  human: boolean;
  full: boolean;
  quiet: boolean;
  profile?: string;
}

/** Flags that never take a value — their presence means `true`. */
const BOOLEAN_FLAGS = new Set(["json", "human", "full", "quiet", "help"]);

/** Short-flag aliases mapped to their long names. */
const SHORT_ALIASES: Record<string, string> = {
  n: "limit",
  p: "profile",
  h: "help",
};

/**
 * Parse a CLI argv (without the node/script entries) into a structured shape.
 *
 * - First non-flag token becomes `command`; remaining non-flag tokens are
 *   `positionals` (in order).
 * - Boolean flags (`--json --human --full --quiet --help`) set `true`.
 * - Value flags accept either `--flag value` or `--flag=value`.
 * - Short flags: `-n` => limit, `-p` => profile, `-h` => help; `-n=5` also works.
 * - A leading `--help`/`-h` (before any command) resolves `command` to "help".
 *
 * Throws `CloudmailError(BAD_ARGS, …)` when a value-expecting flag has no value
 * (end of argv, or immediately followed by another flag).
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  let command: string | null = null;
  let leadingHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;

    const isLong = token.startsWith("--");
    const isShort = !isLong && token.startsWith("-") && token.length > 1;

    if (isLong || isShort) {
      const { name, value } = splitFlag(token, isLong);

      if (BOOLEAN_FLAGS.has(name)) {
        if (value !== undefined) {
          throw new CloudmailError(
            ErrorCode.BAD_ARGS,
            `Flag "--${name}" does not take a value.`,
            [`Use --${name} on its own.`],
          );
        }
        flags[name] = true;
        if (command === null && name === "help" && positionals.length === 0) {
          leadingHelp = true;
        }
        continue;
      }

      // Value-expecting flag.
      if (value !== undefined) {
        flags[name] = value;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || isFlagLike(next)) {
        throw new CloudmailError(
          ErrorCode.BAD_ARGS,
          `Flag "${isLong ? "--" : "-"}${rawNameFor(token, isLong)}" expects a value.`,
          ["Provide a value for the flag, or use the --flag=value form."],
        );
      }
      flags[name] = next;
      i++;
      continue;
    }

    // Positional token.
    if (command === null) {
      command = token;
    } else {
      positionals.push(token);
    }
  }

  if (leadingHelp) {
    command = "help";
  }

  return {
    command,
    positionals,
    flags,
    json: flags["json"] === true,
    human: flags["human"] === true,
    full: flags["full"] === true,
    quiet: flags["quiet"] === true,
    ...(typeof flags["profile"] === "string" ? { profile: flags["profile"] } : {}),
  };
}

/**
 * Split a flag token into its canonical long name and inline value (if any).
 * Resolves short aliases to long names and rejects unknown short flags.
 */
function splitFlag(
  token: string,
  isLong: boolean,
): { name: string; value: string | undefined } {
  const body = isLong ? token.slice(2) : token.slice(1);
  const eq = body.indexOf("=");
  const rawName = eq === -1 ? body : body.slice(0, eq);
  const value = eq === -1 ? undefined : body.slice(eq + 1);

  if (rawName.length === 0) {
    throw new CloudmailError(ErrorCode.BAD_ARGS, `Malformed flag: "${token}"`, [
      "Use --name, --name=value, or --name value.",
    ]);
  }

  if (isLong) {
    return { name: rawName, value };
  }

  const longName = SHORT_ALIASES[rawName];
  if (longName === undefined) {
    throw new CloudmailError(ErrorCode.BAD_ARGS, `Unknown flag: "-${rawName}"`, [
      "Use -n (limit), -p (profile), or -h (help).",
    ]);
  }
  return { name: longName, value };
}

/** The user-facing name (pre-alias) for error messages. */
function rawNameFor(token: string, isLong: boolean): string {
  const body = isLong ? token.slice(2) : token.slice(1);
  const eq = body.indexOf("=");
  return eq === -1 ? body : body.slice(0, eq);
}

/** True when a token would be interpreted as a flag (so cannot be a value). */
function isFlagLike(token: string): boolean {
  if (token.startsWith("--")) return true;
  // A lone "-" or negative number is treated as a value, not a flag.
  return token.startsWith("-") && token.length > 1 && !/^-\d/.test(token);
}
