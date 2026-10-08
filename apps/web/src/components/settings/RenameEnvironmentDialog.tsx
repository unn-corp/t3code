import { environmentNameError } from "@t3tools/client-runtime/connection";
import { useId, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import type { EnvironmentPresentation } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function RenameEnvironmentDialog({
  environment,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onClose: () => void;
}) {
  const inputId = useId();
  const [name, setName] = useState(environment.label);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rename = useAtomCommand(environmentCatalog.rename, { reportFailure: false });
  const validationError = environmentNameError(name);
  const save = async (value: string | null) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const result = await rename({ environmentId: environment.environmentId, name: value });
    setSaving(false);
    if (result._tag === "Success") onClose();
    else {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not save the environment name.");
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup
        className="max-w-md"
        showCloseButton={!saving}
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (validationError === null) void save(name);
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>Rename environment</DialogTitle>
          <DialogDescription>
            This name is saved on this device. Chats keep running.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-2">
            <label htmlFor={inputId} className="text-sm font-medium">
              Environment name
            </label>
            <Input
              id={inputId}
              autoFocus
              value={name}
              disabled={saving}
              aria-invalid={validationError !== null}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              placeholder="Squidhub (Personal)"
            />
            <p className="text-xs text-muted-foreground">Leave blank to use the server name.</p>
            {validationError || error ? (
              <p role="alert" className="text-sm text-destructive">
                {validationError ?? error}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {environment.entry.nameOverride !== undefined ? (
            <Button type="button" variant="ghost" disabled={saving} onClick={() => void save(null)}>
              Use server name
            </Button>
          ) : null}
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving || validationError !== null}>
            {saving ? "Saving…" : "Save name"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
