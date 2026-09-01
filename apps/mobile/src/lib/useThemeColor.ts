import type { ColorValue } from "react-native";
import { useCSSVariable } from "uniwind";

/**
 * Typed wrapper around `useCSSVariable` for React Native style props.
 */
export function useThemeColor(variable: `--color-${string}`): ColorValue {
  return useCSSVariable(variable) as string as ColorValue;
}
