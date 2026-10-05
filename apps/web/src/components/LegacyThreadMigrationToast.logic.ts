import type { ServerLifecycleLegacyThreadMigrationPayload } from "@t3tools/contracts";

export function legacyThreadMigrationNotice(
  migration: ServerLifecycleLegacyThreadMigrationPayload | null | undefined,
) {
  if (!migration) return null;
  const total = migration.totalThreadCount.toLocaleString();
  const failed = migration.failedThreadCount ?? 0;
  if (migration.status === "complete") {
    if (failed === 0) return null;
    return {
      type: "warning" as const,
      title: "Some conversations still need restoring",
      description: `${failed.toLocaleString()} ${failed === 1 ? "conversation needs" : "conversations need"} another attempt. Open an affected conversation to retry, or restart T3 Code when convenient. Your original history is retained.`,
      timeout: 0,
    };
  }
  const completed = migration.completedThreadCount;
  return {
    type: "info" as const,
    title: "Restoring your conversations…",
    description: `${
      completed === undefined
        ? `Restoring ${total} ${migration.totalThreadCount === 1 ? "conversation" : "conversations"} from the previous version.`
        : `${completed.toLocaleString()} of ${total} conversations restored.`
    } You can keep working. Large histories take longer; restoration resumes when you reopen T3 Code.${failed > 0 ? ` ${failed.toLocaleString()} need another attempt.` : ""}`,
    timeout: 0,
  };
}
