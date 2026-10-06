import { APP_VERSION, APP_BUILD_IDENTITY } from "../../branding";
import { isAndroidPwa } from "../../env";
import { localForkUpdateController, useForkUpdates } from "../../state/forkUpdates";
export function ClientBuildIdentity() {
  const { status } = useForkUpdates(localForkUpdateController());
  return (
    <span>
      This fork’s client · Source {status?.currentBuild.version ?? APP_VERSION} · Commit{" "}
      {status?.currentBuild.commit ?? APP_BUILD_IDENTITY.commit ?? "unknown"}
      {isAndroidPwa && status?.currentBuild.installationSequence !== undefined
        ? ` · Android installation sequence ${status.currentBuild.installationSequence}`
        : ""}
    </span>
  );
}
