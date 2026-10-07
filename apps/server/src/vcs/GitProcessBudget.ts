import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

const METADATA_COMMANDS = new Set([
  "rev-parse",
  "symbolic-ref",
  "show-ref",
  "for-each-ref",
  "config",
  "remote",
  "check-attr",
  "check-ignore",
  "ls-files",
  "ls-tree",
  "version",
]);

function isHeavy(args: ReadonlyArray<string>): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      i++;
    } else if (!arg.startsWith("-")) {
      // Unknown commands and aliases may scan assets or write objects.
      return !METADATA_COMMANDS.has(arg);
    }
  }
  return false;
}

export const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const processes = yield* Semaphore.make(8);
  const heavyProcesses = yield* Semaphore.make(2);
  const repositories = yield* KeyedLock.make<string>();
  return {
    withPermit: <A, E, R>(
      cwd: string,
      args: ReadonlyArray<string>,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> => {
      const bounded = processes.withPermit(effect);
      // Acquire the repository first: queued work for one busy checkout must
      // not consume the global permits needed by other repositories.
      return isHeavy(args)
        ? repositories.withLock(path.resolve(cwd), heavyProcesses.withPermit(bounded))
        : bounded;
    },
  };
});

// Both Git execution paths use the same process-wide budget, including
// commands with extended or unlimited deadlines. Metadata reads retain room
// while asset scans, LFS filtering and checkout writes are running.
const shared = Effect.runSync(make.pipe(Effect.provide(NodePath.layer)));
export const withPermit = shared.withPermit;
