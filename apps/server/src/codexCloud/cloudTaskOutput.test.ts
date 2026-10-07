import { describe, expect, it } from "vite-plus/test";
import { cloudSubmissionReference, validateControllerOrigin } from "./cloudTaskOutput.ts";

describe("cloud command output", () => {
  it("accepts official task links while rejecting lookalike URLs", () => {
    expect(cloudSubmissionReference("Created https://chatgpt.com/codex/tasks/task_123\n")).toEqual({
      taskId: "task_123",
      url: "https://chatgpt.com/codex/tasks/task_123",
    });
    expect(cloudSubmissionReference("https://chatgpt.com/codex/tasks/task_123?x=1")).toEqual({
      taskId: "task_123",
      url: "https://chatgpt.com/codex/tasks/task_123",
    });
    for (const url of [
      "https://chatgpt.com.evil/codex/tasks/task",
      "https://chatgpt.com/codex/tasks/task/extra",
      "http://chatgpt.com/codex/tasks/task",
      "Unexpected response",
    ])
      expect(cloudSubmissionReference(url)).toBeNull();
  });
  it("requires HTTPS remote origins and allows loopback fixtures", () => {
    expect(validateControllerOrigin("https://controller.tailnet.ts.net/")).toBe(
      "https://controller.tailnet.ts.net",
    );
    expect(validateControllerOrigin("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
    for (const url of [
      "http://100.97.72.64",
      "https://user:secret@host",
      "https://host/path",
      "https://host/?token=value",
      "file:///tmp/worker",
      "https://host/#token",
    ])
      expect(validateControllerOrigin(url)).toBeNull();
  });
});
