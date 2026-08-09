import { BotIcon, LoaderIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { resolveAppModelSelectionState } from "../../modelSelection";
import { newMessageId, newThreadId } from "../../lib/utils";
import { waitForStartedServerThread } from "../ChatView.logic";
import { usePrimaryEnvironment } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { DICTATION_SETUP_AGENT_PROMPT, DICTATION_SETUP_THREAD_TITLE } from "./dictationSetupAgent";

export function DictationSetupAgentButton() {
  const navigate = useNavigate();
  const settings = usePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const projects = useProjects();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [isStarting, setIsStarting] = useState(false);

  const setupProject = useMemo(
    () =>
      primaryEnvironment
        ? projects.find((project) => project.environmentId === primaryEnvironment.environmentId)
        : undefined,
    [primaryEnvironment, projects],
  );
  const canStart = primaryEnvironment !== null && setupProject !== undefined;

  const startSetupAgent = useCallback(async () => {
    if (!primaryEnvironment || !setupProject || isStarting) {
      if (!primaryEnvironment || !setupProject) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Add a project before starting setup",
            description: "The setup agent needs a project on the primary T3 environment to run.",
          }),
        );
      }
      return;
    }

    const modelSelection = resolveAppModelSelectionState(settings, serverProviders);
    if (modelSelection.model.trim().length === 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Enable an agent provider first",
          description: "Choose and authenticate a provider before starting voice setup.",
        }),
      );
      return;
    }

    setIsStarting(true);
    const environmentId = primaryEnvironment.environmentId;
    const threadId = newThreadId();
    const createdAt = new Date().toISOString();
    const result = await startThreadTurn({
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: DICTATION_SETUP_AGENT_PROMPT,
          attachments: [],
        },
        modelSelection,
        titleSeed: DICTATION_SETUP_THREAD_TITLE,
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: setupProject.id,
            title: DICTATION_SETUP_THREAD_TITLE,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
        },
        createdAt,
      },
    });

    if (result._tag === "Failure") {
      setIsStarting(false);
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not start voice setup",
            description:
              error instanceof Error ? error.message : "The setup agent could not be started.",
          }),
        );
      }
      return;
    }

    await waitForStartedServerThread(scopeThreadRef(environmentId, threadId));
    setIsStarting(false);
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
    });
  }, [
    isStarting,
    navigate,
    primaryEnvironment,
    serverProviders,
    settings,
    setupProject,
    startThreadTurn,
  ]);

  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      className="shrink-0 gap-1.5"
      disabled={isStarting || !canStart}
      onClick={() => void startSetupAgent()}
      title={canStart ? "Start an agent to configure local voice dictation" : "Add a project first"}
    >
      {isStarting ? (
        <LoaderIcon className="size-3.5 animate-spin" />
      ) : (
        <BotIcon className="size-3.5" />
      )}
      {isStarting ? "Starting setup" : "Set up with agent"}
    </Button>
  );
}
