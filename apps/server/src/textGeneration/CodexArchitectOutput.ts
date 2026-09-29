const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const omitNulls = (value: Record<string, unknown>, keys: readonly string[]): void => {
  for (const key of keys) if (value[key] === null) delete value[key];
};

/** Codex requires optional JSON Schema fields to be present and fills unused ones with null. */
export const normalizeCodexArchitectOutputJson = (raw: string): string => {
  let output: unknown;
  try {
    output = JSON.parse(raw);
  } catch {
    return raw; // The normal structured-output decoder reports malformed JSON.
  }
  if (!isRecord(output) || !Array.isArray(output.proposals)) return raw;

  for (const proposal of output.proposals) {
    if (!isRecord(proposal) || !isRecord(proposal.change)) continue;
    const change = proposal.change;
    if (change.type === "update-role") {
      omitNulls(change, ["title", "mandate", "poolSize"]);
    }
  }
  return JSON.stringify(output);
};
