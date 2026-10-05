export const ANDROID_PWA_PACKAGE = "com.devotek.t3code.pwa";

export function normalizePwaOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Use the PWA HTTPS origin, without a path, credentials, or pairing token.");
  }
  return `${url.origin}/`;
}

export function androidAssetLinks(packageName: string, fingerprint: string) {
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(packageName)) {
    throw new Error("Invalid Android package name.");
  }
  const normalized = fingerprint.replaceAll(":", "").trim().toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized))
    throw new Error("Invalid SHA-256 certificate fingerprint.");
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: packageName,
        sha256_cert_fingerprints: [normalized.match(/.{2}/g)!.join(":")],
      },
    },
  ];
}
