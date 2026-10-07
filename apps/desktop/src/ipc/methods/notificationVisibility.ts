import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../../electron/ElectronPowerMonitor.ts";
import {
  isNotificationClientVisible,
  linuxDisplayAwake,
  watchWindowsDisplay,
} from "../../notifications/ClientVisibility.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

let readVisibility: () => Promise<boolean> = async () => false;
export const getNotificationVisibility = DesktopIpc.makeIpcMethod({
  channel: Channels.GET_NOTIFICATION_VISIBILITY_CHANNEL,
  payload: Schema.Void,
  result: Schema.Boolean,
  handler: () => Effect.promise(readVisibility),
});

export const installNotificationVisibility = Effect.fn("desktop.notifications.visibility.install")(
  function* () {
    const platform = yield* HostProcessPlatform;
    const app = yield* ElectronApp.ElectronApp;
    const power = yield* ElectronPowerMonitor.ElectronPowerMonitor;
    let locked = false,
      suspended = false,
      displayAwake: boolean | null = null,
      stopped = false;
    const cleanups = new Map<number, () => void>();
    const windows = new Map<number, Electron.BrowserWindow>();
    const pending = new Set<number>();
    const changed = () => {
      for (const window of Electron.BrowserWindow.getAllWindows())
        if (!window.isDestroyed())
          window.webContents.send(Channels.NOTIFICATION_VISIBILITY_CHANGED_CHANNEL);
    };
    for (const event of ["lock-screen", "unlock-screen", "suspend", "resume"] as const) {
      yield* power.onSimpleEvent(event, () => {
        if (event === "lock-screen") locked = true;
        if (event === "unlock-screen") locked = false;
        if (event === "suspend") suspended = true;
        if (event === "resume") suspended = false;
        changed();
      });
    }
    const attach = (_event: Electron.Event, window: Electron.BrowserWindow) => {
      if (!windows.has(window.id)) {
        windows.set(window.id, window);
        window.on("show", changed);
        window.on("hide", changed);
        window.on("minimize", changed);
        window.on("restore", changed);
        window.once("closed", () => windows.delete(window.id));
      }
      if (platform !== "win32" || cleanups.has(window.id) || pending.has(window.id)) return;
      pending.add(window.id);
      void watchWindowsDisplay(window, (awake) => {
        displayAwake = awake;
        changed();
      })
        .then((close) => {
          if (stopped || window.isDestroyed()) close();
          else {
            cleanups.set(window.id, close);
            window.once("closed", () => {
              close();
              cleanups.delete(window.id);
            });
          }
        })
        .catch(() => {
          /* Missing native observation stays conservative/unknown. */
        })
        .finally(() => pending.delete(window.id));
    };
    yield* app.on("browser-window-created", attach);
    for (const window of Electron.BrowserWindow.getAllWindows())
      attach({} as Electron.Event, window);
    readVisibility = async () => {
      const polledLocked = Electron.powerMonitor.getSystemIdleState(60) === "locked";
      const awake = platform === "linux" ? await linuxDisplayAwake() : displayAwake;
      return isNotificationClientVisible({
        windows: Electron.BrowserWindow.getAllWindows().map((window) => ({
          destroyed: window.isDestroyed(),
          visible: !window.isDestroyed() && window.isVisible(),
          minimized: !window.isDestroyed() && window.isMinimized(),
        })),
        locked: locked || polledLocked,
        suspended,
        displayAwake: awake,
      });
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopped = true;
        for (const window of windows.values()) {
          window.removeListener("show", changed);
          window.removeListener("hide", changed);
          window.removeListener("minimize", changed);
          window.removeListener("restore", changed);
        }
        windows.clear();
        for (const close of cleanups.values()) close();
        cleanups.clear();
        readVisibility = async () => false;
      }),
    );
  },
);
