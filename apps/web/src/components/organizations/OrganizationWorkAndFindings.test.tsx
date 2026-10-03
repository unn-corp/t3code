import type { OrganizationWorkAttempt, OrganizationWorkDetail } from "@t3tools/contracts";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ReviewEvidence } from "./OrganizationWorkAndFindings";

const mocked = vi.hoisted(() => ({
  reviewComplete: false,
  decide: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  refresh: vi.fn(),
}));

vi.mock("../../state/environments", () => ({ usePrimaryEnvironmentId: () => "environment" }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      workId: "work",
      attemptId: "attempt",
      projectId: "project",
      projectRootDigest: "d".repeat(64),
      artifact: {
        digest: "a".repeat(64),
        ref: "artifact",
        baseCodeRevision: "b".repeat(40),
        relativePath: "fixture.mjs",
        replacementPreview: "export const fixed = true;",
        replacementBytes: 26,
        previewTruncated: false,
        reviewComplete: mocked.reviewComplete,
        outcome: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          outputLimitExceeded: false,
          resourceLimitExceeded: false,
        },
      },
      qa: {
        accepted: true,
        receiptDigest: "c".repeat(64),
        reviewerSubject: "qa",
        evidenceRef: "qa-ref",
        evidencePreview: "checks passed",
        evidenceBytes: 13,
        previewTruncated: false,
      },
      approval: null,
    },
    error: null,
    isPending: false,
    refresh: mocked.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocked.decide }));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));

const work = {
  id: "work",
  organizationId: "organization",
  status: "waiting-approval",
  codeRevision: "b".repeat(40),
  bindingVersion: "2026-09-26T00:00:00.000Z",
} as OrganizationWorkDetail["work"];
const attempt = {
  id: "attempt",
  workId: "work",
  status: "qa-accepted",
} as OrganizationWorkAttempt;

let renderer: ReactTestRenderer | null = null;
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  renderer = null;
  mocked.reviewComplete = false;
  mocked.decide.mockClear();
  mocked.refresh.mockClear();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  renderer!.root
    .findAllByType("button")
    .find((element) => element.children.join("").includes(label));

it("only approves a complete reviewed artifact and pins the displayed receipt digests", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const onDecision = vi.fn();
  await act(() => {
    renderer = create(
      <ReviewEvidence work={work} attempt={attempt} offline={false} onDecision={onDecision} />,
    );
  });
  expect(button("Approve exact artifact")?.props.disabled).toBe(true);
  await act(() =>
    renderer!.root.findByType("textarea").props.onChange({ target: { value: "Reviewed fix" } }),
  );
  expect(button("Approve exact artifact")?.props.disabled).toBe(true);
  expect(button("Reject artifact")?.props.disabled).toBe(false);

  mocked.reviewComplete = true;
  await act(() =>
    renderer!.update(
      <ReviewEvidence work={work} attempt={attempt} offline={false} onDecision={onDecision} />,
    ),
  );
  expect(button("Approve exact artifact")?.props.disabled).toBe(false);
  await act(async () => button("Approve exact artifact")?.props.onClick());
  expect(mocked.decide).toHaveBeenCalledTimes(1);
  expect((mocked.decide.mock.calls[0]![0] as { input: unknown }).input).toMatchObject({
    organizationId: "organization",
    workId: "work",
    attemptId: "attempt",
    approved: true,
    reason: "Reviewed fix",
    artifactDigest: "a".repeat(64),
    qaReceiptDigest: "c".repeat(64),
    projectRootDigest: "d".repeat(64),
    baseCodeRevision: "b".repeat(40),
    bindingVersion: "2026-09-26T00:00:00.000Z",
  });
  expect(onDecision).toHaveBeenCalledTimes(1);
});
