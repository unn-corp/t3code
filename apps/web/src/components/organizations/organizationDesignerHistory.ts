import type { Organization, OrganizationChange } from "@t3tools/contracts";

/** A single server mutation must have a single safe inverse. Role deletion is excluded because it also removes edges. */
export function inverseOrganizationChange(
  organization: Organization,
  change: OrganizationChange,
): OrganizationChange | null {
  switch (change.type) {
    case "add-role":
      return { type: "remove-role", roleId: change.role.id };
    case "update-role": {
      const role = organization.graph.roles.find((item) => item.id === change.roleId);
      return role
        ? {
            type: "update-role",
            roleId: role.id,
            title: role.title,
            mandate: role.mandate,
            poolSize: role.poolSize,
          }
        : null;
    }
    case "remove-role":
      return null;
    case "add-edge":
      return { type: "remove-edge", edgeId: change.edge.id };
    case "remove-edge": {
      const edge = organization.graph.edges.find((item) => item.id === change.edgeId);
      return edge ? { type: "add-edge", edge } : null;
    }
    case "set-layout":
      return { type: "set-layout", layout: organization.layout };
    case "set-title":
      return { type: "set-title", title: organization.title };
    case "set-mission":
      return { type: "set-mission", mission: organization.mission };
    case "upsert-workflow":
    case "remove-workflow":
      return null;
  }
}
