import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
  BrowserWindow: vi.fn(),
}));

import { GitHubAccountId } from "@t3tools/contracts";

import * as BrowserSession from "../preview/BrowserSession.ts";
import * as ElectronWindow from "./ElectronWindow.ts";
import {
  GitHubAccountBrowser,
  layer as githubAccountBrowserLayer,
  parseGitHubAccountWebUrl,
} from "./GitHubAccountBrowser.ts";

describe("parseGitHubAccountWebUrl", () => {
  it("accepts ordinary HTTP(S) URLs", () => {
    expect(parseGitHubAccountWebUrl("https://github.com/acme/repository/pull/7")).toBe(
      "https://github.com/acme/repository/pull/7",
    );
    expect(parseGitHubAccountWebUrl("http://github.enterprise.test/acme/repository")).toBe(
      "http://github.enterprise.test/acme/repository",
    );
  });

  it("rejects custom schemes and URLs carrying credentials", () => {
    expect(parseGitHubAccountWebUrl("javascript:alert(1)")).toBeNull();
    expect(parseGitHubAccountWebUrl("file:///etc/passwd")).toBeNull();
    expect(parseGitHubAccountWebUrl("https://user:secret@github.com/acme/repository")).toBeNull();
  });

  it("keeps one browser window and cookie session per account", async () => {
    const getSession = vi.fn((scope: string) => Effect.succeed({ scope } as never));
    const createdWindows: Array<{ loadURL: ReturnType<typeof vi.fn> }> = [];
    const create = vi.fn((options: unknown) => {
      const browserWindow = {
        isDestroyed: vi.fn(() => false),
        loadURL: vi.fn(() => Promise.resolve()),
        show: vi.fn(),
        focus: vi.fn(),
        on: vi.fn(),
        webContents: {
          on: vi.fn(),
          setWindowOpenHandler: vi.fn(),
        },
      };
      createdWindows.push(browserWindow);
      return Effect.succeed(browserWindow as never);
    });
    const browserSession = BrowserSession.BrowserSession.of({ getSession } as never);
    const electronWindow = ElectronWindow.ElectronWindow.of({ create } as never);
    const layer = githubAccountBrowserLayer.pipe(
      Layer.provide(Layer.succeed(BrowserSession.BrowserSession, browserSession)),
      Layer.provide(Layer.succeed(ElectronWindow.ElectronWindow, electronWindow)),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const browser = yield* GitHubAccountBrowser;
        expect(
          yield* browser.open({
            url: "https://github.com/acme/repository/pull/1",
            githubAccountId: GitHubAccountId.make("work"),
          }),
        ).toBe(true);
        expect(
          yield* browser.open({
            url: "https://github.com/acme/repository/pull/2",
            githubAccountId: GitHubAccountId.make("personal"),
          }),
        ).toBe(true);
        expect(
          yield* browser.open({
            url: "https://github.com/acme/repository/pull/3",
            githubAccountId: GitHubAccountId.make("work"),
          }),
        ).toBe(true);
      }).pipe(Effect.provide(layer)),
    );

    expect(getSession.mock.calls.map(([scope]) => scope)).toEqual([
      "github-account:work",
      "github-account:personal",
    ]);
    expect(create).toHaveBeenCalledTimes(2);
    expect(createdWindows[0]?.loadURL).toHaveBeenLastCalledWith(
      "https://github.com/acme/repository/pull/3",
    );
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  });
});
