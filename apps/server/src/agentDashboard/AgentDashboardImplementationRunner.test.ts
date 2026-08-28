import { expect, it } from "@effect/vitest";
import { CommandId, ThreadId, type VcsListRefsResult } from "@t3tools/contracts";

import {
  buildCompletedImplementationWorktreeRemovalInput,
  buildCompletedImplementationCleanupCommands,
  buildAgentDashboardImplementationNudgePrompt,
  defaultBranchFromRefs,
  implementationBaseTargetFromRefs,
} from "./AgentDashboardImplementationRunner.ts";

const refs = {
  refs: [
    {
      name: "origin/main",
      current: false,
      isDefault: true,
      isRemote: true,
      remoteName: "origin",
      worktreePath: null,
    },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
} satisfies VcsListRefsResult;

it("normalizes the remote default ref to the pull request base branch", () => {
  expect(defaultBranchFromRefs(refs)).toBe("main");
});

it("prefers the default branch's configured tracking remote over origin", () => {
  expect(implementationBaseTargetFromRefs(refs, "ssh-origin")).toEqual({
    branch: "main",
    remoteName: "ssh-origin",
  });
});

it("builds a bounded progress prompt that requires the pull request handoff", () => {
  const prompt = buildAgentDashboardImplementationNudgePrompt({
    reason: "missing-pull-request",
    attempt: 2,
    maxAttempts: 3,
  });

  expect(prompt).toContain("Automated progress check 2 of 3");
  expect(prompt).toContain("could not find a pull request");
  expect(prompt).toContain("open the pull request as a draft");
  expect(prompt).toContain("gh pr create --draft");
  expect(prompt).toContain("leave it in draft until a user explicitly marks it ready for review");
  expect(prompt).toContain("clearly report the blocker");
});

it("asks an agent to convert an active pull request instead of opening another one", () => {
  const prompt = buildAgentDashboardImplementationNudgePrompt({
    reason: "pull-request-not-draft",
    attempt: 1,
    maxAttempts: 3,
  });

  expect(prompt).toContain("ready for review instead of draft");
  expect(prompt).toContain("gh pr ready --undo");
  expect(prompt).toContain("Do not create another pull request");
  expect(prompt).not.toContain("gh pr create --draft");
});

it("settles a completed implementation before requesting a race-safe session stop", () => {
  const threadId = ThreadId.make("thread-completed-implementation");
  const commands = buildCompletedImplementationCleanupCommands({
    threadId,
    settleCommandId: CommandId.make("cmd-settle-completed-implementation"),
    stopCommandId: CommandId.make("cmd-stop-completed-implementation"),
    createdAt: "2026-08-23T12:00:00.000Z",
  });

  expect(commands.settle).toEqual({
    type: "thread.settle",
    commandId: "cmd-settle-completed-implementation",
    threadId,
  });
  expect(commands.stop).toEqual({
    type: "thread.session.stop",
    commandId: "cmd-stop-completed-implementation",
    threadId,
    createdAt: "2026-08-23T12:00:00.000Z",
    onlyIfSettled: true,
  });
});

it("removes a completed implementation worktree without forcing dirty changes away", () => {
  expect(
    buildCompletedImplementationWorktreeRemovalInput({
      projectCwd: "/workspace/project",
      worktreePath: "/workspace/.t3/worktrees/project/t3code-f00dcafe",
    }),
  ).toEqual({
    cwd: "/workspace/project",
    path: "/workspace/.t3/worktrees/project/t3code-f00dcafe",
    force: false,
  });
});
