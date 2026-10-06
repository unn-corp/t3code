// @effect-diagnostics nodeBuiltinImport:off — a filesystem-permission credential for the local operator.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export const OPERATOR_TOKEN_HEADER = "x-t3-operator-token";
export const OPERATOR_ROUTE_PREFIX = "/api/maintenance/operator/";

export const operatorTokenPath = (baseDir: string) =>
  NodePath.join(baseDir, "maintenance", "operator-token");

/**
 * The local operator credential: a random token in a 0600 file under the T3 home, replaced on every
 * start and removed on exit. Whoever can read it already owns the home and its data, which is the
 * same authority `t3 pair` and the backup commands assume. It is never accepted from a session.
 */
export async function issueOperatorToken(baseDir: string): Promise<string> {
  const file = operatorTokenPath(baseDir);
  await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await NodeFSP.open(temporary, "w", 0o600);
  try {
    await handle.writeFile(token);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, file);
  return token;
}
export const revokeOperatorToken = (baseDir: string) =>
  NodeFSP.rm(operatorTokenPath(baseDir), { force: true });
export async function readOperatorToken(baseDir: string): Promise<string | null> {
  try {
    return (await NodeFSP.readFile(operatorTokenPath(baseDir), "utf8")).trim();
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  }
}
export function operatorTokenMatches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
}
