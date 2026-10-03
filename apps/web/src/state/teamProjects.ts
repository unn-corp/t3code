import { environmentCatalog } from "../connection/catalog";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import type { LocalTeamProjectState } from "@t3tools/contracts/teamProjects";
import {
  createTeamProjectAtoms,
  createSharedProjectVisibilitySelector,
} from "@t3tools/client-runtime/state/teamProjects";
import { connectionAtomRuntime } from "../connection/runtime";
export const teamProjects = createTeamProjectAtoms(connectionAtomRuntime);

const EMPTY_LINKS: ReadonlyArray<LocalTeamProjectState> = Object.freeze([]);
export const teamLinksValueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const result = get(teamProjects.state({ environmentId, input: {} }));
    return AsyncResult.isSuccess(result) ? result.value : EMPTY_LINKS;
  }),
);

export {
  sharedProjectBoundaryKey,
  sharedProjectSourceScope,
} from "@t3tools/client-runtime/state/teamProjects";
const selectVisibility = createSharedProjectVisibilitySelector();
export const sharedProjectVisibilityAtom = Atom.make((get) =>
  selectVisibility(
    [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) =>
      get(teamLinksValueAtom(environmentId)).map((state) => ({ environmentId, state })),
    ),
    get(primaryEnvironmentIdAtom),
  ),
);
