// @effect-diagnostics nodeBuiltinImport:off - Verifies the generated files consumed by the web build.
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import sharp from "sharp";
import { expect, it } from "vite-plus/test";

import { resolveWebIconOverrides } from "./brand-assets.ts";

const root = new URL("../../", import.meta.url);
const manifest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      icons: Schema.Array(
        Schema.Struct({
          src: Schema.String,
          sizes: Schema.String,
          purpose: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
)(NodeFS.readFileSync(new URL("apps/web/public/manifest.webmanifest", root), "utf8"));

it.each(["development", "nightly", "production"] as const)(
  "%s packages matching installation icons and an opaque maskable icon",
  async (brand) => {
    const overrides = resolveWebIconOverrides(brand, "apps/web/public");
    for (const icon of manifest.icons.filter((value) => value.src.startsWith("/pwa-"))) {
      const override = overrides.find(
        (value) => value.targetRelativePath === `apps/web/public${icon.src}`,
      );
      expect(override).toBeDefined();
      const contents = NodeFS.readFileSync(new URL(override!.sourceRelativePath, root));
      const metadata = await sharp(contents).metadata();
      expect(`${metadata.width}x${metadata.height}`).toBe(icon.sizes);
      if (icon.purpose === "maskable") expect((await sharp(contents).stats()).isOpaque).toBe(true);
    }
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ sizes: "192x192", purpose: "any" }),
    );
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ sizes: "512x512", purpose: "any" }),
    );
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
    );
  },
);
