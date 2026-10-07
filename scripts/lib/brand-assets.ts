export const BRAND_ASSET_PATHS = {
  mainLogoMarkPng: "assets/arcwright/mark.png",
  mainLogoWordmarkPng: "assets/arcwright/wordmark.png",
  mainLogoMarkOnLightPng: "assets/arcwright/mark-on-light.png",
  mainLogoMarkOnDarkPng: "assets/arcwright/mark-on-dark.png",
  mainLogoSquareOnDarkPng: "assets/arcwright/mark-square-on-dark.png",
  mainLogoWordmarkOnLightPng: "assets/arcwright/wordmark-on-light.png",
  mainLogoWordmarkOnDarkPng: "assets/arcwright/wordmark-on-dark.png",

  developmentIconComposerProject: "assets/dev/app-icon.icon",
  developmentIosIconPng: "assets/dev/blueprint-ios-1024.png",
  developmentUniversalIconPng: "assets/dev/blueprint-universal-1024.png",
  developmentWebPwa192Png: "assets/dev/blueprint-web-pwa-192.png",
  developmentWebPwa512Png: "assets/dev/blueprint-web-pwa-512.png",
  developmentWebPwaMaskablePng: "assets/dev/blueprint-web-pwa-maskable-512.png",

  productionIconComposerProject: "assets/prod/app-icon.icon",
  productionIosIconPng: "assets/prod/black-ios-1024.png",
  productionMacIconPng: "assets/prod/black-macos-1024.png",
  productionLinuxIconPng: "assets/prod/black-universal-1024.png",
  productionWindowsIconIco: "assets/prod/t3-black-windows.ico",
  productionWebFaviconIco: "assets/prod/t3-black-web-favicon.ico",
  productionWebFavicon16Png: "assets/prod/t3-black-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/prod/t3-black-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/prod/t3-black-web-apple-touch-180.png",
  productionWebPwa192Png: "assets/prod/t3-black-web-pwa-192.png",
  productionWebPwa512Png: "assets/prod/t3-black-web-pwa-512.png",
  productionWebPwaMaskablePng: "assets/prod/t3-black-web-pwa-maskable-512.png",

  nightlyIconComposerProject: "assets/nightly/app-icon.icon",
  nightlyIosIconPng: "assets/nightly/nightly-ios-1024.png",
  nightlyMacIconPng: "assets/nightly/nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/nightly/nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/nightly/nightly-windows.ico",
  nightlyWebFaviconIco: "assets/nightly/nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/nightly/nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/nightly/nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/nightly/nightly-web-apple-touch-180.png",
  nightlyWebPwa192Png: "assets/nightly/nightly-web-pwa-192.png",
  nightlyWebPwa512Png: "assets/nightly/nightly-web-pwa-512.png",
  nightlyWebPwaMaskablePng: "assets/nightly/nightly-web-pwa-maskable-512.png",

  developmentDesktopIconPng: "assets/dev/blueprint-macos-1024.png",
  developmentWindowsIconIco: "assets/dev/blueprint-windows.ico",
  developmentWebFaviconIco: "assets/dev/blueprint-web-favicon.ico",
  developmentWebFavicon16Png: "assets/dev/blueprint-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/dev/blueprint-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/dev/blueprint-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return /^[^-+]+-(?:nightly|preview)\./.test(version) ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
  pwa192Png: "pwa-192x192.png",
  pwa512Png: "pwa-512x512.png",
  pwaMaskablePng: "pwa-maskable-512x512.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    pwa192Png: BRAND_ASSET_PATHS.developmentWebPwa192Png,
    pwa512Png: BRAND_ASSET_PATHS.developmentWebPwa512Png,
    pwaMaskablePng: BRAND_ASSET_PATHS.developmentWebPwaMaskablePng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    pwa192Png: BRAND_ASSET_PATHS.nightlyWebPwa192Png,
    pwa512Png: BRAND_ASSET_PATHS.nightlyWebPwa512Png,
    pwaMaskablePng: BRAND_ASSET_PATHS.nightlyWebPwaMaskablePng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    pwa192Png: BRAND_ASSET_PATHS.productionWebPwa192Png,
    pwa512Png: BRAND_ASSET_PATHS.productionWebPwa512Png,
    pwaMaskablePng: BRAND_ASSET_PATHS.productionWebPwaMaskablePng,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
    {
      sourceRelativePath: sourcePaths.pwa192Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.pwa192Png}`,
    },
    {
      sourceRelativePath: sourcePaths.pwa512Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.pwa512Png}`,
    },
    {
      sourceRelativePath: sourcePaths.pwaMaskablePng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.pwaMaskablePng}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
