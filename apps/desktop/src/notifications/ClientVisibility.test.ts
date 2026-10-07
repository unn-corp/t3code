import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type * as Electron from "electron";

const native = vi.hoisted(() => ({ load: vi.fn(), open: vi.fn() }));
const linux = vi.hoisted(() => ({
  execFile: vi.fn(),
  bus: { on: vi.fn(), call: vi.fn(), disconnect: vi.fn() },
}));
vi.mock("node:child_process", () => ({ execFile: linux.execFile }));
vi.mock("dbus-next", () => ({
  Message: class {
    constructor(input: object) {
      Object.assign(this, input);
    }
  },
  sessionBus: () => linux.bus,
}));
vi.mock("ffi-rs", () => ({
  ...native,
  DataType: { BigInt: 1, U8Array: 2, U32: 3, U64: 4, Boolean: 5 },
}));
import {
  decodeDisplayPowerSetting,
  isNotificationClientVisible,
  SESSION_DISPLAY_GUID,
  watchWindowsDisplay,
  linuxDisplayAwake,
} from "./ClientVisibility.ts";

describe("notification client visibility", () => {
  const window = { destroyed: false, visible: true, minimized: false };
  const state = { windows: [window], locked: false, suspended: false, displayAwake: true };
  it("suppresses for any visible window even when it has no focus or recent input", () => {
    expect(isNotificationClientVisible(state)).toBe(true);
    expect(
      isNotificationClientVisible({ ...state, windows: [{ ...window, minimized: true }, window] }),
    ).toBe(true);
  });
  it.each([
    { windows: [{ ...window, minimized: true }] },
    { windows: [{ ...window, visible: false }] },
    { windows: [{ ...window, destroyed: true }] },
    { windows: [] },
    { locked: true },
    { suspended: true },
    { displayAwake: false },
  ])("does not suppress for unavailable windows/displays: %j", (patch) => {
    expect(isNotificationClientVisible({ ...state, ...patch })).toBe(false);
  });
  it("never treats an unknown screen state as proof of sleep", () => {
    expect(isNotificationClientVisible({ ...state, displayAwake: null })).toBe(true);
  });
  it("decodes off, awake and dimmed session display notifications", () => {
    const setting = Buffer.alloc(24);
    SESSION_DISPLAY_GUID.copy(setting);
    setting.writeUInt32LE(4, 16);
    for (const [value, expected] of [
      [0, false],
      [1, true],
      [2, true],
    ] as const) {
      setting.writeUInt32LE(value, 20);
      expect(decodeDisplayPowerSetting(setting)).toBe(expected);
    }
    setting.writeUInt32LE(9, 20);
    expect(decodeDisplayPowerSetting(setting)).toBeNull();
    expect(decodeDisplayPowerSetting(Buffer.alloc(24))).toBeNull();
    expect(decodeDisplayPowerSetting(Buffer.alloc(12))).toBeNull();
  });
});

describe("Linux display observation", () => {
  beforeEach(() => {
    linux.bus.disconnect.mockClear();
    linux.bus.call.mockReset();
    linux.execFile.mockReset();
    linux.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, text: string) => void,
      ) => callback(null, "Monitor is On"),
    );
  });
  it("screensaver sleep overrides Xwayland reporting its monitor on", async () => {
    linux.bus.call.mockResolvedValue({ type: 2, body: [true] });
    expect(await linuxDisplayAwake()).toBe(false);
    expect(linux.bus.disconnect).toHaveBeenCalledTimes(1);
  });
  it("supports the alternate freedesktop path when the first path is missing", async () => {
    linux.bus.call.mockImplementation((input: { path: string }) =>
      input.path === "/org/freedesktop/ScreenSaver"
        ? Promise.resolve({ type: 2, body: [true] })
        : Promise.reject(new Error("No service")),
    );
    expect(await linuxDisplayAwake()).toBe(false);
  });
  it("unavailable APIs remain unknown rather than inferring sleep from inactivity", async () => {
    linux.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: object,
        callback: (error: Error | null, text: string) => void,
      ) => callback(new Error("No X display"), ""),
    );
    linux.bus.call.mockRejectedValue(new Error("No service"));
    expect(await linuxDisplayAwake()).toBeNull();
    expect(linux.bus.disconnect).toHaveBeenCalledTimes(1);
  });
  it("a stalled session bus is bounded and disconnected", async () => {
    vi.useFakeTimers();
    try {
      linux.bus.call.mockImplementation(() => new Promise(() => {}));
      const observed = linuxDisplayAwake();
      await vi.advanceTimersByTimeAsync(1000);
      expect(await observed).toBe(true);
      expect(linux.bus.disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Windows display observation", () => {
  beforeEach(() => {
    native.load.mockReset();
  });
  function fixture() {
    let callback: ((wParam: Buffer, lParam: Buffer) => void) | undefined;
    const window = {
      isDestroyed: () => false,
      getNativeWindowHandle: () => {
        const handle = Buffer.alloc(8);
        handle.writeBigUInt64LE(7n);
        return handle;
      },
      hookWindowMessage: vi.fn((_id: number, next: typeof callback) => {
        callback = next;
      }),
      unhookWindowMessage: vi.fn(),
    };
    const changed = vi.fn();
    const packet = Buffer.alloc(24);
    SESSION_DISPLAY_GUID.copy(packet);
    packet.writeUInt32LE(4, 16);
    native.load.mockImplementation((input: { funcName: string; paramsValue: unknown[] }) => {
      if (input.funcName === "RegisterPowerSettingNotification") return 9n;
      if (input.funcName === "GetCurrentProcess") return -1n;
      if (input.funcName === "ReadProcessMemory") {
        packet.copy(input.paramsValue[2] as Buffer);
        (input.paramsValue[4] as Buffer).writeBigUInt64LE(24n);
        return true;
      }
      return true;
    });
    return {
      window,
      changed,
      packet,
      emit: (message = 0x8013n, pointer = 10n) => {
        const w = Buffer.alloc(8),
          l = Buffer.alloc(8);
        w.writeBigUInt64LE(message);
        l.writeBigUInt64LE(pointer);
        callback?.(w, l);
      },
    };
  }
  it("observes display sleep/wake and releases its registration exactly once", async () => {
    const f = fixture();
    const close = await watchWindowsDisplay(
      f.window as unknown as Electron.BrowserWindow,
      f.changed,
    );
    f.emit(0n);
    f.emit(0x8013n, 0n);
    expect(f.changed).not.toHaveBeenCalled();
    f.packet.writeUInt32LE(0, 20);
    f.emit();
    f.packet.writeUInt32LE(2, 20);
    f.emit();
    expect(f.changed.mock.calls).toEqual([[false], [true]]);
    close();
    close();
    expect(f.window.unhookWindowMessage).toHaveBeenCalledTimes(1);
    expect(
      native.load.mock.calls.filter(
        ([arg]) => arg.funcName === "UnregisterPowerSettingNotification",
      ),
    ).toHaveLength(1);
  });
  it("does not decode inaccessible native memory", async () => {
    const f = fixture();
    const close = await watchWindowsDisplay(
      f.window as unknown as Electron.BrowserWindow,
      f.changed,
    );
    native.load.mockImplementation(
      (input: { funcName: string }) => input.funcName !== "ReadProcessMemory",
    );
    f.emit();
    expect(f.changed).not.toHaveBeenCalled();
    close();
  });
  it("releases its OS registration if installing the message hook fails", async () => {
    const f = fixture();
    f.window.hookWindowMessage.mockImplementation(() => {
      throw new Error("closed window");
    });
    await expect(
      watchWindowsDisplay(f.window as unknown as Electron.BrowserWindow, f.changed),
    ).rejects.toThrow("closed window");
    expect(
      native.load.mock.calls.filter(
        ([arg]) => arg.funcName === "UnregisterPowerSettingNotification",
      ),
    ).toHaveLength(1);
  });
});
