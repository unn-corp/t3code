#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Reads and writes generated brand assets at the Node build boundary.

import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import {
  lightLettering,
  renderDesktopIcon,
  renderLogoCanvas,
  renderMacIcon,
  trimLogo,
} from "./lib/arcwright-icons.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const repositoryRoot = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
const mark = await NodeFSP.readFile(new URL(BRAND_ASSET_PATHS.mainLogoMarkPng, repositoryRoot));
const wordmark = await NodeFSP.readFile(
  new URL(BRAND_ASSET_PATHS.mainLogoWordmarkPng, repositoryRoot),
);
const markOnLight = await trimLogo(mark);
const markOnDark = await trimLogo(lightLettering(mark));
const wordmarkOnLight = await trimLogo(wordmark);
const wordmarkOnDark = await trimLogo(lightLettering(wordmark));
const icon = await renderLogoCanvas(markOnDark, 1024);
const desktopIcon = await renderDesktopIcon(markOnDark);
const desktopIco = encodePngIco(
  await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({
      size,
      contents: await renderDesktopIcon(markOnDark, size),
    })),
  ),
);
const macIcon = await renderMacIcon(markOnDark);
const composerMark = await sharp(lightLettering(mark)).resize(1024, 1024).png().toBuffer();
const iconAtSize = (size: number) => sharp(icon).resize(size, size).png().toBuffer();
const ico = encodePngIco(
  await Promise.all(
    WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await iconAtSize(size) })),
  ),
);
const appleTouch = await iconAtSize(180);
const favicon16 = await iconAtSize(16);
const favicon32 = await iconAtSize(32);
const outputs = new Map<string, Buffer>([
  [BRAND_ASSET_PATHS.mainLogoMarkOnLightPng, markOnLight],
  [BRAND_ASSET_PATHS.mainLogoMarkOnDarkPng, markOnDark],
  [BRAND_ASSET_PATHS.mainLogoSquareOnDarkPng, lightLettering(mark)],
  [BRAND_ASSET_PATHS.mainLogoWordmarkOnLightPng, wordmarkOnLight],
  [BRAND_ASSET_PATHS.mainLogoWordmarkOnDarkPng, wordmarkOnDark],
]);

const markDimensions = await sharp(markOnLight).metadata();
const wordmarkDimensions = await sharp(wordmarkOnLight).metadata();
outputs.set(
  "assets/arcwright/dimensions.json",
  Buffer.from(
    JSON.stringify(
      {
        mark: { width: markDimensions.width, height: markDimensions.height },
        wordmark: { width: wordmarkDimensions.width, height: wordmarkDimensions.height },
      },
      null,
      2,
    ) + "\n",
  ),
);

const variants = [
  {
    composer: BRAND_ASSET_PATHS.developmentIconComposerProject,
    ios: BRAND_ASSET_PATHS.developmentIosIconPng,
    mac: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
    appleTouch: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    favicon16: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
  },
  {
    composer: BRAND_ASSET_PATHS.nightlyIconComposerProject,
    ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
    mac: BRAND_ASSET_PATHS.nightlyMacIconPng,
    universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
    appleTouch: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    favicon16: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
  },
  {
    composer: BRAND_ASSET_PATHS.productionIconComposerProject,
    ios: BRAND_ASSET_PATHS.productionIosIconPng,
    mac: BRAND_ASSET_PATHS.productionMacIconPng,
    universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
    appleTouch: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    favicon16: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
  },
];

const composerProject = Buffer.from(
  JSON.stringify(
    {
      fill: { solid: "display-p3:0.03922,0.03922,0.03922,1.00000" },
      groups: [
        {
          layers: [
            {
              "image-name": "arcwright-mark.png",
              name: "AC lightning mark",
              glass: false,
              position: { scale: 1, "translation-in-points": [0, 0] },
            },
          ],
          shadow: { kind: "neutral", opacity: 0 },
          translucency: { enabled: false },
        },
      ],
      "supported-platforms": { circles: ["watchOS"], squares: "shared" },
    },
    null,
    2,
  ) + "\n",
);

for (const variant of variants) {
  outputs.set(variant.ios, icon);
  outputs.set(variant.universal, desktopIcon);
  outputs.set(variant.mac, macIcon);
  outputs.set(variant.appleTouch, appleTouch);
  outputs.set(variant.favicon16, favicon16);
  outputs.set(variant.favicon32, favicon32);
  outputs.set(variant.faviconIco, ico);
  outputs.set(variant.windowsIco, desktopIco);
  outputs.set(variant.composer + "/Assets/arcwright-mark.png", composerMark);
  outputs.set(variant.composer + "/icon.json", composerProject);
}

outputs.set(
  "assets/prod/logo.svg",
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${markDimensions.width} ${markDimensions.height}"><image width="${markDimensions.width}" height="${markDimensions.height}" href="data:image/png;base64,${markOnDark.toString("base64")}"/></svg>\n`,
  ),
);
outputs.set("apps/marketing/src/assets/icon.webp", await sharp(icon).webp().toBuffer());
outputs.set("apps/marketing/src/assets/icon-nightly.webp", await sharp(icon).webp().toBuffer());

for (const channel of ["latest", "nightly"] as const) {
  const target = `apps/desktop/resources/dmg/dmg-background-${channel}.svg`;
  const source = await NodeFSP.readFile(new URL(target, repositoryRoot), "utf8");
  const logo = channel === "nightly" ? wordmarkOnDark : wordmarkOnLight;
  const placeholder = /<g id="arcwright-wordmark">[\s\S]*?<\/g>/;
  if (!placeholder.test(source)) throw new Error("Missing DMG wordmark group: " + target);
  outputs.set(
    target,
    Buffer.from(
      source.replace(
        placeholder,
        `<g id="arcwright-wordmark"><image x="32" y="23" width="132" height="24" href="data:image/png;base64,${logo.toString("base64")}"/></g>`,
      ),
    ),
  );
}

for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES.filter(
  (value) => !value.targetRelativePath.includes("/pwa-"),
)) {
  const contents = outputs.get(override.sourceRelativePath);
  if (!contents) throw new Error("Missing generated icon: " + override.sourceRelativePath);
  outputs.set(override.targetRelativePath, contents);
}
for (const [name, contents] of [
  ["favicon.ico", ico],
  ["favicon-16x16.png", favicon16],
  ["favicon-32x32.png", favicon32],
  ["apple-touch-icon.png", appleTouch],
] as const)
  outputs.set("apps/marketing/public/" + name, contents);

const stale: string[] = [];
for (const [target, contents] of outputs) {
  const destination = new URL(target, repositoryRoot);
  if (check) {
    const actual = await NodeFSP.readFile(destination).catch(() => null);
    // The repository formatter expands JSON objects; that must not mark unchanged artwork stale.
    let matches = actual?.equals(contents) ?? false;
    if (!matches && actual && target.endsWith(".json")) {
      try {
        matches = NodeUtil.isDeepStrictEqual(
          JSON.parse(actual.toString("utf8")),
          JSON.parse(contents.toString("utf8")),
        );
      } catch {
        matches = false;
      }
    }
    if (!matches) stale.push(target);
  } else {
    await NodeFSP.mkdir(new URL(".", destination), { recursive: true });
    await NodeFSP.writeFile(destination, contents);
  }
}
if (stale.length) throw new Error("Stale Arcwright brand assets:\n" + stale.join("\n"));
Effect.runSync(
  Console.log(`${check ? "Verified" : "Generated"} ${outputs.size} Arcwright Code brand assets.`),
);
