import type { OrganizationIntakeResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  ORGANIZATION_INTAKE_CORRELATION_SUBJECT,
  type OrganizationCorrelationCoordinatorShape,
} from "./OrganizationCorrelationCoordinator.ts";
import type { OrganizationCorrelationRecoveryShape } from "./OrganizationCorrelationRecovery.ts";

/** Correlation is advisory. Intake remains saved if the correlation pass fails. */
export const correlateRecordedIntake = (
  coordinator: OrganizationCorrelationCoordinatorShape,
  intake: OrganizationIntakeResult,
  recovery?: OrganizationCorrelationRecoveryShape,
  retryRequested = false,
): Effect.Effect<OrganizationIntakeResult> =>
  intake.outcome === "duplicate" && !retryRequested
    ? Effect.succeed(intake)
    : coordinator
        .onObservation(intake.observation, {
          subject: ORGANIZATION_INTAKE_CORRELATION_SUBJECT,
        })
        .pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              if (recovery) yield* recovery.markFromResult(intake.observation.id, result);
              return {
                ...intake,
                correlation: {
                  outcome: result.outcome,
                  findingId: result.finding?.id ?? null,
                  reason: result.reason,
                },
              } satisfies OrganizationIntakeResult;
            }),
          ),
          Effect.catch(() =>
            Effect.succeed({
              ...intake,
              correlation: { outcome: "unavailable" as const, findingId: null, reason: null },
            }),
          ),
        );
