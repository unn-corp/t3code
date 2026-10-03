import { OrganizationArchitectMessageId, TextGenerationError } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  architectGenerationFailureMessage,
  completedArchitectTranscript,
} from "./OrganizationArchitectContext.ts";

it("keeps completed design turns while dropping failed replies and the current request", () => {
  const current = OrganizationArchitectMessageId.make("current");
  const completed = OrganizationArchitectMessageId.make("completed");
  const failed = OrganizationArchitectMessageId.make("failed");
  const conversation = {
    requests: [
      { requestId: completed, status: "completed" },
      { requestId: failed, status: "failed" },
      { requestId: current, status: "pending" },
    ],
    messages: [
      { requestId: completed, role: "user", text: "Design a full organization" },
      { requestId: completed, role: "architect", text: "I suggest specialist roles." },
      { requestId: failed, role: "user", text: "Select reasonable roles." },
      { requestId: failed, role: "architect", text: "The Architect failed." },
      { requestId: current, role: "user", text: "Are you there?" },
    ],
  } as const;

  expect(completedArchitectTranscript(conversation, current)).toEqual([
    { role: "user", text: "Design a full organization" },
    { role: "assistant", text: "I suggest specialist roles." },
  ]);
});

it("provides useful failure categories without exposing provider output", () => {
  const error = new TextGenerationError({
    operation: "generateOrganizationArchitectTurn",
    detail: "Codex CLI command failed: token=privatevalue",
  });
  const message = architectGenerationFailureMessage(error);
  expect(message).toContain("selected Architect provider failed");
  expect(message).not.toContain("privatevalue");
});
