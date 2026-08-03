import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { stableStringify } from "@t3tools/shared/relaySigning";

const MAX_JOB_AGE_MS = 10 * 60 * 1_000;
export const WEB_PUSH_DELIVERY_JOB_SIGNING_ALGORITHM = "hmac-sha256";

export const WebPushDeliveryPayload = Schema.Struct({
  version: Schema.Literal(1),
  jobId: Schema.String,
  userId: Schema.String,
  subscriptionId: Schema.String,
  eventId: Schema.String,
  deepLink: Schema.String,
  showProjectAndThreadNames: Schema.Boolean,
  title: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  expiresAt: Schema.String,
});
export type WebPushDeliveryPayload = typeof WebPushDeliveryPayload.Type;

export const SignedWebPushDeliveryJob = Schema.Struct({
  algorithm: Schema.Literal(WEB_PUSH_DELIVERY_JOB_SIGNING_ALGORITHM),
  payload: WebPushDeliveryPayload,
  signature: Schema.String,
});
export type SignedWebPushDeliveryJob = typeof SignedWebPushDeliveryJob.Type;

function signatureForPayload(secret: Redacted.Redacted<string>, payload: WebPushDeliveryPayload) {
  return NodeCrypto.createHmac("sha256", Redacted.value(secret))
    .update(stableStringify(payload))
    .digest("base64url");
}

export function signWebPushDeliveryJob(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly payload: WebPushDeliveryPayload;
}): SignedWebPushDeliveryJob {
  return {
    algorithm: WEB_PUSH_DELIVERY_JOB_SIGNING_ALGORITHM,
    payload: input.payload,
    signature: signatureForPayload(input.secret, input.payload),
  };
}

export function verifyWebPushDeliveryJob(input: {
  readonly secret: Redacted.Redacted<string>;
  readonly job: SignedWebPushDeliveryJob;
  readonly nowMs: number;
}): WebPushDeliveryPayload | null {
  const expected = signatureForPayload(input.secret, input.job.payload);
  const received = Buffer.from(input.job.signature, "base64url");
  const expectedBuffer = Buffer.from(expected, "base64url");
  if (
    received.length !== expectedBuffer.length ||
    !NodeCrypto.timingSafeEqual(received, expectedBuffer)
  )
    return null;
  const createdAt = DateTime.make(input.job.payload.createdAt);
  const expiresAt = DateTime.make(input.job.payload.expiresAt);
  if (Option.isNone(createdAt) || Option.isNone(expiresAt)) return null;
  if (
    expiresAt.value.epochMilliseconds <= createdAt.value.epochMilliseconds ||
    expiresAt.value.epochMilliseconds - createdAt.value.epochMilliseconds > MAX_JOB_AGE_MS ||
    expiresAt.value.epochMilliseconds <= input.nowMs
  ) {
    return null;
  }
  return input.job.payload;
}

export function expiresAtForWebPushJob(createdAtMs: number): string {
  return DateTime.formatIso(Option.getOrThrow(DateTime.make(createdAtMs + MAX_JOB_AGE_MS)));
}
