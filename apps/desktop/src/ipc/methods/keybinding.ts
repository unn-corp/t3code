// @effect-diagnostics nodeBuiltinImport:off - ydotool is the Linux desktop input boundary.
import * as NodeChildProcess from "node:child_process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const KEYCODES: Readonly<Record<string, number>> = {
  ctrl: 29,
  shift: 42,
  alt: 56,
  meta: 125,
  enter: 28,
  escape: 1,
  tab: 15,
  space: 57,
  backspace: 14,
  arrowup: 103,
  arrowdown: 108,
  arrowleft: 105,
  arrowright: 106,
  home: 102,
  pageup: 104,
  end: 107,
  pagedown: 109,
  delete: 111,
  f1: 59,
  f2: 60,
  f3: 61,
  f4: 62,
  f5: 63,
  f6: 64,
  f7: 65,
  f8: 66,
  f9: 67,
  f10: 68,
  f11: 87,
  f12: 88,
};

const PUNCTUATION_KEYCODES: Readonly<Record<string, number>> = {
  "-": 12,
  "=": 13,
  "[": 26,
  "]": 27,
  ";": 39,
  "'": 40,
  "`": 41,
  "\\": 43,
  ",": 51,
  ".": 52,
  "/": 53,
};

const LETTER_KEYCODES: Readonly<Record<string, number>> = {
  q: 16,
  w: 17,
  e: 18,
  r: 19,
  t: 20,
  y: 21,
  u: 22,
  i: 23,
  o: 24,
  p: 25,
  a: 30,
  s: 31,
  d: 32,
  f: 33,
  g: 34,
  h: 35,
  j: 36,
  k: 37,
  l: 38,
  z: 44,
  x: 45,
  c: 46,
  v: 47,
  b: 48,
  n: 49,
  m: 50,
};

function keyCodeForToken(token: string): number | null {
  const normalized = token.trim().toLowerCase();
  if (KEYCODES[normalized] !== undefined) return KEYCODES[normalized];
  if (PUNCTUATION_KEYCODES[normalized] !== undefined) return PUNCTUATION_KEYCODES[normalized];
  if (LETTER_KEYCODES[normalized] !== undefined) return LETTER_KEYCODES[normalized];
  if (/^[1-9]$/.test(normalized)) return 1 + Number(normalized);
  if (normalized === "0") return 11;
  return null;
}

export function ydotoolArguments(keybinding: string): string[] | null {
  const tokens = keybinding
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const codes = tokens.map(keyCodeForToken);
  if (codes.some((code) => code === null)) return null;
  const resolved = codes as number[];
  return [...resolved.map((code) => `${code}:1`), ...resolved.reverse().map((code) => `${code}:0`)];
}

export const sendKeybinding = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SEND_KEYBINDING_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.keybinding.send")(function* (keybinding) {
    const args = ydotoolArguments(keybinding);
    const platform = yield* HostProcessPlatform;
    if (args === null || platform !== "linux") return false;
    return yield* Effect.promise(
      () =>
        new Promise<boolean>((resolve) => {
          const child = NodeChildProcess.spawn("ydotool", ["key", ...args], { stdio: "ignore" });
          child.once("error", () => resolve(false));
          child.once("exit", (code) => resolve(code === 0));
        }),
    );
  }),
});
