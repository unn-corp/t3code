import { describe, expect, it } from "vite-plus/test";
import { legacyThreadMigrationNotice } from "./LegacyThreadMigrationToast.logic";

describe("legacy thread migration notices", () => {
  it("updates visible restoration counts without hiding unfinished work", () => {
    const before = legacyThreadMigrationNotice({
      status: "running",
      totalThreadCount: 785,
      completedThreadCount: 473,
    });
    const after = legacyThreadMigrationNotice({
      status: "running",
      totalThreadCount: 785,
      completedThreadCount: 492,
    });
    expect(before?.description).toContain("473 of 785");
    expect(after?.description).toContain("492 of 785");
    expect(after?.description).toContain("resumes");
    expect(after?.timeout).toBe(0);
  });

  it("supports an older server without pretending it reports progress", () => {
    const notice = legacyThreadMigrationNotice({ status: "running", totalThreadCount: 1 });
    expect(notice?.description).toContain("Restoring 1 conversation from the previous version");
    expect(notice?.description).not.toContain("0 of");
  });

  it("keeps retry instructions visible after a partially failed pass", () => {
    const notice = legacyThreadMigrationNotice({
      status: "complete",
      totalThreadCount: 12,
      completedThreadCount: 11,
      failedThreadCount: 1,
    });
    expect(notice?.type).toBe("warning");
    expect(notice?.description).toContain("1 conversation needs another attempt");
    expect(notice?.description).toContain("Open an affected conversation to retry");
  });

  it("dismisses a successful completion or missing environment", () => {
    expect(
      legacyThreadMigrationNotice({
        status: "complete",
        totalThreadCount: 12,
        completedThreadCount: 12,
        failedThreadCount: 0,
      }),
    ).toBeNull();
    expect(legacyThreadMigrationNotice({ status: "complete", totalThreadCount: 12 })).toBeNull();
    expect(legacyThreadMigrationNotice(undefined)).toBeNull();
  });
});
