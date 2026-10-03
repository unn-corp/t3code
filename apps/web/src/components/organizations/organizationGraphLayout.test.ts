import { OrganizationId, OrganizationRoleId, type Organization } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { inverseOrganizationChange } from "./organizationDesignerHistory";
import {
  fitGraphViewport,
  layoutWithMovedRole,
  roleBounds,
  rolePositions,
  zoomGraphAt,
} from "./organizationGraphLayout";

const directorId = OrganizationRoleId.make("director");
const architectId = OrganizationRoleId.make("architect");
const organization: Organization = {
  id: OrganizationId.make("organization"),
  title: "Example",
  mission: "Maintain the repository",
  lifecycle: "draft",
  draftRevision: 2,
  publishedRevision: null,
  directorRoleId: directorId,
  architectRoleId: architectId,
  graph: {
    roles: [
      { id: directorId, kind: "director", title: "Director", mandate: "Coordinate", poolSize: 1 },
      { id: architectId, kind: "architect", title: "Architect", mandate: "Design", poolSize: 1 },
    ],
    edges: [],
  },
  layout: { positions: [] },
  workflows: [],
  bindings: [],
  createdAt: "2026-09-26T00:00:00Z",
  updatedAt: "2026-09-26T00:00:00Z",
};

describe("organization graph interaction geometry", () => {
  it("persists a moved role while preserving other role positions and the semantic graph", () => {
    const before = rolePositions(organization);
    const layout = layoutWithMovedRole(organization, directorId, { x: 123.4, y: 245.6 });
    expect(layout.positions).toEqual([
      { roleId: directorId, x: 123, y: 246 },
      { roleId: architectId, ...before.get(architectId)! },
    ]);
    expect(organization.layout.positions).toEqual([]);
    expect(organization.graph.roles).toHaveLength(2);
    expect(inverseOrganizationChange(organization, { type: "set-layout", layout })).toEqual({
      type: "set-layout",
      layout: organization.layout,
    });
  });

  it("fits graph bounds into a narrow viewport and zooms around the pointer", () => {
    const bounds = roleBounds(rolePositions(organization));
    const viewport = fitGraphViewport(bounds, { width: 320, height: 280 });
    expect(bounds.minX * viewport.zoom + viewport.x).toBeGreaterThanOrEqual(0);
    expect(bounds.maxX * viewport.zoom + viewport.x).toBeLessThanOrEqual(320);
    const anchor = { x: 160, y: 140 };
    const before = {
      x: (anchor.x - viewport.x) / viewport.zoom,
      y: (anchor.y - viewport.y) / viewport.zoom,
    };
    const zoomed = zoomGraphAt(viewport, anchor, viewport.zoom * 1.2);
    expect((anchor.x - zoomed.x) / zoomed.zoom).toBeCloseTo(before.x);
    expect((anchor.y - zoomed.y) / zoomed.zoom).toBeCloseTo(before.y);
  });

  it("does not offer one-step undo for role deletion that may remove relationships", () => {
    expect(
      inverseOrganizationChange(organization, { type: "remove-role", roleId: directorId }),
    ).toBeNull();
  });
});
