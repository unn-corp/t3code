import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";

import { signWebPushDeliveryJob, verifyWebPushDeliveryJob } from "./webPushDeliveryJobs.ts";

const secret = Redacted.make("web-push-queue-signing-secret");
const payload = {
  version: 1 as const,
  jobId: "job-1",
  userId: "user-1",
  subscriptionId: "subscription-1",
  eventId: "event-1",
  deepLink: "/threads/environment/thread",
  showProjectAndThreadNames: false,
  title: "T3 Code",
  body: "Agent activity needs your attention.",
  createdAt: "2026-08-02T00:00:00.000Z",
  expiresAt: "2026-08-02T00:05:00.000Z",
};

describe("webPushDeliveryJobs", () => {
  it("accepts a current signed job", () => {
    const signed = signWebPushDeliveryJob({ secret, payload });
    expect(verifyWebPushDeliveryJob({ secret, job: signed, nowMs: 0 })).toEqual(payload);
  });

  it("rejects a tampered or expired job", () => {
    const signed = signWebPushDeliveryJob({ secret, payload });
    expect(
      verifyWebPushDeliveryJob({
        secret,
        job: { ...signed, payload: { ...signed.payload, subscriptionId: "attacker" } },
        nowMs: 0,
      }),
    ).toBeNull();
    expect(
      verifyWebPushDeliveryJob({ secret, job: signed, nowMs: Date.parse(payload.expiresAt) }),
    ).toBeNull();
  });
});
