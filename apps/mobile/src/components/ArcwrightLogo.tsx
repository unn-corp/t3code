import { Image } from "expo-image";

import dimensions from "../../../../assets/arcwright/dimensions.json";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

const MARK_ON_LIGHT = require("../../../../assets/arcwright/mark-on-light.png");
const MARK_ON_DARK = require("../../../../assets/arcwright/mark-on-dark.png");
const WORDMARK_ON_LIGHT = require("../../../../assets/arcwright/wordmark-on-light.png");
const WORDMARK_ON_DARK = require("../../../../assets/arcwright/wordmark-on-dark.png");

export function ArcwrightMark({ height }: { readonly height: number }) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Image
      accessibilityLabel="Arcwright Code"
      accessibilityIgnoresInvertColors
      source={themeAppearance === "dark" ? MARK_ON_DARK : MARK_ON_LIGHT}
      contentFit="contain"
      style={{ height, width: (height * dimensions.mark.width) / dimensions.mark.height }}
    />
  );
}

export function ArcwrightWordmark({ height }: { readonly height: number }) {
  const { themeAppearance } = useAppearancePreferences();
  return (
    <Image
      accessibilityLabel="Arcwright Code"
      accessibilityIgnoresInvertColors
      source={themeAppearance === "dark" ? WORDMARK_ON_DARK : WORDMARK_ON_LIGHT}
      contentFit="contain"
      style={{ height, width: (height * dimensions.wordmark.width) / dimensions.wordmark.height }}
    />
  );
}
