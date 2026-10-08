import { it, expect } from "@effect/vitest";
import type { MessageBoxOptions, Session, WebContents } from "electron";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({ dialog: {} }));
import { ElectronDialog } from "../electron/ElectronDialog.ts";
import * as MicrophonePermission from "./MicrophonePermission.ts";

const origin = "http://127.0.0.1:5274";
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-preview-microphone-" });
  let page = `${origin}/recorder`;
  const destroyed = vi.fn(() => false);
  const contents = { getURL: () => page, isDestroyed: destroyed } as unknown as WebContents;
  const prompt = vi.fn(async (_options: MessageBoxOptions) => ({
    response: 0,
    checkboxChecked: false,
  }));
  const dialogLayer = Layer.succeed(ElectronDialog, {
    showMessageBox: (options) => Effect.promise(() => prompt(options)),
    pickFolder: vi.fn(),
    pickFiles: vi.fn(),
    showErrorBox: vi.fn(),
  });
  const create = (storagePath: string | null = directory) =>
    Effect.gen(function* () {
      const requestSetter = vi.fn<Session["setPermissionRequestHandler"]>();
      const checkSetter = vi.fn<Session["setPermissionCheckHandler"]>();
      const session = {
        storagePath,
        setPermissionRequestHandler: requestSetter,
        setPermissionCheckHandler: checkSetter,
      } as unknown as Session;
      const policy = yield* MicrophonePermission.make(session, new Set(["clipboard-read"])).pipe(
        Effect.provide(dialogLayer),
      );
      const request = requestSetter.mock.calls[0]![0]!;
      const check = checkSetter.mock.calls[0]![0]!;
      const ask = (
        details: Electron.MediaAccessPermissionRequest = {
          isMainFrame: true,
          requestingUrl: page,
          mediaTypes: ["audio"],
          securityOrigin: origin,
        },
      ) => new Promise<boolean>((resolve) => request(contents, "media", resolve, details));
      const audioCheck = () =>
        check(contents, "media", origin, { isMainFrame: true, mediaType: "audio" });
      return { policy, request, check, ask, audioCheck };
    });
  return {
    fs,
    path,
    directory,
    create,
    prompt,
    contents,
    destroyed,
    navigate: (url: string) => {
      page = url;
    },
  };
});

it.effect("remembers Allow and Deny across recreation in both handlers", () =>
  Effect.gen(function* () {
    const { create, prompt } = yield* fixture;
    const first = yield* create();
    expect(first.audioCheck()).toBe(false);
    expect(yield* Effect.promise(() => first.ask())).toBe(true);
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        message: `${origin} wants to use your microphone.`,
        buttons: ["Allow microphone", "Deny"],
        defaultId: 1,
      }),
    );
    const reopened = yield* create();
    expect(reopened.audioCheck()).toBe(true);
    expect(yield* Effect.promise(() => reopened.ask())).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
    yield* first.policy.clear;
    prompt.mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(yield* Effect.promise(() => first.ask())).toBe(false);
    const denied = yield* create();
    expect(denied.audioCheck()).toBe(false);
    expect(yield* Effect.promise(() => denied.ask())).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("never grants camera, mixed media, another origin, or a subframe", () =>
  Effect.gen(function* () {
    const { create, prompt, contents } = yield* fixture;
    const { ask, check } = yield* create();
    expect(yield* Effect.promise(() => ask())).toBe(true);
    for (const mediaTypes of [["video"], ["audio", "video"], [], undefined] as const) {
      expect(
        yield* Effect.promise(() =>
          ask({
            isMainFrame: true,
            requestingUrl: origin,
            ...(mediaTypes ? { mediaTypes: [...mediaTypes] } : {}),
          }),
        ),
      ).toBe(false);
    }
    expect(
      yield* Effect.promise(() =>
        ask({ isMainFrame: false, requestingUrl: origin, mediaTypes: ["audio"] }),
      ),
    ).toBe(false);
    for (const requestingUrl of [
      "http://127.0.0.1:5275/",
      "http://localhost:5274/",
      "https://example.com/",
      "invalid",
    ]) {
      expect(
        yield* Effect.promise(() =>
          ask({ isMainFrame: true, requestingUrl, mediaTypes: ["audio"] }),
        ),
      ).toBe(false);
      expect(
        check(contents, "media", requestingUrl, { isMainFrame: true, mediaType: "audio" }),
      ).toBe(false);
    }
    for (const mediaType of ["video", "unknown", undefined] as const) {
      expect(
        check(contents, "media", origin, {
          isMainFrame: true,
          ...(mediaType ? { mediaType } : {}),
        }),
      ).toBe(false);
    }
    expect(check(null, "media", origin, { isMainFrame: true, mediaType: "audio" })).toBe(false);
    expect(check(contents, "media", origin, { isMainFrame: false, mediaType: "audio" })).toBe(
      false,
    );
    expect(
      check(contents, "media", origin, {
        isMainFrame: true,
        mediaType: "audio",
        securityOrigin: "https://example.com",
      }),
    ).toBe(false);
    expect(
      check(contents, "media", origin, {
        isMainFrame: true,
        mediaType: "audio",
        requestingUrl: "https://example.com",
      }),
    ).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("coalesces prompts and rejects navigation while permission is pending", () =>
  Effect.gen(function* () {
    const { create, prompt, navigate, fs, path, directory } = yield* fixture;
    let resolve!: (value: { response: number; checkboxChecked: boolean }) => void;
    prompt.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { ask } = yield* create();
    const first = ask();
    const second = ask();
    expect(prompt).toHaveBeenCalledTimes(1);
    navigate("https://example.com/");
    resolve({ response: 0, checkboxChecked: false });
    expect(yield* Effect.promise(() => first)).toBe(false);
    expect(yield* Effect.promise(() => second)).toBe(false);
    expect(yield* fs.exists(path.join(directory, "t3code-microphone-permission.json"))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps incognito choices in memory and isolates persistent browser profiles", () =>
  Effect.gen(function* () {
    const { create, prompt, path, directory } = yield* fixture;
    const ephemeral = yield* create(null);
    expect(yield* Effect.promise(() => ephemeral.ask())).toBe(true);
    expect((yield* create(null)).audioCheck()).toBe(false);
    const first = yield* create();
    expect(yield* Effect.promise(() => first.ask())).toBe(true);
    const other = yield* create(path.join(directory, "other-profile"));
    expect(other.audioCheck()).toBe(false);
    prompt.mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(yield* Effect.promise(() => other.ask())).toBe(false);
    expect((yield* create()).audioCheck()).toBe(true);
    yield* first.policy.clear;
    expect(first.audioCheck()).toBe(false);
    expect((yield* create()).audioCheck()).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not restore a choice after clearing site data during the prompt", () =>
  Effect.gen(function* () {
    const { create, prompt } = yield* fixture;
    let resolve!: (value: { response: number; checkboxChecked: boolean }) => void;
    prompt.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { ask, policy, audioCheck } = yield* create();
    const pending = ask();
    yield* policy.clear;
    resolve({ response: 0, checkboxChecked: false });
    expect(yield* Effect.promise(() => pending)).toBe(false);
    expect(audioCheck()).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ignores invalid saved choices and preserves the unrelated permission policy", () =>
  Effect.gen(function* () {
    const { create, fs, path, directory, contents } = yield* fixture;
    yield* fs.writeFileString(
      path.join(directory, "t3code-microphone-permission.json"),
      '{"origin":"https://example.com","allowed":true}',
    );
    const { ask, check, request, audioCheck } = yield* create();
    expect(audioCheck()).toBe(false);
    expect(yield* Effect.promise(() => ask())).toBe(true);
    const callback = vi.fn();
    request(contents, "clipboard-read", callback, { isMainFrame: true, requestingUrl: origin });
    expect(callback).toHaveBeenCalledWith(true);
    expect(check(contents, "clipboard-read", origin, { isMainFrame: true })).toBe(true);
    expect(check(contents, "display-capture", origin, { isMainFrame: true })).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails closed if persistence fails or the page was destroyed", () =>
  Effect.gen(function* () {
    const { create, fs, path, directory, destroyed, prompt } = yield* fixture;
    const invalidDirectory = path.join(directory, "not-a-directory");
    yield* fs.writeFileString(invalidDirectory, "fixture");
    const { ask, audioCheck } = yield* create(invalidDirectory);
    expect(yield* Effect.promise(() => ask())).toBe(false);
    expect(audioCheck()).toBe(false);
    const valid = yield* create();
    destroyed.mockReturnValue(true);
    expect(yield* Effect.promise(() => valid.ask())).toBe(false);
    expect(prompt).toHaveBeenCalledTimes(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
