/** CLI submissions have no idempotency guarantee. Accept only an identifiable official task URL. */
export function cloudSubmissionReference(output: string): { taskId: string; url: string } | null {
  for (const match of output.matchAll(
    /https:\/\/chatgpt\.com\/codex\/tasks\/([a-zA-Z0-9_-]+)(?=\s|$|[?#])/g,
  )) {
    return { taskId: match[1]!, url: `https://chatgpt.com/codex/tasks/${match[1]}` };
  }
  return null;
}

export function validateControllerOrigin(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
