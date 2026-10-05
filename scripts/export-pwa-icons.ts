#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Reads and writes generated image assets at the Node build boundary.

import * as NodeFSP from "node:fs/promises";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";

const variants = [
  {
    source: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    maskableSource: "apps/mobile/assets/android-splash-icon-dev.png",
    icon192: BRAND_ASSET_PATHS.developmentWebPwa192Png,
    icon512: BRAND_ASSET_PATHS.developmentWebPwa512Png,
    maskable: BRAND_ASSET_PATHS.developmentWebPwaMaskablePng,
  },
  {
    source: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    maskableSource: "apps/mobile/assets/android-splash-icon-nightly.png",
    icon192: BRAND_ASSET_PATHS.nightlyWebPwa192Png,
    icon512: BRAND_ASSET_PATHS.nightlyWebPwa512Png,
    maskable: BRAND_ASSET_PATHS.nightlyWebPwaMaskablePng,
  },
  {
    source: BRAND_ASSET_PATHS.productionLinuxIconPng,
    maskableSource: "apps/mobile/assets/android-splash-icon-prod.png",
    icon192: BRAND_ASSET_PATHS.productionWebPwa192Png,
    icon512: BRAND_ASSET_PATHS.productionWebPwa512Png,
    maskable: BRAND_ASSET_PATHS.productionWebPwaMaskablePng,
  },
];

const check = process.argv.includes("--check");
const repositoryRoot = new URL("../", import.meta.url);
for (const variant of variants) {
  // Android splash artwork already has an opaque background and a centered
  // wordmark inside the mask's safe zone, unlike the rounded universal icon.
  for (const [source, target, size] of [
    [variant.source, variant.icon192, 192],
    [variant.source, variant.icon512, 512],
    [variant.maskableSource, variant.maskable, 512],
  ] as const) {
    const contents = await sharp(await NodeFSP.readFile(new URL(source, repositoryRoot)))
      .resize(size, size)
      .png()
      .toBuffer();
    const destination = new URL(target, repositoryRoot);
    if (check) {
      if (!contents.equals(await NodeFSP.readFile(destination)))
        throw new Error(`Stale PWA icon: ${target}`);
    } else {
      await NodeFSP.writeFile(destination, contents);
    }
  }
}

for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES.filter((value) =>
  value.targetRelativePath.includes("/pwa-"),
)) {
  const source = new URL(override.sourceRelativePath, repositoryRoot);
  const target = new URL(override.targetRelativePath, repositoryRoot);
  if (check) {
    if (!(await NodeFSP.readFile(source)).equals(await NodeFSP.readFile(target))) {
      throw new Error(`Stale public PWA icon: ${override.targetRelativePath}`);
    }
  } else {
    await NodeFSP.copyFile(source, target);
  }
}
