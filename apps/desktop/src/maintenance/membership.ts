// @effect-diagnostics nodeBuiltinImport:off globalDate:off — membership is one small file the person's confirmation writes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  decodeWslMembership,
  type WslMember,
  type WslMembership,
} from "@t3tools/shared/forkMaintenanceWsl";
import { ensurePrivateDirectory } from "./privateDirectory.ts";

/**
 * Which WSL distributions belong to this device's update is stated, persisted membership: the person confirms it
 * (bootstrap confirmation), and nothing is inferred from `wsl.exe -l`, listening addresses or hostnames.
 */
export async function readMembers(file: string): Promise<ReadonlyArray<WslMember>> {
  try {
    return decodeWslMembership(JSON.parse(await NodeFSP.readFile(file, "utf8"))).members;
  } catch {
    // Absent, or unreadable: no distribution is a member, so any managed one blocks installation.
    return [];
  }
}

export async function writeMembers(file: string, members: ReadonlyArray<WslMember>): Promise<void> {
  const value: WslMembership = { version: 1, members: [...members] };
  await ensurePrivateDirectory(NodePath.dirname(file));
  const temporary = `${file}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
}

/** The coordinator participant id of a member: letters, digits and dashes only. */
export const memberIdFor = (distro: string) => `wsl-${distro.replace(/[^A-Za-z0-9]/g, "-")}`;
