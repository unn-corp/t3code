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

/** Startup prints pairing credentials, including a QR code; public CI only needs startup diagnostics. */
export const redactCliSmokeOutput = (output: string): string =>
  output
    .split(/\r?\n/)
    .filter((line) => !/[\u2580-\u259f]/u.test(line))
    .map((line) =>
      /(?:Token|Pairing URL|Connection string):/i.test(line)
        ? "[pairing details redacted]"
        : /\b(?:authorization|cookie|set-cookie|password|secret|access[_-]?token|api[_-]?key)\s*[:=]/i.test(
              line,
            )
          ? "[credentials redacted]"
          : line
              .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
              .replace(/https?:\/\/\S+/g, "[URL redacted]"),
    )
    .join("\n");
