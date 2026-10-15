/** Hash the configuration text used to detect stale setup. */
export function fingerprintOf(text: string): string {
  return Bun.SHA256.hash(text, "hex");
}
