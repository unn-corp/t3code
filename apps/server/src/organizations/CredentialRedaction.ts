const BEARER_CREDENTIAL = /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi;
const NAMED_CREDENTIAL =
  /(\b[A-Za-z0-9_-]*?(?:api[_-]?key|token|secret|password|private[_-]?key|access[_-]?key)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const STANDALONE_CREDENTIAL =
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16})\b/g;

/** Pattern-based protection; arbitrary unmarked secrets require user review. */
export const redactKnownCredentials = (text: string): string =>
  text
    .replace(BEARER_CREDENTIAL, "$1[REDACTED]")
    .replace(NAMED_CREDENTIAL, "$1[REDACTED]")
    .replace(STANDALONE_CREDENTIAL, "[REDACTED]");
