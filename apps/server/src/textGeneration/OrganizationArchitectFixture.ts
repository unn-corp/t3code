import { OrganizationId, OrganizationRoleId, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { OrganizationArchitectTurnInput } from "./TextGeneration.ts";

export const architectTurnInput = (
  providerId: string,
  model: string,
): OrganizationArchitectTurnInput => ({
  modelSelection: createModelSelection(ProviderInstanceId.make(providerId), model),
  organization: {
    id: OrganizationId.make("org-architect-test"),
    title: "Studio",
    mission: "Build useful software",
    draftRevision: 3,
    workflows: [],
    graph: {
      roles: [
        {
          id: OrganizationRoleId.make("architect"),
          kind: "architect",
          title: "Architect",
          mandate: "Design the organization",
          poolSize: 1,
        },
      ],
      edges: [],
    },
  },
  transcript: [{ role: "user", text: "We need a QA role." }],
  userText: "Suggest a plan.",
});
