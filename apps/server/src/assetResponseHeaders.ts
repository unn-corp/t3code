export function buildAssetResponseHeaders(input: { readonly download?: boolean }) {
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(input.download ? { "Content-Disposition": "attachment" } : {}),
  };
}
