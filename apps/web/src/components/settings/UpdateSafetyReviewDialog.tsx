import { useState } from "react";
import type { ForkUpdateController } from "../../state/forkUpdates";
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

/** Acknowledgements go to the same controller as installation; they never release a transaction fence. */
export function UpdateSafetyReviewDialog({
  controller,
  device,
  review,
  onClose,
}: {
  controller: ForkUpdateController;
  device: string;
  review: "bootstrap" | "automation" | null;
  onClose(): void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!review) return null;
  const bootstrap = review === "bootstrap";
  const confirm = async () => {
    if (!acknowledged) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await controller.refresh();
      if (!bootstrap && !fresh.automationReviewRequired) {
        onClose();
        return;
      }
      await controller.action({
        action: bootstrap ? "confirm-bootstrap" : "acknowledge-automation-review",
      });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The review could not be recorded.");
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
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {bootstrap ? "Review fork installations" : "Review restored automation"}
          </DialogTitle>
          <DialogDescription>
            {device}:{" "}
            {bootstrap
              ? "Verify every fork desktop, background service, standalone server, and development server on this device uses the updater baseline and registers with this coordinator. Windows and WSL must be explicitly connected."
              : "Review restored schedules and queued runs on this host before allowing them to run again. This is separate from Resume updates."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p>
            {bootstrap
              ? "Older or unregistered installations cannot be checked. Complete their stopped-work bootstrap first. Missing capabilities and unknown participants continue to block installation after this review."
              : "Confirming this review releases the restored automation hold. Eligible schedules and queued work may start."}
          </p>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              {bootstrap
                ? `I verified all known fork installations belonging to this OS user on ${device} are registered.`
                : `I reviewed restored schedules and queued work on ${device} and permit them to run.`}
            </span>
          </label>
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
          <Button disabled={busy || !acknowledged} onClick={() => void confirm()}>
            {busy ? "Recording review…" : "Confirm review"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
