import type { ProjectId } from "@t3tools/contracts";
import type { LocalTeamFilesResult } from "@t3tools/contracts/teamFiles";

/** Navigation waits for the real checkout receipt and remains fenced by the captured account/environment. */
export async function awaitTeamProjectReceipt(options: {
  readonly generation: string;
  readonly isCurrent: () => boolean;
  readonly currentGeneration: () => Promise<string | null>;
  readonly execute: () => Promise<LocalTeamFilesResult>;
}): Promise<ProjectId | null> {
  if (!options.isCurrent()) return null;
  if ((await options.currentGeneration()) !== options.generation || !options.isCurrent())
    return null;
  const receipt = await options.execute();
  if (!options.isCurrent()) return null;
  if ((await options.currentGeneration()) !== options.generation || !options.isCurrent())
    return null;
  if (!receipt.projectId)
    throw new Error(
      "The project has not finished linking. Check project settings before retrying.",
    );
  return receipt.projectId;
}
