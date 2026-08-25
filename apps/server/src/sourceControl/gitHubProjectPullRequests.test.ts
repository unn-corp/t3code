import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";

import { decodeGitHubProjectPullRequestListJson } from "./gitHubProjectPullRequests.ts";

describe("GitHub project pull request decoding", () => {
  it("normalizes checks, review approval, and merge readiness", () => {
    const decoded = decodeGitHubProjectPullRequestListJson(
      JSON.stringify([
        {
          number: 42,
          title: "Add project PR workspace",
          url: "https://github.com/pingdotgg/t3code/pull/42",
          baseRefName: "main",
          headRefName: "feature/pr-workspace",
          headRefOid: "abcdef123456abcdef123456abcdef123456abcd",
          isDraft: false,
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
          author: { login: "octocat" },
          updatedAt: "2026-08-22T12:00:00.000Z",
        },
      ]),
    );

    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isFailure(decoded)) return;
    assert.deepStrictEqual(decoded.success[0], {
      number: 42,
      title: "Add project PR workspace",
      url: "https://github.com/pingdotgg/t3code/pull/42",
      baseRefName: "main",
      headRefName: "feature/pr-workspace",
      headRefOid: "abcdef123456abcdef123456abcdef123456abcd",
      authorLogin: "octocat",
      isDraft: false,
      mergeState: "ready",
      reviewDecision: "approved",
      checkStatus: "passing",
      canMerge: true,
      mergeBlockedReason: null,
      updatedAt: "2026-08-22T12:00:00.000Z",
    });
  });

  it("blocks drafts and failing checks", () => {
    const decoded = decodeGitHubProjectPullRequestListJson(
      JSON.stringify([
        {
          number: 43,
          title: "Draft change",
          url: "https://github.com/pingdotgg/t3code/pull/43",
          baseRefName: "main",
          headRefName: "feature/draft",
          headRefOid: "123456abcdef123456abcdef123456abcdef1234",
          isDraft: true,
          mergeStateStatus: "DRAFT",
          reviewDecision: "REVIEW_REQUIRED",
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }],
          updatedAt: "2026-08-22T12:00:00.000Z",
        },
      ]),
    );

    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isFailure(decoded)) return;
    assert.isFalse(decoded.success[0]?.canMerge ?? true);
    assert.strictEqual(decoded.success[0]?.checkStatus, "failing");
    assert.strictEqual(
      decoded.success[0]?.mergeBlockedReason,
      "Draft pull requests cannot be merged.",
    );
  });
});
