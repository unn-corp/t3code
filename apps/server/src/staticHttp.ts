import * as Mime from "effect/unstable/http/Mime";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerResponse, HttpServerRequest } from "effect/unstable/http";
import * as ServerConfig from "./config.ts";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const decodeBuildManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        css: Schema.optional(Schema.Array(Schema.String)),
        assets: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const loadImmutableBuildAssets = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const staticDir =
    config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
  if (!staticDir) return new Set<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(staticDir, ".vite", "manifest.json")).pipe(
    Effect.flatMap(decodeBuildManifest),
    Effect.map(
      (manifest) =>
        new Set(
          Object.values(manifest).flatMap((entry) => [
            entry.file,
            ...(entry.css ?? []),
            ...(entry.assets ?? []),
          ]),
        ),
    ),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});

const openStaticFile = Effect.fn("openStaticFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // Reject directories and special files before opening. Response metadata comes from the handle.
  const pathInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (pathInfo?.type !== "File") return null;
  const file = yield* fileSystem.open(filePath, { flag: "r" });
  const info = yield* file.stat;
  return info.type === "File" ? { file, info } : null;
});

const streamStaticFile = (file: FileSystem.File, size: bigint) =>
  Stream.unfold(
    0n,
    Effect.fnUntraced(function* (offset: bigint) {
      if (offset >= size) return;
      const remaining = size - offset;
      const bytes = yield* file.readAlloc(Number(remaining < 65_536n ? remaining : 65_536n));
      if (Option.isNone(bytes)) return;
      return [bytes.value, offset + BigInt(bytes.value.byteLength)] as const;
    }),
  );

const handleStaticAndDevRequest = Effect.fn("handleStaticAndDevRequest")(
  function* (immutableBuildAssets: ReadonlySet<string>, teamOnly = false) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    if (teamOnly) {
      if (url.value.pathname === "/")
        return HttpServerResponse.redirect("/spaces", { status: 302 });
      if (isUnavailableTeamPath(url.value.pathname))
        return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const config = yield* ServerConfig.ServerConfig;
    if (!teamOnly && config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (!teamOnly && config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    /**
     * The shell names its bundles by content hash, so a client that keeps a
     * stale shell keeps requesting bundles that no longer exist. It was served
     * with no cache directive and no validator at all, which leaves the
     * decision to browser heuristics: an installed PWA could sit on an old
     * build indefinitely with no way to notice a new one.
     */
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    let opened = yield* openStaticFile(filePath);
    if (!opened) {
      if (teamOnly && url.value.pathname !== "/spaces")
        return HttpServerResponse.text("Not Found", { status: 404 });
      filePath = path.resolve(staticRoot, "index.html");
      opened = yield* openStaticFile(filePath);
      if (!opened) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }
    const fileInfo = opened.info;
    const mimeType = Option.getOrElse(Mime.getType(filePath), () => "application/octet-stream");
    const isHtml = mimeType === "text/html";

    // A hash-like name is not enough: custom static files can use the same naming pattern.
    const relativePath = path.relative(staticRoot, filePath).replaceAll("\\", "/");
    const immutable =
      !isHtml &&
      /^assets\/.+-[\w-]{8}\.[^/]+$/.test(relativePath) &&
      immutableBuildAssets.has(relativePath);
    const headers: Record<string, string> = {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    // Deployments can preserve HTML size and mtime while changing its bundle URLs.
    const modifiedAt = isHtml ? undefined : Option.getOrUndefined(fileInfo.mtime);
    const etag = modifiedAt
      ? `W/"${fileInfo.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`
      : undefined;
    if (etag !== undefined && modifiedAt !== undefined) {
      headers.ETag = etag;
      headers["Last-Modified"] = modifiedAt.toUTCString();
    }

    // If-None-Match takes precedence over dates and uses weak comparison for
    // GET/HEAD, including when compression changes the transferred bytes.
    const ifNoneMatch = request.headers["if-none-match"];
    const ifModifiedSince = request.headers["if-modified-since"];
    const unchanged =
      ifNoneMatch !== undefined
        ? ifNoneMatch.split(",").some((value) => {
            const candidate = value.trim();
            return (
              candidate === "*" ||
              (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2))
            );
          })
        : ifModifiedSince !== undefined &&
          modifiedAt !== undefined &&
          Date.parse(modifiedAt.toUTCString()) <= Date.parse(ifModifiedSince);
    if (!isHtml && unchanged) {
      return HttpServerResponse.empty({
        status: 304,
        headers: { ...headers, Vary: "Accept-Encoding" },
      });
    }

    const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
    // The request scope closes the handle for GET, HEAD, 304, errors, and cancellation.
    // HEAD still passes through compression, which selects headers without reading the stream.
    return HttpServerResponse.stream(streamStaticFile(opened.file, fileInfo.size), {
      headers,
      contentType,
      contentLength: Number(fileInfo.size),
    });
  },
  Effect.catchTags({
    PlatformError: () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
  }),
);

// Read the installed build's manifest once. Unknown files use revalidation.
export const staticAndDevRouteLayer = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets))),
  ),
);

// Only the management screen receives the SPA shell. Unregistered service APIs
// must remain 404 even when the application bundle contains personal screens.
export const isUnavailableTeamPath = (pathname: string) =>
  ["/api", "/ws", "/oauth", "/.well-known", "/mcp"].some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

export const teamStaticRouteLayer = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets, true))),
  ),
);
