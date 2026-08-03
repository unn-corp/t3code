import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  pwaPushInstallation,
  removePwaPushSubscription,
  testPwaPushSubscription,
} from "./pwaPushRelay";

describe("anonymous PWA push installation", () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
        return bytes;
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("creates one stable credential without a user account", () => {
    const first = pwaPushInstallation();
    const second = pwaPushInstallation();
    expect(second).toEqual(first);
    expect(first.installationSecret).not.toBe("");
    expect(first.installationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("authorizes removal and test requests with the installation credential", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    await removePwaPushSubscription("subscription-1");
    await testPwaPushSubscription("subscription-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [_url, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body).installation.installationId).toBe(
        pwaPushInstallation().installationId,
      );
    }
  });
});
