import type { GitHubAccountId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import * as BrowserSession from "../preview/BrowserSession.ts";
import * as ElectronWindow from "./ElectronWindow.ts";

const ACCOUNT_SESSION_SCOPE_PREFIX = "github-account:";

/** Account-scoped GitHub windows never accept custom schemes or credentials in a URL. */
export function parseGitHubAccountWebUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Opens GitHub links in one persistent Chromium session per configured account.
 *
 * The session stores the user's normal GitHub cookies, not a PAT. PATs remain
 * server-side for API/agent operations; web login is completed once per
 * account window by the user. This is the only safe way to switch the account
 * used by a GitHub web page without putting a token in a URL or browser header.
 */
export class GitHubAccountBrowser extends Context.Service<
  GitHubAccountBrowser,
  {
    readonly open: (input: {
      readonly url: string;
      readonly githubAccountId: GitHubAccountId;
    }) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/electron/GitHubAccountBrowser") {}

export const make = Effect.gen(function* GitHubAccountBrowserMake() {
  const browserSessions = yield* BrowserSession.BrowserSession;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const windows = new Map<string, Electron.BrowserWindow>();

  const open = Effect.fn("GitHubAccountBrowser.open")(function* (input: {
    readonly url: string;
    readonly githubAccountId: GitHubAccountId;
  }) {
    const url = parseGitHubAccountWebUrl(input.url);
    if (url === null) return false;

    const existing = windows.get(input.githubAccountId);
    if (existing !== undefined && !existing.isDestroyed()) {
      void existing.loadURL(url).catch(() => undefined);
      existing.show();
      existing.focus();
      return true;
    }
    if (existing !== undefined) windows.delete(input.githubAccountId);

    const accountSession = yield* browserSessions
      .getSession(`${ACCOUNT_SESSION_SCOPE_PREFIX}${input.githubAccountId}`)
      .pipe(Effect.orElseSucceed(() => null));
    if (accountSession === null) return false;

    const window = yield* electronWindow
      .create({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
        show: false,
        autoHideMenuBar: true,
        title: `GitHub · ${input.githubAccountId}`,
        webPreferences: {
          session: accountSession,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (window === null) return false;

    windows.set(input.githubAccountId, window);
    window.on("closed", () => {
      if (windows.get(input.githubAccountId) === window) {
        windows.delete(input.githubAccountId);
      }
    });
    window.webContents.setWindowOpenHandler(({ url: popupUrl }) =>
      parseGitHubAccountWebUrl(popupUrl) === null ? { action: "deny" } : { action: "allow" },
    );
    window.webContents.on("will-navigate", (event, navigationUrl) => {
      if (parseGitHubAccountWebUrl(navigationUrl) === null) event.preventDefault();
    });
    void window.loadURL(url).catch(() => undefined);
    window.show();
    window.focus();
    return true;
  });

  return GitHubAccountBrowser.of({ open });
});

export const layer = Layer.effect(GitHubAccountBrowser, make);
