import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makeTeamInvitationDelivery } from "./TeamInvitationDelivery.ts";

const api = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  getInvitationList: vi.fn(),
  revokeInvitation: vi.fn(),
}));
vi.mock("@clerk/backend", () => ({ createClerkClient: () => ({ invitations: api }) }));

it.effect("sends a seven-day email with correlation metadata, never a team bearer token", () =>
  Effect.gen(function* () {
    api.createInvitation.mockResolvedValue({ id: "clerk-id" });
    yield* makeTeamInvitationDelivery("fixture").send("local-id", "member@example.test");
    expect(api.createInvitation).toHaveBeenLastCalledWith({
      emailAddress: "member@example.test",
      expiresInDays: 7,
      ignoreExisting: true,
      notify: true,
      publicMetadata: { t3TeamInviteId: "local-id" },
    });
    api.createInvitation.mockRejectedValue(new Error("secret provider error"));
    const error = yield* Effect.flip(
      makeTeamInvitationDelivery("fixture").send("id", "member@example.test"),
    );
    expect(error.reason).toBe("invitation_email_failed_cancel_or_retry");
    expect(String(error)).not.toContain("secret provider error");
  }),
);

it.effect("revokes only exact matching emails and correlation IDs across all pages", () =>
  Effect.gen(function* () {
    api.revokeInvitation.mockReset().mockResolvedValue({});
    api.getInvitationList
      .mockReset()
      .mockResolvedValueOnce({
        totalCount: 101,
        data: [
          {
            id: "match",
            emailAddress: "member@example.test",
            publicMetadata: { t3TeamInviteId: "local-id" },
          },
          {
            id: "unrelated",
            emailAddress: "member@example.test",
            publicMetadata: { t3TeamInviteId: "other-id" },
          },
          {
            id: "substring",
            emailAddress: "othermember@example.test",
            publicMetadata: { t3TeamInviteId: "local-id" },
          },
        ],
      })
      .mockResolvedValueOnce({
        totalCount: 101,
        data: [
          {
            id: "lost-response",
            emailAddress: "member@example.test",
            publicMetadata: { t3TeamInviteId: "local-id" },
          },
        ],
      });
    yield* makeTeamInvitationDelivery("fixture").revoke("local-id", "member@example.test");
    expect(api.revokeInvitation.mock.calls).toEqual([["match"], ["lost-response"]]);
    expect(api.getInvitationList.mock.calls[1]?.[0]).toEqual({
      query: "member@example.test",
      status: "pending",
      limit: 100,
      offset: 100,
    });
  }),
);

it.effect("stops revocation after a bounded number of pages", () =>
  Effect.gen(function* () {
    api.revokeInvitation.mockReset();
    api.getInvitationList.mockReset().mockResolvedValue({
      totalCount: 10_000,
      data: Array.from({ length: 100 }, (_, index) => ({
        id: `page-${index}`,
        emailAddress: "member@example.test",
        publicMetadata: { t3TeamInviteId: "other-id" },
      })),
    });
    const error = yield* Effect.flip(
      makeTeamInvitationDelivery("fixture").revoke("local-id", "member@example.test"),
    );
    expect(error.reason).toBe("invitation_cancel_failed_retry");
    expect(api.getInvitationList).toHaveBeenCalledTimes(20);
    expect(api.revokeInvitation).not.toHaveBeenCalled();
  }),
);

it.effect("fails a send that does not finish within 10 seconds", () =>
  Effect.gen(function* () {
    api.createInvitation.mockReset().mockImplementation(() => new Promise(() => undefined));
    const fiber = yield* makeTeamInvitationDelivery("fixture")
      .send("local-id", "member@example.test")
      .pipe(Effect.flip, Effect.forkChild);
    yield* TestClock.adjust("10 seconds");
    const error = yield* Fiber.join(fiber);
    expect(error.reason).toBe("invitation_email_failed_cancel_or_retry");
  }),
);
