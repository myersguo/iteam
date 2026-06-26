// POSIX-shell escape: wrap in single quotes and harden inner quotes.
export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
