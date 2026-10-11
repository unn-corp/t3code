import { describe, expect, it } from "vite-plus/test";
import { desktopLauncherIconName } from "./DesktopLauncherIcon.ts";

describe("launcher icon cache identity", () => {
  it("changes the file name when the logo changes, retaining the desktop identity", () => {
    const id = "com.t3tools.T3Code.desktop";
    const oldIcon = new Uint8Array([1, 2, 3]);
    const roundedIcon = new Uint8Array([1, 2, 4]);
    expect(desktopLauncherIconName(id, oldIcon)).not.toBe(desktopLauncherIconName(id, roundedIcon));
    expect(desktopLauncherIconName(id, roundedIcon)).toBe(
      desktopLauncherIconName(id, roundedIcon.slice()),
    );
    expect(desktopLauncherIconName(id, roundedIcon)).toMatch(
      /^com\.t3tools\.T3Code\.desktop-[a-f0-9]{12}\.png$/,
    );
  });
});
