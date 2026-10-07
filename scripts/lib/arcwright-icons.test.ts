// @effect-diagnostics nodeBuiltinImport:off - Reads the checked-in binary logo fixture for pixel-level artifact assertions.
import * as NodeFSP from "node:fs/promises";
import { PNG } from "pngjs";
import { describe, expect, it } from "vite-plus/test";

import {
  lightLettering,
  monochromeLogo,
  renderLogoCanvas,
  renderMacIcon,
} from "./arcwright-icons.ts";

const source = new URL("../../assets/arcwright/mark.png", import.meta.url);
const alphaAt = (image: PNG, x: number, y: number) => image.data[(y * image.width + x) * 4 + 3];

describe("Arcwright platform artwork", () => {
  it("keeps the blue bolt and transparency when adapting neutral lettering", () => {
    const image = new PNG({ width: 3, height: 1 });
    image.data = Buffer.from([0, 0, 0, 255, 0, 102, 255, 180, 0, 0, 0, 0]);
    const adapted = PNG.sync.read(lightLettering(PNG.sync.write(image)));
    expect([...adapted.data]).toEqual([255, 255, 255, 255, 0, 102, 255, 180, 255, 255, 255, 0]);
    const monochrome = PNG.sync.read(monochromeLogo(PNG.sync.write(image)));
    expect([...monochrome.data]).toEqual([
      255, 255, 255, 255, 255, 255, 255, 180, 255, 255, 255, 0,
    ]);
  });

  it("keeps the actual AC mark inside Android's guaranteed circular safe zone", async () => {
    const mark = await NodeFSP.readFile(source);
    const size = 432;
    const image = PNG.sync.read(await renderLogoCanvas(mark, size, 0.48, "#00000000"));
    const safeRadius = (size * 66) / 108 / 2;
    let visiblePixels = 0;
    let outsideSafeZone = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (alphaAt(image, x, y)! > 0) {
          visiblePixels++;
          if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > safeRadius) outsideSafeZone++;
        }
      }
    }
    expect(visiblePixels).toBeGreaterThan(1000);
    expect(outsideSafeZone).toBe(0);
    expect(alphaAt(image, 0, 0)).toBe(0);
  });

  it("exports macOS artwork with the classic inset and transparent rounded corners", async () => {
    const image = PNG.sync.read(
      await renderMacIcon(lightLettering(await NodeFSP.readFile(source))),
    );
    expect([image.width, image.height]).toEqual([1024, 1024]);
    for (const [x, y] of [
      [99, 512],
      [924, 512],
      [512, 99],
      [512, 924],
      [100, 100],
    ]) {
      expect(alphaAt(image, x!, y!)).toBe(0);
    }
    for (const [x, y] of [
      [100, 512],
      [923, 512],
      [512, 100],
      [512, 923],
    ]) {
      expect(alphaAt(image, x!, y!)).toBe(255);
    }
  });
});
