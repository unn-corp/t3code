import type { HermesSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "../../pathExpansion.ts";

/**
 * Hermes accepts a dedicated HERMES_HOME directory. Keep the host HOME
 * untouched so system credential stores and unrelated CLI configuration keep
 * working as expected.
 */
export const makeHermesEnvironment = Effect.fn("makeHermesEnvironment")(function* (
  config: Pick<HermesSettings, "homePath">,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const environment = baseEnv ?? process.env;
  const configuredHome = config.homePath.trim();
  if (!configuredHome) return environment;
  const path = yield* Path.Path;
  return {
    ...environment,
    HERMES_HOME: path.resolve(expandHomePath(configuredHome)),
  };
});
