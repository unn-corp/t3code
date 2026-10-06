import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ForkRecoveryOption } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ForkUpdateController, useForkUpdates } from "../../state/forkUpdates";
import { forkPhaseLabels, forkStatusDescription } from "../forkUpdatePresentation";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { isAndroidPwa } from "../../env";
import { UpdateSafetyReviewDialog } from "./UpdateSafetyReviewDialog";
import { UpdateRecoveryDialog } from "./UpdateRecoveryDialog";

export function ForkUpdateControls({
  controller,
  device,
  environmentId,
}: {
  controller: ForkUpdateController;
  device: string;
  environmentId?: EnvironmentId;
}) {
  const { status, busy, error } = useForkUpdates(controller);
  const [recovery, setRecovery] = useState<ForkRecoveryOption | null>(null);
  const [review, setReview] = useState<"bootstrap" | "automation" | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!status?.countdown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [status?.countdown]);
  const request = (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  };
  if (!status)
    return (
      <SettingsRow
        title={device}
        description={error ?? "Loading update status…"}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => request(controller.refresh())}
          >
            Retry
          </Button>
        }
      />
    );
  const working = ["checking", "downloading", "installing", "verifying", "recovery"].includes(
    status.phase,
  );
  return (
    <>
      <SettingsRow
        title={device}
        description={`Installed source: ${status.currentBuild.version} · ${status.currentBuild.commit.slice(0, 12)}${status.currentBuild.installationSequence === undefined ? "" : ` · Installation sequence ${status.currentBuild.installationSequence}`}`}
        status={
          <div role="status" aria-live="polite">
            <p>
              {forkPhaseLabels[status.phase]}
              {status.targetBuild ? ` · ${status.targetBuild.version}` : ""}
            </p>
            <p className="whitespace-normal break-words">{forkStatusDescription(status)}</p>
            {status.lastError ? (
              <p role="alert" className="text-destructive">
                {status.lastError}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busy || working}
            onClick={() => request(controller.action({ action: "check" }))}
          >
            Check and download
          </Button>
        }
      />
      {status.affectedHomes?.length ? (
        <SettingsRow
          title="Affected data homes"
          description={status.affectedHomes.map((home) => home.label).join(" · ")}
        />
      ) : null}
      {status.blockers.length && environmentId ? (
        <SettingsRow
          title="Inspect host activity"
          description="Review the named host’s processes and working agents. The updater never stops them."
          control={
            <Link
              to="/settings/diagnostics"
              search={{ machine: environmentId }}
              className="text-xs underline"
            >
              View host activity
            </Link>
          }
        />
      ) : null}
      {status.blockers.some((blocker) => blocker.reason === "bootstrap") &&
      (environmentId || !isAndroidPwa) ? (
        <SettingsRow
          title="Review fork installations"
          description="Complete the stopped-work bootstrap for every known fork installation on this device before enabling delivery."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setReview("bootstrap")}
            >
              Review installations
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        title="Update channel"
        description={`Saved on ${device}. Other devices keep their own preferences.`}
        control={
          <Select
            value={status.policy.channel}
            onValueChange={(value) => {
              if (value === "stable" || value === "nightly")
                request(controller.setPolicy({ channel: value }));
            }}
          >
            <SelectTrigger size="sm" aria-label={`${device} update channel`} disabled={busy}>
              <SelectValue>
                {status.policy.channel === "nightly" ? "Nightly" : "Stable"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="stable">Stable</SelectItem>
              <SelectItem value="nightly">Nightly</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Automatic installation"
        description="Waits for this device’s idle and activity checks. Updates never stop agents."
        control={
          <Switch
            aria-label={`${device} automatic installation`}
            checked={status.policy.automaticInstallation}
            disabled={busy}
            onCheckedChange={(enabled) =>
              request(controller.setPolicy({ automaticInstallation: enabled }))
            }
          />
        }
      />
      {status.countdown ? (
        <SettingsRow
          title={`Installation in ${Math.max(0, Math.ceil((status.countdown.installsAt - now) / 1000))} seconds`}
          description="Installation will begin after the cancellable 15-second countdown. New activity defers installation."
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => request(controller.action({ action: "cancel-countdown" }))}
            >
              Cancel countdown
            </Button>
          }
        />
      ) : null}
      {status.targetBuild ? (
        <SettingsRow
          title="Install verified update"
          description="The controller rechecks release eligibility, stopped work, and recovery capacity before replacement."
          control={
            <Button
              size="sm"
              disabled={
                busy ||
                working ||
                status.installable === false ||
                !["staged", "waiting", "failed"].includes(status.phase)
              }
              onClick={() =>
                request(
                  controller.action({
                    action: "install",
                    targetArtifactSha256: status.targetBuild!.artifactSha256,
                  }),
                )
              }
            >
              Install when idle
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        title={status.policy.pinnedBuild !== null ? "Updates pinned" : "Pin this build"}
        description={
          status.policy.pinnedBuild !== null
            ? `Pinned: ${status.policy.pinnedBuild}. Resume updates does not resume agent work.`
            : "Keep the installed build until you explicitly resume updates."
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy ||
              (status.policy.pinnedBuild === null &&
                !/^[a-f0-9]{64}$/.test(status.currentBuild.artifactSha256))
            }
            onClick={() =>
              request(
                controller.setPolicy({
                  pinnedBuild:
                    status.policy.pinnedBuild !== null ? null : status.currentBuild.artifactSha256,
                }),
              )
            }
          >
            {status.policy.pinnedBuild !== null ? "Resume updates" : "Pin build"}
          </Button>
        }
      />
      {status.recoveryOptions.length ? (
        <SettingsRow
          title="Recovery"
          description="Select a retained build to review its compatibility and affected homes."
        >
          <div className="flex flex-wrap gap-2 pb-3">
            {status.recoveryOptions.map((option) => (
              <Button
                key={option.id}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  try {
                    const fresh = await controller.refresh();
                    const candidate = fresh.recoveryOptions.find((item) => item.id === option.id);
                    if (candidate) setRecovery(candidate);
                  } catch {
                    /* Controller displays the failure. */
                  }
                }}
              >
                Review {option.build.version}
              </Button>
            ))}
          </div>
        </SettingsRow>
      ) : null}
      {status.automationReviewRequired ? (
        <SettingsRow
          title="Review restored automation"
          description="Restored schedules and queued runs remain held. Review them before permitting agent work."
          control={
            <div className="flex flex-wrap items-center gap-3">
              <Link
                to="/settings/scheduled-tasks"
                search={environmentId ? { machine: environmentId } : {}}
                className="text-xs underline"
              >
                Review schedules and queued work
              </Link>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setReview("automation")}
              >
                Confirm automation review
              </Button>
            </div>
          }
        />
      ) : null}
      <UpdateSafetyReviewDialog
        key={review ?? "no-review"}
        controller={controller}
        device={device}
        review={review}
        onClose={() => setReview(null)}
      />
      <UpdateRecoveryDialog
        key={recovery?.id ?? "closed"}
        device={device}
        controller={controller}
        option={recovery}
        onClose={() => setRecovery(null)}
      />
    </>
  );
}
