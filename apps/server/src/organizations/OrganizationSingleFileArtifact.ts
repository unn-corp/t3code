// @effect-diagnostics preferSchemaOverJson:off - Exact JSON bytes are the versioned artifact wire format.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

export const ORGANIZATION_SINGLE_FILE_ARTIFACT_MAX_BYTES = 128 * 1024;
export const ORGANIZATION_SINGLE_FILE_REPLACEMENT_MAX_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_PATH_COMPONENTS = 16;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PATH_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface OrganizationSingleFileArtifactInput {
  readonly relativePath: string;
  readonly baseCommit: string;
  readonly baseBlobOid: string;
  readonly baseMode: "100644" | "100755";
  readonly baseSha256: string;
  /** Exact bytes read from the pinned Git blob, checked but omitted from the artifact. */
  readonly baseBytes: Uint8Array;
  readonly replacementBytes: Uint8Array;
}

export interface OrganizationSingleFileArtifact {
  readonly version: 1;
  readonly relativePath: string;
  readonly baseCommit: string;
  readonly baseBlobOid: string;
  readonly baseMode: "100644" | "100755";
  readonly baseSha256: string;
  readonly replacementBytes: Uint8Array;
  readonly replacementSha256: string;
}

export class OrganizationSingleFileArtifactError extends Error {
  override readonly name = "OrganizationSingleFileArtifactError";
}

const EncodedArtifact = Schema.Struct({
  version: Schema.Literal(1),
  relativePath: Schema.String,
  baseCommit: Schema.String,
  baseBlobOid: Schema.String,
  baseMode: Schema.Literals(["100644", "100755"]),
  baseSha256: Schema.String,
  replacementBase64: Schema.String,
  replacementSha256: Schema.String,
});
const decodeEncoded = Schema.decodeUnknownSync(EncodedArtifact);

const invalid = (reason: string): never => {
  throw new OrganizationSingleFileArtifactError(reason);
};
const sha256 = (bytes: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const validPath = (path: string): boolean =>
  path.length > 0 &&
  Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  !path.startsWith("/") &&
  path.split("/").length <= MAX_PATH_COMPONENTS &&
  path
    .split("/")
    .every((part) => part !== "." && part !== ".." && part !== ".git" && PATH_COMPONENT.test(part));

const checkedTextBytes = (value: Uint8Array, minimum: number, maximum: number): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum)
    return invalid("Artifact text bytes are outside the allowed size.");
  const bytes = Uint8Array.from(value);
  if (bytes.includes(0)) return invalid("Artifact text contains NUL.");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return invalid("Artifact text is not valid UTF-8.");
  }
  if (!Buffer.from(decoded, "utf8").equals(Buffer.from(bytes)))
    return invalid("Artifact text is not canonical UTF-8.");
  return bytes;
};

const validateIdentity = (value: {
  relativePath: string;
  baseCommit: string;
  baseBlobOid: string;
  baseMode: string;
  baseSha256: string;
}): void => {
  if (!validPath(value.relativePath)) invalid("Artifact path is unsafe.");
  if (
    !FULL_OID.test(value.baseCommit) ||
    !FULL_OID.test(value.baseBlobOid) ||
    value.baseCommit.length !== value.baseBlobOid.length
  )
    invalid("Artifact Git object identity is invalid.");
  if (value.baseMode !== "100644" && value.baseMode !== "100755")
    invalid("Artifact base mode is invalid.");
  if (!SHA256.test(value.baseSha256)) invalid("Artifact base SHA-256 is invalid.");
};

const canonicalBytes = (artifact: OrganizationSingleFileArtifact): Uint8Array => {
  const bytes = Buffer.from(
    JSON.stringify({
      version: artifact.version,
      relativePath: artifact.relativePath,
      baseCommit: artifact.baseCommit,
      baseBlobOid: artifact.baseBlobOid,
      baseMode: artifact.baseMode,
      baseSha256: artifact.baseSha256,
      replacementBase64: Buffer.from(artifact.replacementBytes).toString("base64"),
      replacementSha256: artifact.replacementSha256,
    }),
    "utf8",
  );
  if (bytes.byteLength > ORGANIZATION_SINGLE_FILE_ARTIFACT_MAX_BYTES)
    return invalid("Encoded artifact exceeds 128 KiB.");
  return bytes;
};

/** Encodes exact reviewed bytes; no caller-supplied digest can replace checking them. */
export const createOrganizationSingleFileArtifact = (
  input: OrganizationSingleFileArtifactInput,
): Uint8Array => {
  validateIdentity(input);
  const baseBytes = checkedTextBytes(input.baseBytes, 0, 64 * 1024);
  if (sha256(baseBytes) !== input.baseSha256) invalid("Base SHA-256 does not match base bytes.");
  const replacementBytes = checkedTextBytes(
    input.replacementBytes,
    1,
    ORGANIZATION_SINGLE_FILE_REPLACEMENT_MAX_BYTES,
  );
  return canonicalBytes({
    version: 1,
    relativePath: input.relativePath,
    baseCommit: input.baseCommit,
    baseBlobOid: input.baseBlobOid,
    baseMode: input.baseMode,
    baseSha256: input.baseSha256,
    replacementBytes,
    replacementSha256: sha256(replacementBytes),
  });
};

/** Rejects every alternate JSON spelling, field order, extra key and base64 spelling. */
export const decodeOrganizationSingleFileArtifact = (
  input: Uint8Array,
): OrganizationSingleFileArtifact => {
  const bytes = checkedTextBytes(input, 1, ORGANIZATION_SINGLE_FILE_ARTIFACT_MAX_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return invalid("Artifact is not valid canonical JSON.");
  }
  let encoded: typeof EncodedArtifact.Type;
  try {
    encoded = decodeEncoded(value);
  } catch {
    return invalid("Artifact fields are invalid.");
  }
  validateIdentity(encoded);
  const replacementBytes = checkedTextBytes(
    Buffer.from(encoded.replacementBase64, "base64"),
    1,
    ORGANIZATION_SINGLE_FILE_REPLACEMENT_MAX_BYTES,
  );
  if (sha256(replacementBytes) !== encoded.replacementSha256)
    return invalid("Replacement SHA-256 does not match replacement bytes.");
  const artifact: OrganizationSingleFileArtifact = {
    version: 1,
    relativePath: encoded.relativePath,
    baseCommit: encoded.baseCommit,
    baseBlobOid: encoded.baseBlobOid,
    baseMode: encoded.baseMode,
    baseSha256: encoded.baseSha256,
    replacementBytes,
    replacementSha256: encoded.replacementSha256,
  };
  if (!Buffer.from(canonicalBytes(artifact)).equals(Buffer.from(bytes)))
    return invalid("Artifact JSON or base64 is not canonical.");
  return artifact;
};
