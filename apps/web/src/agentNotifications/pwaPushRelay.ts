import type { RelayWebPushPreferences } from "@t3tools/contracts/relay";

const INSTALLATION_ID_KEY = "t3code.pwaPushInstallationId";
const INSTALLATION_SECRET_KEY = "t3code.pwaPushInstallationSecret";
const RELAY_URL =
  (import.meta.env.VITE_T3CODE_RELAY_URL as string | undefined)?.trim() || "https://relay.t3.codes";

type Installation = {
  readonly installationId: string;
  readonly installationSecret: string;
};

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function randomInstallationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function pwaPushInstallation(): Installation {
  const storedId = window.localStorage.getItem(INSTALLATION_ID_KEY);
  const storedSecret = window.localStorage.getItem(INSTALLATION_SECRET_KEY);
  if (storedId && storedSecret) {
    return { installationId: storedId, installationSecret: storedSecret };
  }
  const installation = {
    installationId: randomInstallationId(),
    installationSecret: randomSecret(),
  };
  window.localStorage.setItem(INSTALLATION_ID_KEY, installation.installationId);
  window.localStorage.setItem(INSTALLATION_SECRET_KEY, installation.installationSecret);
  return installation;
}

function relayUrl(path: string): string {
  return new URL(path, RELAY_URL).toString();
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(relayUrl(path), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw new Error(`PWA push service returned ${response.status}.`);
  return response.json() as Promise<T>;
}

export async function getPwaPushConfig(): Promise<string> {
  const result = await json<{ applicationServerKey: string }>("/v1/pwa/web-push/config");
  return result.applicationServerKey;
}

export async function registerPwaPushSubscription(input: {
  readonly environmentId: string;
  readonly subscription: PushSubscription;
  readonly preferences: RelayWebPushPreferences;
}): Promise<string> {
  const serialized = input.subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!p256dh || !auth) throw new Error("This browser returned an invalid Web Push subscription.");
  const result = await json<{ subscriptionId: string }>("/v1/pwa/web-push/subscriptions", {
    method: "PUT",
    body: JSON.stringify({
      environmentId: input.environmentId,
      installation: pwaPushInstallation(),
      endpoint: input.subscription.endpoint,
      keys: { p256dh, auth },
      preferences: input.preferences,
    }),
  });
  return result.subscriptionId;
}

export async function removePwaPushSubscription(subscriptionId: string): Promise<void> {
  await json(`/v1/pwa/web-push/subscriptions/${encodeURIComponent(subscriptionId)}/remove`, {
    method: "POST",
    body: JSON.stringify({ installation: pwaPushInstallation() }),
  });
}

export async function testPwaPushSubscription(subscriptionId: string): Promise<void> {
  await json(`/v1/pwa/web-push/subscriptions/${encodeURIComponent(subscriptionId)}/test`, {
    method: "POST",
    body: JSON.stringify({ installation: pwaPushInstallation() }),
  });
}
