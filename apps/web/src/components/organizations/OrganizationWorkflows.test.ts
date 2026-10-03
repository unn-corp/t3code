import { OrganizationRoleId, type OrganizationRole } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workflowWorkRoles } from "./OrganizationWorkflows";

const role = (kind: OrganizationRole["kind"]): OrganizationRole => ({
  id: OrganizationRoleId.make(kind),
  kind,
  title: kind,
  mandate: "",
  poolSize: 1,
});

describe("workflow template work roles", () => {
  it("defaults to a worker after system roles while preserving every supported worker kind", () => {
    const candidates = workflowWorkRoles([
      role("architect"),
      role("director"),
      role("engineering"),
      role("qa"),
      role("security"),
      role("research"),
      role("custom"),
    ]);

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      "engineering",
      "security",
      "research",
      "custom",
    ]);
    expect(candidates[0]?.kind).toBe("engineering");
  });

  it("requires adding a worker when the Organization has only system and QA roles", () => {
    expect(workflowWorkRoles([role("architect"), role("director"), role("qa")])).toEqual([]);
  });
});
