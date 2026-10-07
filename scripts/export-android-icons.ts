#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Renders native launcher and notification assets at the Node build boundary.

import * as NodeFSP from "node:fs/promises";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import sharp from "sharp";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";
import {
  ICON_BACKGROUND,
  lightLettering,
  monochromeLogo,
  renderLogoCanvas,
} from "./lib/arcwright-icons.ts";

const repositoryRoot = new URL("../", import.meta.url);
const check = process.argv.includes("--check");
const mark = lightLettering(
  await NodeFSP.readFile(new URL(BRAND_ASSET_PATHS.mainLogoMarkPng, repositoryRoot)),
);
// Android masks the central 72dp of a 108dp adaptive canvas. Keep the
// entire AC symbol within its guaranteed safe zone, including the bolt.
const foreground = await renderLogoCanvas(mark, 432, 0.48, "#00000000");
const splash = await renderLogoCanvas(mark, 1152, 0.48);
const background = await sharp({
  create: { width: 432, height: 432, channels: 4, background: ICON_BACKGROUND },
})
  .png()
  .toBuffer();
const notification = await renderLogoCanvas(monochromeLogo(mark), 96, 0.88, "#00000000");
const widget = await renderLogoCanvas(monochromeLogo(mark), 256, 0.92, "#00000000");

const outputs = new Map<string, Buffer>([
  ["apps/mobile/assets/android-icon-foreground.png", foreground],
  ["apps/mobile/assets/android-icon-mark.png", monochromeLogo(foreground)],
  ["apps/mobile/assets/android-notification-icon.png", notification],
  ["apps/mobile/assets/widget/ArcwrightMark.png", widget],
  ["apps/android-pwa/app/src/main/res/drawable/notification_icon.png", notification],
  [
    "apps/mobile/modules/t3-agent-notifications/android/src/main/res/drawable/agent_activity_mark.png",
    notification,
  ],
]);
for (const variant of ["dev", "nightly", "prod"]) {
  outputs.set("apps/mobile/assets/android-splash-icon-" + variant + ".png", splash);
  if (variant !== "prod")
    outputs.set("apps/mobile/assets/android-icon-background-" + variant + ".png", background);
}

const stale: string[] = [];
for (const [target, contents] of outputs) {
  const destination = new URL(target, repositoryRoot);
  if (check) {
    const actual = await NodeFSP.readFile(destination).catch(() => null);
    if (!actual?.equals(contents)) stale.push(target);
  } else {
    await NodeFSP.mkdir(new URL(".", destination), { recursive: true });
    await NodeFSP.writeFile(destination, contents);
  }
}
if (stale.length) throw new Error("Stale Arcwright Android assets:\n" + stale.join("\n"));
Effect.runSync(
  Console.log(
    `${check ? "Verified" : "Generated"} ${outputs.size} Arcwright Android and widget assets.`,
  ),
);
