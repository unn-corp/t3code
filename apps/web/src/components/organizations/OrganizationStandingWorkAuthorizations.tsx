import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { Organization } from "@t3tools/contracts";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { organizationEnvironment } from "../../state/organizations";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Card, CardPanel } from "../ui/card";

export function OrganizationStandingWorkAuthorizations({
  organization,
  offline,
}: {
  readonly organization: Organization;
  readonly offline: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const grants = useEnvironmentQuery(
    environmentId === null
      ? null
      : organizationEnvironment.listStandingWorkAuthorizations({
          environmentId,
          input: { organizationId: organization.id },
        }),
  );
  const revoke = useAtomCommand(organizationEnvironment.revokeStandingWorkAuthorization, {
    reportFailure: false,
  });
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revokeGrant(
    authorizationId: NonNullable<typeof grants.data>["authorizations"][number]["id"],
  ) {
    if (offline || environmentId === null || revokingId !== null) return;
    setRevokingId(authorizationId);
    setError(null);
    try {
      const result = await revoke({
        environmentId,
        input: { organizationId: organization.id, authorizationId },
      });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : String(cause));
      } else {
        grants.refresh();
      }
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <Card>
      <CardPanel className="space-y-3 p-5">
        <h2 className="text-lg font-semibold">Automatic Project work</h2>
        <p className="text-sm text-muted-foreground">
          A grant starts matching work from one HTTP source while its exact published configuration
          remains valid. Each Git integration still requires your approval.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {error}
          </p>
        ) : null}
        {grants.error ? (
          <p role="status" className="text-sm">
            Grants could not be loaded: {grants.error}
          </p>
        ) : null}
        {grants.data?.authorizations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No automatic work grants. Open a waiting intent in Live Operations to authorize one.
          </p>
        ) : null}
        {grants.data?.authorizations.map((grant) => {
          const status =
            grant.revokedAt !== null
              ? grant.revocationReason === "expired"
                ? "Expired"
                : grant.revocationReason === "exhausted"
                  ? "Used"
                  : "Revoked"
              : Date.parse(grant.expiresAt) <= Date.now()
                ? "Expired"
                : grant.usedActivations >= grant.maxActivations
                  ? "Used"
                  : "Active";
          return (
            <div key={grant.id} className="space-y-2 rounded-lg border border-border p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>{status}</strong>
                {status === "Active" ? (
                  <Button
                    variant="outline"
                    disabled={offline || revokingId !== null}
                    onClick={() => void revokeGrant(grant.id)}
                  >
                    {revokingId === grant.id ? "Revoking…" : "Revoke"}
                  </Button>
                ) : null}
              </div>
              <p className="break-all">
                Project {grant.projectId}; source {grant.sourceId}
              </p>
              <p className="break-all">
                {grant.selection.fileName} on {grant.selection.targetRef}
              </p>
              <p className="text-muted-foreground">
                {grant.usedActivations} of {grant.maxActivations} starts used. Expires{" "}
                {new Date(grant.expiresAt).toLocaleString()}.
              </p>
            </div>
          );
        })}
      </CardPanel>
    </Card>
  );
}
