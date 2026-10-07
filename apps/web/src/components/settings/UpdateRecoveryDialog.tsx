import type { ForkRecoveryOption } from "@t3tools/contracts";
import { formatBuildVersion } from "@t3tools/shared/buildVersion";
import { useState } from "react";
import type { ForkUpdateController } from "../../state/forkUpdates";
import { recoveryFingerprint } from "../forkUpdatePresentation";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export function UpdateRecoveryDialog({
  device,
  controller,
  option,
  onClose,
}: {
  device: string;
  controller: ForkUpdateController;
  option: ForkRecoveryOption | null;
  onClose(): void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [reviewedBuild] = useState(() => controller.getSnapshot().status?.currentBuild);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!option) return null;
  const destructive =
    option.requiresDataRestore || option.homes.some((home) => home.requiresPairing);
  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const fresh = await controller.refresh();
      if (fresh.currentBuild.artifactSha256 !== reviewedBuild?.artifactSha256)
        throw new Error(
          "The installed build changed. Close this dialog and review recovery again.",
        );
      const current = fresh.recoveryOptions.find((candidate) => candidate.id === option.id);
      if (!current || recoveryFingerprint(current) !== recoveryFingerprint(option))
        throw new Error(
          "This recovery point changed. Close this dialog and review the current recovery options.",
        );
      await controller.recover({
        optionId: option.id,
        transactionId: option.transactionId,
        restoreTimestamps: Object.fromEntries(
          option.homes.map((home) => [home.id, home.restoreTimestamp]),
        ),
        acknowledgeDataRestore: acknowledged,
      });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Recovery failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-h-[90dvh] overflow-y-auto" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Recover {device}</DialogTitle>
          <DialogDescription>
            Current build: {reviewedBuild ? formatBuildVersion(reviewedBuild) : "Unknown"}. Target:{" "}
            {formatBuildVersion(option.build)} ({option.build.commit.slice(0, 12)}).
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p>
            {option.requiresDataRestore
              ? "Data will return to the restore cutoffs below. A verified rescue copy of current data is required before restoration."
              : "This recovery preserves current data using a compatible previous build."}
          </p>
          <ul className="space-y-2">
            {option.homes.map((home) => (
              <li key={home.id} className="rounded-md border p-3">
                <p className="font-medium">{home.label}</p>
                <p>Restore cutoff: {home.restoreTimestamp}</p>
                <p>
                  {home.binaryCompatible
                    ? option.requiresDataRestore
                      ? "Previous build can open this restored data"
                      : "Compatible with current data"
                    : "Older data restoration required"}
                </p>
                <p>
                  Additional storage: {(home.additionalBytes / 1024 ** 3).toFixed(2)} GiB, plus the
                  recovery safety margin.
                </p>
                {home.requiresPairing ? (
                  <p>Clients may need to pair again after this home is restored.</p>
                ) : null}
              </li>
            ))}
          </ul>
          {option.homes.length === 0 ? (
            <p>
              Android replaces the app using the same package and signing key. Connections remain in
              app storage. Android may request installation confirmation.
            </p>
          ) : null}
          <p>The recovered build stays pinned until you choose Resume updates.</p>
          {option.requiresDataRestore ? (
            <p>Restored schedules and queued work stay held for Review restored automation.</p>
          ) : null}
          {destructive ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I understand the restore cutoffs, possible re-pairing, and changes since the
                snapshot. Preserve a rescue copy before restoring.
              </span>
            </label>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || (destructive && !acknowledged)} onClick={() => void restore()}>
            {busy ? "Revalidating recovery…" : "Recover this device"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
