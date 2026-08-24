import { expect, it } from "@effect/vitest";
import type { VcsListRefsResult } from "@t3tools/contracts";

import {
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
