/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

class WorkspaceReadFileResolvedOutsideRootError extends Schema.TaggedErrorClass<WorkspaceReadFileResolvedOutsideRootError>()(
  "WorkspaceReadFileResolvedOutsideRootError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
    realWorkspaceRoot: Schema.String,
    realTargetPath: Schema.String,
  },
) {
  override get message(): string {
    return "Workspace file path resolves outside the project root.";
  }
}

class WorkspaceReadFileNotFileError extends Schema.TaggedErrorClass<WorkspaceReadFileNotFileError>()(
  "WorkspaceReadFileNotFileError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
    fileType: Schema.String,
  },
) {
  override get message(): string {
    return "Workspace path is not a file.";
  }
}

class WorkspaceReadFileBinaryFileError extends Schema.TaggedErrorClass<WorkspaceReadFileBinaryFileError>()(
  "WorkspaceReadFileBinaryFileError",
  {
    cwd: Schema.String,
    relativePath: Schema.String,
    nulByteOffset: Schema.Number,
  },
) {
  override get message(): string {
    return "Binary files cannot be previewed as text.";
  }
}

export class WorkspaceFileSystemError extends Schema.TaggedErrorClass<WorkspaceFileSystemError>()(
  "WorkspaceFileSystemError",
  {
    cwd: Schema.String,
    relativePath: Schema.optional(Schema.String),
    operation: Schema.Literals([
      "workspaceFileSystem.readFile",
      "workspaceFileSystem.makeDirectory",
      "workspaceFileSystem.writeFile",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const target = this.relativePath ? `'${this.relativePath}' in '${this.cwd}'` : `'${this.cwd}'`;
    return `Workspace file operation '${this.operation}' failed for ${target}.`;
  }
}

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const [realWorkspaceRoot, realTargetPath] = yield* Effect.all([
          fileSystem.realPath(input.cwd),
          fileSystem.realPath(target.absolutePath),
        ]);
        const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
        if (
          relativeRealPath.startsWith(`..${path.sep}`) ||
          relativeRealPath === ".." ||
          path.isAbsolute(relativeRealPath)
        ) {
          return yield* Effect.fail(
            new WorkspaceReadFileResolvedOutsideRootError({
              cwd: input.cwd,
              relativePath: target.relativePath,
              realWorkspaceRoot,
              realTargetPath,
            }),
          );
        }

        const handle = yield* fileSystem.open(realTargetPath, { flag: "r" });
        const stat = yield* handle.stat;
        if (stat.type !== "File") {
          return yield* Effect.fail(
            new WorkspaceReadFileNotFileError({
              cwd: input.cwd,
              relativePath: target.relativePath,
              fileType: stat.type,
            }),
          );
        }
        const byteLength = Number(stat.size);
        const bytesToRead = Math.min(byteLength, PROJECT_READ_FILE_MAX_BYTES);
        const buffer = new Uint8Array(bytesToRead);
        const bytesRead = yield* handle.read(buffer);
        const fileBytes = buffer.subarray(0, Number(bytesRead));
        const nulByteOffset = fileBytes.indexOf(0);
        if (nulByteOffset !== -1) {
          return yield* Effect.fail(
            new WorkspaceReadFileBinaryFileError({
              cwd: input.cwd,
              relativePath: target.relativePath,
              nulByteOffset,
            }),
          );
        }
        const contents = new TextDecoder("utf-8").decode(fileBytes);
        return {
          relativePath: target.relativePath,
          contents,
          byteLength,
          truncated: stat.size > BigInt(PROJECT_READ_FILE_MAX_BYTES),
        };
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile",
            cause,
          }),
      ),
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ readFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
