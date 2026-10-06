const OUTPUT_LIMIT = 20_000;
const TRUNCATED = "[earlier output omitted]\n";

/** Keeps the newest child output while bounding diagnostics if a smoke child is noisy. */
export const appendCliSmokeOutput = (current: string, chunk: string): string => {
  const wasTruncated = current.startsWith(TRUNCATED);
  const combined = `${wasTruncated ? current.slice(TRUNCATED.length) : current}${chunk}`;
  const available = OUTPUT_LIMIT - (wasTruncated ? TRUNCATED.length : 0);
  if (combined.length <= available) return wasTruncated ? `${TRUNCATED}${combined}` : combined;
  return `${TRUNCATED}${combined.slice(-(OUTPUT_LIMIT - TRUNCATED.length))}`;
};
