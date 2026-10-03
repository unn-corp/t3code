import * as Effect from "effect/Effect";
import { Command, Flag } from "effect/unstable/cli";
import { serveOrganizationScopeLaunchBroker } from "../organizations/OrganizationScopeLaunchBroker.ts";

/** A detached, versioned CLI child holds the Organization launch socket across
 * managed server child restarts and Electron backend restarts.
 */
export const organizationLaunchBrokerCommand = Command.make("__organization-launch-broker", {
  baseDir: Flag.String("base-dir"),
}).pipe(
  Command.unlisted,
  Command.withHandler(({ baseDir }) =>
    Effect.sync(() => {
      void serveOrganizationScopeLaunchBroker(baseDir)
        .then(() => process.stdout.write("READY\n"))
        .catch((cause: unknown) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          process.stderr.write(`[organization-launch-broker] ${error.message}\n`);
          process.exitCode = 1;
        });
    }),
  ),
);
