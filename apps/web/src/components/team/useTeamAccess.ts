import { useCallback, useEffect, useRef, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import type {
  LocalTeamAccountAction,
  LocalTeamAccountResult,
} from "@t3tools/client-runtime/state/localTeamAccount";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  LocalTeamAccountState,
  TeamDirectory,
  TeamRosterCommand,
  TeamSpace,
} from "@t3tools/contracts/teamSpaces";
import { localTeamAccountCommand } from "../../state/localTeamAccount";
import { useAtomCommand } from "../../state/use-atom-command";

/** All account-dependent views come from one generation; interrupted or late reads are discarded. */
export function useTeamAccess(environmentId: EnvironmentId | null) {
  const command = useAtomCommand(localTeamAccountCommand, { reportFailure: false });
  const [state, setState] = useState<LocalTeamAccountState | null>(null);
  const [directory, setDirectory] = useState<TeamDirectory | null>(null);
  const [spaces, setSpaces] = useState<ReadonlyArray<TeamSpace>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [token, setToken] = useState("");
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const generation = useRef<string | null>(null);
  const reads = useRef(new Set<AbortController>());
  const clearAccess = useCallback(() => {
    setDirectory(null);
    setSpaces([]);
    setToken("");
    setRevision((value) => value + 1);
  }, []);
  const invalidate = useCallback(() => {
    ++epoch.current;
    for (const controller of reads.current) controller.abort();
    reads.current.clear();
    clearAccess();
  }, [clearAccess]);
  const send = useCallback(
    async (input: LocalTeamAccountAction) => {
      if (!environmentId) throw new Error("Connect to a T3 environment first.");
      const result = await command({ environmentId, input });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        const detail =
          typeof failure === "object" && failure !== null && "cause" in failure
            ? failure.cause
            : failure;
        throw new Error(
          typeof detail === "object" && detail !== null && "message" in detail
            ? String(detail.message)
            : "Could not load team access. Refresh and retry.",
        );
      }
      return result.value;
    },
    [command, environmentId],
  );
  const refresh = useCallback(async () => {
    const current = ++epoch.current;
    for (const controller of reads.current) controller.abort();
    reads.current.clear();
    clearAccess();
    const controller = new AbortController();
    reads.current.add(controller);
    setError("");
    try {
      const account = await send({ action: "state", signal: controller.signal });
      if (current !== epoch.current || account.action !== "state") return;
      if (generation.current !== account.state.generation) clearAccess();
      generation.current = account.state.generation;
      setState(
        account.state.flow?.status === "pending" && account.state.flow.expiresAt <= Date.now()
          ? {
              ...account.state,
              flow: { ...account.state.flow, status: "expired" },
              message: "Sign-in expired. Try again.",
            }
          : account.state,
      );
      if (!account.state.account) return;
      const [roster, projects] = await Promise.all([
        send({ action: "teamDirectory", signal: controller.signal }),
        send({ action: "projects", signal: controller.signal }),
      ]);
      if (current !== epoch.current) return;
      if (
        roster.action !== "teamDirectory" ||
        projects.action !== "projects" ||
        roster.generation !== generation.current ||
        projects.generation !== generation.current
      ) {
        generation.current = null;
        setState(null);
        clearAccess();
        setError("Your Teams account changed. Refresh team access before continuing.");
        return;
      }
      setDirectory(roster.directory);
      setSpaces(projects.spaces);
    } catch (cause) {
      if (current === epoch.current && !controller.signal.aborted) {
        clearAccess();
        setError(cause instanceof Error ? cause.message : "Could not load team access.");
      }
    } finally {
      reads.current.delete(controller);
    }
  }, [send, clearAccess]);
  useEffect(() => {
    generation.current = null;
    setState(null);
    setBusy(false);
    invalidate();
    if (environmentId) void refresh();
    return invalidate;
  }, [environmentId, refresh, invalidate]);
  useEffect(() => {
    if (busy || state?.flow?.status !== "pending") return;
    const remaining = state.flow.expiresAt - Date.now();
    if (remaining <= -5000) return;
    const timer = setTimeout(() => void refresh(), Math.min(2000, Math.max(100, remaining + 5000)));
    return () => clearTimeout(timer);
  }, [state, busy, refresh]);
  const mutate = async (
    input: LocalTeamAccountAction,
    onSuccess?: (result: LocalTeamAccountResult) => void,
  ) => {
    const current = epoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    setToken("");
    try {
      const result = await send(input);
      if (current !== epoch.current) return;
      if (result.action === "teamCommand" && result.generation !== generation.current) {
        invalidate();
        setState(null);
        return;
      }
      onSuccess?.(result);
      if (result.action === "disconnect")
        setNotice(
          result.remoteRevocationConfirmed
            ? "Signed out of Teams."
            : "Signed out on this environment. Remote grant revocation could not be confirmed; revoke access in your Teams account.",
        );
      const invitation = result.action === "teamCommand" ? result.result.token : undefined;
      await refresh();
      // refresh deliberately advances the epoch. Never restore a code into another account.
      if (
        epoch.current === current + 1 &&
        (result.action !== "teamCommand" || result.generation === generation.current)
      ) {
        setToken(invitation ?? "");
        if (
          input.action === "teamCommand" &&
          input.command.action === "invite" &&
          result.action === "teamCommand" &&
          result.result.inviteId &&
          !result.result.token
        )
          setNotice("Invitation email sent. The recipient can sign in to T3 after accepting it.");
      }
    } catch (cause) {
      if (current === epoch.current) {
        setError(cause instanceof Error ? cause.message : "Team request failed.");
        clearAccess();
      }
    } finally {
      if (epoch.current === current || epoch.current === current + 1) setBusy(false);
    }
  };
  const teamCommand = (input: TeamRosterCommand) => {
    if (!state?.account || !generation.current || !directory) return Promise.resolve();
    return mutate({ action: "teamCommand", generation: generation.current, command: input });
  };
  return {
    state,
    directory,
    spaces,
    busy,
    error,
    token,
    notice,
    revision,
    refresh,
    mutate,
    teamCommand,
    invalidate,
  };
}
