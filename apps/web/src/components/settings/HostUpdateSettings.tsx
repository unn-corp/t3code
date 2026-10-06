import type { EnvironmentId } from "@t3tools/contracts";
import { hostForkUpdateController } from "../../state/hostForkUpdates";
import { ForkUpdateControls } from "./ForkUpdateControls";
export function HostUpdateSettings({
  environmentId,
  label,
  supported,
}: {
  environmentId: EnvironmentId;
  label: string;
  supported: boolean;
}) {
  if (!supported)
    return (
      <p className="py-2 text-xs text-muted-foreground">
        {label}: safe in-product updates require the fork updater baseline. Use the stopped-work
        bootstrap procedure.
      </p>
    );
  return (
    <div className="mt-2 rounded-lg border">
      <ForkUpdateControls
        controller={hostForkUpdateController(environmentId)}
        device={label}
        environmentId={environmentId}
      />
    </div>
  );
}
