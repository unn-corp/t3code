import { expect, it } from "vite-plus/test";
import { codexCloudEnvironmentId } from "./codexCloud.ts";

it("accepts explicit cloud IDs and official environment links", () => {
  expect(codexCloudEnvironmentId(" env_fixture ")).toBe("env_fixture");
  expect(
    codexCloudEnvironmentId("https://chatgpt.com/codex/settings/environments/env_fixture"),
  ).toBe("env_fixture");
  expect(codexCloudEnvironmentId("https://chatgpt.com/codex/environments/env_fixture/")).toBe(
    "env_fixture",
  );
  for (const input of [
    "unn-corp/Squidhub",
    "https://chatgpt.com.evil/codex/environments/id",
    "https://secret@chatgpt.com/codex/environments/id",
    "https://chatgpt.com/codex/tasks/task_123",
    "https://chatgpt.com/codex/settings/environments",
    "http://chatgpt.com/codex/environments/id",
  ])
    expect(codexCloudEnvironmentId(input)).toBeNull();
});
