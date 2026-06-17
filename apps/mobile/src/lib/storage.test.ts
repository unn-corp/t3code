import { assert } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  EnvironmentId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { beforeEach, describe, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => {
  const values = new Map<string, string>();
  const files = new Map<string, { text: string; deleted: boolean }>();
  return {
    clear: () => values.clear(),
    clearFiles: () => files.clear(),
    files,
    getItemAsync: vi.fn((key: string) => Promise.resolve(values.get(key) ?? null)),
    setItemAsync: vi.fn((key: string, value: string) => {
      values.set(key, value);
      return Promise.resolve();
    }),
  };
});

vi.mock("expo-file-system", () => ({
  Directory: class {
    readonly uri: string;

    constructor(parent: string, name: string) {
      this.uri = `${parent}/${name}`;
    }

    create(): void {
      // Directory creation is idempotent for these storage tests.
    }
  },
  File: class {
    readonly uri: string;

    constructor(directory: { readonly uri: string }, name: string) {
      this.uri = `${directory.uri}/${name}`;
    }

    get exists(): boolean {
      return mocks.files.has(this.uri) && mocks.files.get(this.uri)?.deleted === false;
    }

    create(): void {
      mocks.files.set(this.uri, { text: "", deleted: false });
    }

    delete(): void {
      const entry = mocks.files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }

    text(): string {
      const entry = mocks.files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.text;
    }

    write(text: string): void {
      mocks.files.set(this.uri, { text, deleted: false });
    }
  },
  Paths: {
    document: "document",
  },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: mocks.getItemAsync,
  setItemAsync: mocks.setItemAsync,
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

vi.mock("./runtime", () => ({
  mobileRuntime: {
    runPromise: vi.fn(),
  },
}));

import {
  loadCachedShellSnapshot,
  loadSavedConnections,
  saveCachedShellSnapshot,
  saveConnection,
  type CachedShellSnapshot,
} from "./storage";
import { toStableSavedRemoteConnection } from "./connection";

const decodeUnknownJsonString = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const managedConnection = {
  environmentId: EnvironmentId.make("environment-1"),
  environmentLabel: "Desktop",
  pairingUrl: "https://desktop.example/",
  displayUrl: "https://desktop.example/",
  httpBaseUrl: "https://desktop.example/",
  wsBaseUrl: "wss://desktop.example/",
  bearerToken: null,
  authenticationMethod: "dpop",
  dpopAccessToken: "short-lived-token",
  relayManaged: true,
} as const;

const cacheEnvironmentId = EnvironmentId.make("cache-environment-1");
const otherCacheEnvironmentId = EnvironmentId.make("cache-environment-2");

const cachedSnapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const cacheFileUri = (environmentId: EnvironmentId) =>
  `document/shell-snapshots/${encodeURIComponent(environmentId)}.json`;

const writeCachedSnapshotFile = (environmentId: EnvironmentId, document: unknown) => {
  mocks.files.set(cacheFileUri(environmentId), {
    text: typeof document === "string" ? document : encodeUnknownJsonString(document),
    deleted: false,
  });
};

describe("mobile connection storage", () => {
  beforeEach(() => {
    mocks.clear();
    mocks.clearFiles();
    vi.clearAllMocks();
  });

  it("persists relay-managed connections without their ephemeral access token", async () => {
    await saveConnection(managedConnection);

    const savedValue = mocks.setItemAsync.mock.calls[0]?.[1];
    assert.notEqual(savedValue, undefined);
    assert.deepStrictEqual(decodeUnknownJsonString(savedValue ?? ""), {
      connections: [toStableSavedRemoteConnection(managedConnection)],
    });
  });

  it("loads relay-managed connection metadata without a cached access token", async () => {
    await saveConnection(managedConnection);

    assert.deepStrictEqual(await loadSavedConnections(), [
      toStableSavedRemoteConnection(managedConnection),
    ]);
  });

  it("loads cached shell snapshots through the schema JSON codec", async () => {
    await saveCachedShellSnapshot(cacheEnvironmentId, cachedSnapshot);

    const loaded = await loadCachedShellSnapshot(cacheEnvironmentId);

    assert.deepStrictEqual(loaded?.snapshot, cachedSnapshot);
    assert.equal(loaded?.environmentId, cacheEnvironmentId);
  });

  it("ignores malformed cached shell snapshot JSON", async () => {
    writeCachedSnapshotFile(cacheEnvironmentId, "{");

    assert.equal(await loadCachedShellSnapshot(cacheEnvironmentId), null);
  });

  it("ignores cached shell snapshots with an unsupported schema version", async () => {
    writeCachedSnapshotFile(cacheEnvironmentId, {
      schemaVersion: 2,
      environmentId: cacheEnvironmentId,
      snapshotReceivedAt: "2026-01-01T00:00:00.000Z",
      snapshot: cachedSnapshot,
    });

    assert.equal(await loadCachedShellSnapshot(cacheEnvironmentId), null);
  });

  it("ignores cached shell snapshots written for a different environment", async () => {
    const document: CachedShellSnapshot = {
      schemaVersion: 1,
      environmentId: otherCacheEnvironmentId,
      snapshotReceivedAt: "2026-01-01T00:00:00.000Z",
      snapshot: cachedSnapshot,
    };
    writeCachedSnapshotFile(cacheEnvironmentId, document);

    assert.equal(await loadCachedShellSnapshot(cacheEnvironmentId), null);
  });
});
