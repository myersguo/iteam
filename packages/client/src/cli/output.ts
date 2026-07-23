// Output helpers shared by every command. `--json` short-circuits to raw JSON
// (for scripting); otherwise we print a compact table or a formatted object.

export interface OutputOptions {
  json: boolean;
}

export function printResult(data: unknown, options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    return;
  }
  if (Array.isArray(data)) {
    if (data.length === 0) {
      console.log("(none)");
      return;
    }
    console.table(data);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

/** Render an array of rows as a table, or emit JSON when --json is set. */
export function printTable<T extends Record<string, unknown>>(rows: T[], options: OutputOptions): void {
  if (options.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  console.table(rows);
}

export function printMessage(message: string, options: OutputOptions, jsonPayload?: unknown): void {
  if (options.json) {
    process.stdout.write(JSON.stringify(jsonPayload ?? { message }, null, 2) + "\n");
    return;
  }
  console.log(message);
}
