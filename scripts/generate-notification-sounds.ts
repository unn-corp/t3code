#!/usr/bin/env node

/**
 * Regenerates the generated agent-notification sounds into
 * `apps/web/public/sounds/`.
 *
 * The .ogg assets are committed, so this only needs to run when a spec in
 * `lib/notification-sounds.ts` changes. Requires `ffmpeg` on PATH.
 *
 *   pnpm --filter @t3tools/scripts exec tsx generate-notification-sounds.ts
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { encodeWav, renderTones, SAMPLE_RATE, SOUND_SPECS } from "./lib/notification-sounds.ts";

const OUTPUT_DIRECTORY = ["apps", "web", "public", "sounds"] as const;

/** Vorbis quality. 4 is transparent for sounds this short and keeps them ~10KB. */
const VORBIS_QUALITY = "4";

const generate = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const outputDirectory = path.join(repositoryRoot, ...OUTPUT_DIRECTORY);
  yield* fileSystem.makeDirectory(outputDirectory, { recursive: true });

  const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped();

  for (const spec of SOUND_SPECS) {
    const samples = renderTones(spec.tones, seedFor(spec.id));
    const wavPath = path.join(temporaryDirectory, `${spec.id}.wav`);
    yield* fileSystem.writeFile(wavPath, encodeWav(samples));

    const oggPath = path.join(outputDirectory, `${spec.id}.ogg`);
    const process = yield* spawner.spawn(
      ChildProcess.make("ffmpeg", [
        "-y",
        "-loglevel",
        "error",
        "-i",
        wavPath,
        "-c:a",
        "libvorbis",
        "-q:a",
        VORBIS_QUALITY,
        "-ac",
        "1",
        "-ar",
        String(SAMPLE_RATE),
        // Without these the Ogg muxer stamps an encoder string and a random
        // stream serial, so an unchanged spec would still produce new bytes
        // and every regeneration would look like a real asset change.
        "-bitexact",
        "-serial_offset",
        "1",
        oggPath,
      ]),
    );
    const exitCode = yield* process.exitCode;
    if (exitCode !== 0) {
      return yield* Effect.die(new Error(`ffmpeg failed for ${spec.id} (exit ${exitCode})`));
    }

    const stats = yield* fileSystem.stat(oggPath);
    const seconds = samples.length / SAMPLE_RATE;
    yield* Console.log(
      `${spec.id.padEnd(12)} ${seconds.toFixed(2)}s  ${String(Number(stats.size))} bytes`,
    );
  }

  yield* Console.log(`\nWrote ${String(SOUND_SPECS.length)} sounds to ${outputDirectory}`);
}).pipe(Effect.scoped);

/** Stable per-sound seed, so noise-driven timbres stay byte-reproducible. */
function seedFor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

const command = Command.make("generate-notification-sounds", {}, () => generate).pipe(
  Command.withDescription(
    "Render the generated agent-notification sound set into apps/web/public/sounds/.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
