import type { PresenceHeartbeatInput } from "@t3tools/contracts/teamPresence";

/** A late heartbeat must never overwrite a newer receipt or an unmounted source's status. */
export function createTeamPresenceHeartbeat(options: {
  readonly execute: (focus: PresenceHeartbeatInput) => Promise<string | null>;
  readonly report: (failure: string | null) => void;
}) {
  let active = true;
  let revision = 0;
  return {
    async send(focus: PresenceHeartbeatInput) {
      const request = ++revision;
      const failure = await options.execute(focus);
      if (active && request === revision) options.report(failure);
    },
    open() {
      active = true;
      revision++;
    },
    close() {
      active = false;
      revision++;
    },
  };
}
