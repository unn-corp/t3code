import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import * as Backup from "../backup/BackupService.ts";

const createCommand = Command.make("create", {
  homeDir: Flag.String("home-dir"),
  outputDir: Flag.String("output"),
}).pipe(
  Command.withDescription(
    "Back up a stopped Arcwright Code home to a new local directory, including credentials and attachments.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* Backup.BackupService;
      const result = yield* service.create(input);
      yield* Console.log(`Backup saved to ${result.path} (${result.fileCount} files).`);
    }).pipe(Effect.provide(Backup.layer)),
  ),
);
const restoreCommand = Command.make("restore", {
  inputDir: Flag.String("input"),
  homeDir: Flag.String("home-dir"),
}).pipe(
  Command.withDescription(
    "Verify and restore a backup into a new Arcwright Code home. Existing directories are never replaced.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const service = yield* Backup.BackupService;
      const result = yield* service.restore(input);
      yield* Console.log(
        `Restored to ${result.path} (${result.fileCount} files). Launch with --base-dir ${result.path}.`,
      );
    }).pipe(Effect.provide(Backup.layer)),
  ),
);
export const backupCommand = Command.make("backup").pipe(
  Command.withDescription("Create or restore local Arcwright Code data backups."),
  Command.withSubcommands([createCommand, restoreCommand]),
);
