import type { TeamThreadSource } from "@t3tools/contracts/teamProjects";

/** A shared read identity is never an execution target, even when IDs look like local IDs. */
export function canExecuteTeamSource(source: TeamThreadSource, threadId: string): boolean {
  return (
    source.readSource.kind === "local" &&
    source.executionRef !== null &&
    source.executionRef.projectId === source.displayProjectRef.projectId &&
    source.readSource.threadId === threadId &&
    source.executionRef.threadId === threadId &&
    source.access.execute
  );
}
export function requireTeamExecution(source: TeamThreadSource | undefined, threadId: string): void {
  if (source !== undefined && !canExecuteTeamSource(source, threadId))
    throw new Error(
      "This shared conversation is read-only. Continue with your own agent in a local thread.",
    );
}
