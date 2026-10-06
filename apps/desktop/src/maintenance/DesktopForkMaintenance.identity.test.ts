import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readCommit } from "./DesktopForkMaintenance.ts";

it.effect("reads the packaged commit through Electron's filesystem provider for asar paths", () => {
  const packagePath = "/opt/T3 Code/resources/app.asar/package.json";
  const expectedCommit = "a".repeat(40);
  const readPaths: Array<string> = [];
  return readCommit(packagePath, undefined, (path) => {
    readPaths.push(path);
    return Effect.succeed(JSON.stringify({ t3codeCommitHash: expectedCommit }));
  }).pipe(
    Effect.tap((actual) =>
      Effect.sync(() => {
        assert.equal(actual, expectedCommit);
        assert.deepEqual(readPaths, [packagePath]);
      }),
    ),
  );
});

it.effect("prefers a valid runtime commit override without reading packaged metadata", () => {
  let readCount = 0;
  return readCommit("/opt/T3 Code/resources/app.asar/package.json", "B".repeat(40), () => {
    readCount += 1;
    return Effect.succeed("{}");
  }).pipe(
    Effect.tap((actual) =>
      Effect.sync(() => {
        assert.equal(actual, "b".repeat(40));
        assert.equal(readCount, 0);
      }),
    ),
  );
});

it.effect("treats missing or malformed packaged metadata as an unknown commit", () =>
  Effect.all([
    readCommit("/opt/T3 Code/resources/app.asar/package.json", undefined, () =>
      Effect.succeed("not json"),
    ),
    readCommit("/opt/T3 Code/resources/app.asar/package.json", undefined, () =>
      Effect.succeed("{}"),
    ),
    readCommit("/opt/T3 Code/resources/app.asar/package.json", undefined, () =>
      Effect.succeed(JSON.stringify({ t3codeCommitHash: "short" })),
    ),
  ]).pipe(Effect.tap((values) => Effect.sync(() => assert.deepEqual(values, [null, null, null])))),
);
