import { requestCoordinatedCliUpdate } from "../maintenance/coordinatedUpdate.ts";
import { describeStatus } from "../maintenance/operatorClient.ts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export class CliUpdateError extends Schema.TaggedError<CliUpdateError>()("CliUpdateError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const updateFlags = {
  ...projectLocationFlags,
  channel: Flag.Literals("channel", ["stable", "nightly"]).pipe(
    Flag.withDescription(
      "Release channel for this home. Defaults to its saved maintenance policy.",
    ),
    Flag.optional,
  ),
  allowDowngrade: Flag.Boolean("allow-downgrade").pipe(
    Flag.withDescription(
      "Deprecated. Reverting requires an exact recorded maintenance recovery option.",
    ),
    Flag.withDefault(false),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription(
      "Compatibility flag. Maintenance admission and operating-system confirmation still apply.",
    ),
    Flag.withDefault(false),
  ),
};

const versionArgument = Argument.String("version").pipe(
  Argument.withDescription(
    "Exact staged version to request. Defaults to the newest eligible release on the saved channel.",
  ),
  Argument.optional,
);

export const updateCommand = Command.make("update", {
  ...updateFlags,
  version: versionArgument,
}).pipe(
  Command.withDescription(
    "Request an update through this home’s maintenance controller; installation waits for every registered agent.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveCliAuthConfig(flags, logLevel);
      const status = yield* Effect.tryPromise({
        try: () =>
          requestCoordinatedCliUpdate({
            baseDir: config.baseDir,
            channel: Option.getOrUndefined(flags.channel),
            requestedVersion: Option.getOrUndefined(flags.version),
            allowDowngrade: flags.allowDowngrade,
          }),
        catch: (cause) =>
          new CliUpdateError({
            reason: cause instanceof Error ? cause.message : String(cause),
          }),
      });
      for (const line of describeStatus(status)) yield* Console.log(line);
    }),
  ),
);
