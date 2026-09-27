import * as Context from "effect/Context";
import {
  createGitHubRepository,
  inspectGitHubRepository,
  withRepositoryClone,
} from "./OrganizationRepositoryGit.ts";

export interface OrganizationRepositoryTransportShape {
  readonly create: typeof createGitHubRepository;
  readonly inspect: typeof inspectGitHubRepository;
  readonly withClone: typeof withRepositoryClone;
}

/** Only server code can replace this boundary; RPC inputs never select a transport. */
export const OrganizationRepositoryTransport =
  Context.Reference<OrganizationRepositoryTransportShape>(
    "t3/organizations/OrganizationRepositoryTransport",
    {
      defaultValue: () => ({
        create: createGitHubRepository,
        inspect: inspectGitHubRepository,
        withClone: withRepositoryClone,
      }),
    },
  );
