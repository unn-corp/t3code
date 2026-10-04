import { WS_METHODS, type ScopedThreadRef, type ThreadExportInput } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { toastManager } from "../components/ui/toast";

const exportThread = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-export",
  tag: WS_METHODS.threadExport,
});
export function useExportThread() {
  const request = useAtomCommand(exportThread, { reportFailure: false });
  return useCallback(
    async (thread: ScopedThreadRef, format: ThreadExportInput["format"]) => {
      const result = await request({
        environmentId: thread.environmentId,
        input: { threadId: thread.threadId, format },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not export thread",
          description: error instanceof Error ? error.message : "Try again after reconnecting.",
        });
        return;
      }
      const url = URL.createObjectURL(
        new Blob([result.value.content], { type: `${result.value.mimeType};charset=utf-8` }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = result.value.filename;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    },
    [request],
  );
}
