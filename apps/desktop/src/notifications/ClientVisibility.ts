// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - native display adapters use bounded OS/D-Bus calls.
import * as Electron from "electron";
import { Message, sessionBus } from "dbus-next";
import * as NodeChildProcess from "node:child_process";

/** Native window visibility, independent of input inactivity or focus. */
export function isNotificationClientVisible(input: {
  windows: ReadonlyArray<{ destroyed: boolean; visible: boolean; minimized: boolean }>;
  locked: boolean;
  suspended: boolean;
  displayAwake: boolean | null;
}): boolean {
  return (
    !input.locked &&
    !input.suspended &&
    input.displayAwake !== false &&
    input.windows.some((window) => !window.destroyed && window.visible && !window.minimized)
  );
}

export const SESSION_DISPLAY_GUID = Buffer.from("0ec2842b23addf4d93db05ffbd7efca5", "hex");
let windowsApi: Promise<typeof import("ffi-rs")> | undefined;
function loadWindowsApi() {
  windowsApi ??= import("ffi-rs").then((api) => {
    api.open({ library: "arcwright-presence-user32", path: "user32.dll" });
    api.open({ library: "arcwright-presence-kernel32", path: "kernel32.dll" });
    return api;
  });
  return windowsApi;
}
export function decodeDisplayPowerSetting(setting: Buffer): boolean | null {
  if (
    setting.length < 24 ||
    !setting.subarray(0, 16).equals(SESSION_DISPLAY_GUID) ||
    setting.readUInt32LE(16) !== 4
  )
    return null;
  const value = setting.readUInt32LE(20);
  return value === 0 ? false : value === 1 || value === 2 ? true : null;
}

/** Windows reports display-only sleep separately from system suspend/lock. */
export async function watchWindowsDisplay(
  window: Electron.BrowserWindow,
  changed: (awake: boolean) => void,
): Promise<() => void> {
  const { DataType, load } = await loadWindowsApi();
  if (window.isDestroyed()) return () => undefined;
  const user = "arcwright-presence-user32",
    kernel = "arcwright-presence-kernel32";
  const message = 0x218;
  const handle = load({
    library: user,
    funcName: "RegisterPowerSettingNotification",
    retType: DataType.BigInt,
    paramsType: [DataType.BigInt, DataType.U8Array, DataType.U32],
    paramsValue: [window.getNativeWindowHandle().readBigUInt64LE(), SESSION_DISPLAY_GUID, 0],
  }) as bigint;
  if (handle === 0n) throw new Error("Display power notification registration failed");
  const unregister = () =>
    load({
      library: user,
      funcName: "UnregisterPowerSettingNotification",
      retType: DataType.Boolean,
      paramsType: [DataType.BigInt],
      paramsValue: [handle],
    });
  try {
    const process = load({
      library: kernel,
      funcName: "GetCurrentProcess",
      retType: DataType.BigInt,
      paramsType: [],
      paramsValue: [],
    });
    window.hookWindowMessage(message, (wParam, lParam) => {
      if (wParam.length < 8 || lParam.length < 8 || wParam.readBigUInt64LE() !== 0x8013n) return;
      const pointer = lParam.readBigUInt64LE();
      if (pointer === 0n) return;
      const setting = Buffer.alloc(24);
      const read = Buffer.alloc(8);
      const ok = load({
        library: kernel,
        funcName: "ReadProcessMemory",
        retType: DataType.Boolean,
        paramsType: [
          DataType.BigInt,
          DataType.BigInt,
          DataType.U8Array,
          DataType.U64,
          DataType.U8Array,
        ],
        paramsValue: [process, pointer, setting, 24, read],
      });
      if (!ok || read.readBigUInt64LE() !== 24n) return;
      const awake = decodeDisplayPowerSetting(setting);
      if (awake !== null) changed(awake);
    });
  } catch (error) {
    unregister();
    throw error;
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (!window.isDestroyed()) window.unhookWindowMessage(message);
    unregister();
  };
}

/** X11 DPMS and desktop screensaver state. Missing desktop APIs stay unknown;
 * idle input time alone must never pretend that a visible display is asleep. */
export async function linuxDisplayAwake(): Promise<boolean | null> {
  const dpms = new Promise<boolean | null>((resolve) => {
    NodeChildProcess.execFile(
      "xset",
      ["-q"],
      { timeout: 1000, maxBuffer: 16_384 },
      (error, out) => {
        if (error) return resolve(null);
        resolve(
          /Monitor is (Off|Standby|Suspend)/.test(out)
            ? false
            : /Monitor is On/.test(out)
              ? true
              : null,
        );
      },
    );
  });
  const screenSaver = (async () => {
    const bus = sessionBus();
    bus.on("error", () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const services = [
        ["org.freedesktop.ScreenSaver", "/ScreenSaver"],
        ["org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver"],
        ["org.gnome.ScreenSaver", "/org/gnome/ScreenSaver"],
      ] as const;
      const requests = services.map(([destination, path]) =>
        bus
          .call(
            new Message({
              destination,
              path,
              interface: destination,
              member: "GetActive",
            }),
          )
          .then((reply) =>
            reply?.type === 2 && typeof reply.body?.[0] === "boolean" ? !reply.body[0] : null,
          )
          .catch(() => null),
      );
      const states = await Promise.race([
        Promise.all(requests),
        new Promise<ReadonlyArray<boolean | null>>((resolve) => {
          timer = setTimeout(() => resolve([null]), 1000);
        }),
      ]);
      return states.includes(false) ? false : states.includes(true) ? true : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      bus.disconnect();
    }
  })().catch(() => null);
  const [display, saver] = await Promise.all([dpms, screenSaver]);
  return display === false || saver === false ? false : (display ?? saver);
}
