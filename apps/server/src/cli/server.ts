import * as Effect from "effect/Effect";
import { Command, GlobalFlag } from "effect/unstable/cli";

import { ServerConfig, type StartupPresentation } from "../config.ts";
import {
  type CliServerFlags,
  resolveServerConfig,
  sharedServerCommandFlags,
  resolveTeamServiceConfig,
  teamServiceCommandFlags,
} from "./config.ts";
import { runTeamService } from "../team/server.ts";
import { requireTeamServiceConfiguration } from "../team/serviceConfig.ts";

export const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    const { runServer } = yield* Effect.promise(() => import("../server.ts"));
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);

export const teamServiceCommand = Command.make("team-service", teamServiceCommandFlags).pipe(
  Command.withDescription(
    "Run the Teams collaboration service; agents run on teammates' local machines.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      yield* requireTeamServiceConfiguration;
      const config = yield* resolveTeamServiceConfig(flags, yield* GlobalFlag.LogLevel);
      return yield* runTeamService.pipe(Effect.provideService(ServerConfig, config));
    }),
  ),
);
