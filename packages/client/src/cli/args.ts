// Minimal, dependency-free argv parsing for the CLI. Splits positionals from
// `--flag value` / `--flag=value` / boolean `--flag` forms. Global flags
// (--server, --space, --token, --json, --yes) are extracted once by the
// dispatcher; command modules read the rest from the returned Args.

export interface Args {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

export function flagString(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(args: Args, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === "true";
}
