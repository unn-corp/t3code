import { describe, expect, it } from "vite-plus/test";
import { ydotoolArguments } from "./keybinding.js";

describe("ydotoolArguments", () => {
  it("presses and releases a recorded modifier chord in reverse order", () => {
    expect(ydotoolArguments("ctrl+shift")).toEqual(["29:1", "42:1", "42:0", "29:0"]);
    expect(ydotoolArguments("ctrl+shift+m")).toEqual([
      "29:1",
      "42:1",
      "50:1",
      "50:0",
      "42:0",
      "29:0",
    ]);
  });

  it("supports standalone function keys and punctuation", () => {
    expect(ydotoolArguments("f8")).toEqual(["66:1", "66:0"]);
    expect(ydotoolArguments("ctrl+/")).toEqual(["29:1", "53:1", "53:0", "29:0"]);
  });

  it("rejects an unsupported key token", () => {
    expect(ydotoolArguments("ctrl+volumeup")).toBeNull();
  });
});
