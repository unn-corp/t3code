import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { TeamSpaces } from "./TeamSpaces.ts";
import type { TeamIdentity } from "@t3tools/contracts/teamSpaces";

const identity = (userId: string, verifiedEmails: string[] = []): TeamIdentity => ({
  userId,
  verifiedEmails,
  expiresAt: 1e12,
});
const owner = identity("owner");
const team = identity("member", ["member@example.com"]);
const testLayer = TeamSpaces.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const create = (service: TeamSpaces["Service"], name = "Shared") =>
  service.execute(owner, { action: "create", name }, true);
const invite = (
  service: TeamSpaces["Service"],
  spaceId: string,
  role: "contributor" | "viewer" = "contributor",
) => service.execute(owner, { action: "invite", spaceId, email: "Member@Example.com", role });

it.effect("snapshots retain recent activity after the history exceeds one page", () =>
  Effect.gen(function* () {
    const service = yield* TeamSpaces;
    const { spaceId } = yield* create(service);
    for (let index = 0; index < 205; index++)
      yield* service.recordActivity(spaceId, owner.userId, "message", `Activity ${index}`);
    const recent = yield* service.snapshot(owner.userId, spaceId);
    expect(recent.events).toHaveLength(200);
    expect(recent.events[0]?.text).toBe("Activity 5");
    expect(recent.events.at(-1)?.text).toBe("Activity 204");
    const incremental = yield* service.snapshot(
      owner.userId,
      spaceId,
      recent.events.at(-2)!.sequence,
    );
    expect(incremental.events.map((event) => event.text)).toEqual(["Activity 204"]);
    expect((yield* Effect.flip(create(service, "   "))).reason).toBe("project_name_invalid");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("members can access only their invited project and viewers cannot write", () =>
  Effect.gen(function* () {
    const service = yield* TeamSpaces;
    const one = yield* create(service, "One");
    const two = yield* create(service, "Two");
    const invitation = yield* invite(service, one.spaceId, "viewer");
    yield* service.execute(team, { action: "accept", token: invitation.token! });
    expect((yield* service.list(team.userId)).map((space) => space.id)).toEqual([one.spaceId]);
    expect((yield* Effect.flip(service.snapshot(team.userId, two.spaceId)))._tag).toBe(
      "TeamDenied",
    );
    expect(
      (yield* Effect.flip(
        service.execute(team, { action: "message", spaceId: one.spaceId, text: "No" }),
      ))._tag,
    ).toBe("TeamDenied");
    expect((yield* service.snapshot(team.userId, one.spaceId)).invites).toEqual([]);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "invites require the verified email, are single use, hashed, expire, and can be cancelled",
  () =>
    Effect.gen(function* () {
      const service = yield* TeamSpaces;
      const sql = yield* SqlClient.SqlClient;
      const { spaceId } = yield* create(service);
      const invitation = yield* invite(service, spaceId);
      const token = invitation.token!;
      expect(
        (yield* Effect.flip(service.execute(identity("unverified"), { action: "accept", token })))
          ._tag,
      ).toBe("TeamDenied");
      const rows = yield* sql<{ token_hash: string }>`SELECT token_hash FROM team_invites`;
      expect(rows[0]?.token_hash).not.toEqual(token);
      yield* service.execute(team, { action: "accept", token });
      expect((yield* Effect.flip(service.execute(team, { action: "accept", token })))._tag).toBe(
        "TeamDenied",
      );
      const cancelled = yield* invite(service, spaceId);
      yield* service.execute(owner, {
        action: "cancelInvite",
        spaceId,
        inviteId: cancelled.inviteId!,
      });
      expect(
        (yield* Effect.flip(service.execute(team, { action: "accept", token: cancelled.token! })))
          ._tag,
      ).toBe("TeamDenied");
      const expired = yield* invite(service, spaceId);
      yield* TestClock.adjust("8 days");
      expect(
        (yield* Effect.flip(service.execute(team, { action: "accept", token: expired.token! })))
          ._tag,
      ).toBe("TeamDenied");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("role changes take effect immediately and last owner cannot be removed", () =>
  Effect.gen(function* () {
    const service = yield* TeamSpaces;
    const { spaceId } = yield* create(service);
    const invitation = yield* invite(service, spaceId);
    yield* service.execute(team, { action: "accept", token: invitation.token! });
    yield* service.execute(team, { action: "message", spaceId, text: "Visible activity" });
    yield* service.execute(owner, {
      action: "setRole",
      spaceId,
      userId: team.userId,
      role: "viewer",
    });
    expect(
      (yield* Effect.flip(service.execute(team, { action: "message", spaceId, text: "Denied" })))
        ._tag,
    ).toBe("TeamDenied");
    expect(
      (yield* Effect.flip(
        service.execute(owner, { action: "removeMember", spaceId, userId: owner.userId }),
      ))._tag,
    ).toBe("TeamDenied");
    yield* service.execute(owner, { action: "removeMember", spaceId, userId: team.userId });
    expect((yield* Effect.flip(service.snapshot(team.userId, spaceId)))._tag).toBe("TeamDenied");
    const snapshot = yield* service.snapshot(owner.userId, spaceId);
    expect(
      snapshot.events.some(
        (event) => event.actor === team.userId && event.text === "Visible activity",
      ),
    ).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("a removed member cannot rejoin with an older outstanding invitation", () =>
  Effect.gen(function* () {
    const service = yield* TeamSpaces;
    const { spaceId } = yield* create(service);
    const first = yield* invite(service, spaceId);
    yield* service.execute(team, { action: "accept", token: first.token! });
    const old = yield* invite(service, spaceId);
    yield* service.execute(owner, { action: "removeMember", spaceId, userId: team.userId });
    expect(
      (yield* Effect.flip(service.execute(team, { action: "accept", token: old.token! })))._tag,
    ).toBe("TeamDenied");
    const fresh = yield* invite(service, spaceId);
    yield* service.execute(team, { action: "accept", token: fresh.token! });
    expect((yield* service.snapshot(team.userId, spaceId)).role).toBe("contributor");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("shared snapshots never expose parked cloud runs", () =>
  Effect.gen(function* () {
    const service = yield* TeamSpaces;
    const sql = yield* SqlClient.SqlClient;
    const { spaceId } = yield* create(service);
    yield* sql`INSERT INTO team_runs(run_id,space_id,user_id,provider,state,created_at) VALUES('parked',${spaceId},'owner','codex','running',0)`;
    expect((yield* service.snapshot(owner.userId, spaceId)).runs).toEqual([]);
    expect(yield* sql`SELECT run_id FROM team_runs WHERE run_id='parked'`).toHaveLength(1);
  }).pipe(Effect.provide(testLayer)),
);
