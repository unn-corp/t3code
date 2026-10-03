import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { Command } from "effect/unstable/cli";
import { teamServiceCommand } from "../cli/server.ts";
import { resolveTeamServiceConfig } from "../cli/config.ts";
import { ServerConfig } from "../config.ts";
import { staticAndDevRouteLayer } from "../staticHttp.ts";
import { TEAM_SERVICE_READY, teamServiceLayer } from "./server.ts";
import { requireTeamServiceConfiguration } from "./serviceConfig.ts";

// Importing/acquiring any of the personal startup paths makes this test fail.
vi.mock("../server.ts", () => {
  throw new Error("Personal runtime loaded");
});
vi.mock("./LocalTeamAccount.ts", () => {
  throw new Error("Local account administration loaded");
});
vi.mock("../provider/Layers/ProviderService.ts", () => {
  throw new Error("Provider service loaded");
});
vi.mock("../terminal/Manager.ts", () => {
  throw new Error("Terminal runtime loaded");
});
vi.mock("../orchestration/Layers/OrchestrationReactor.ts", () => {
  throw new Error("Personal reactors loaded");
});
vi.mock("../agentDashboard/AgentDashboardReviewScheduler.ts", () => {
  throw new Error("Dashboard loaded");
});
vi.mock("../mcp/McpHttpServer.ts", () => {
  throw new Error("MCP loaded");
});

const configured = {
  T3_TEAM_CLERK_SECRET_KEY: "sk_test_synthetic_unused",
  T3_TEAM_CLERK_PUBLISHABLE_KEY: `pk_test_${btoa("synthetic.clerk.accounts.dev$")}`,
  T3_TEAM_ORIGINS: "https://team.example.test,http://localhost:3910",
  T3_TEAM_CREATORS: "",
  T3_TEAM_OAUTH_ISSUER: "https://issuer.example.test",
  T3_TEAM_OAUTH_CLIENT_ID: "public-client",
};
const configuration = (values: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(values));

it.effect("dedicated configuration rejects missing or invalid values without disclosing them", () =>
  Effect.gen(function* () {
    const cases = [
      { T3_TEAM_CLERK_SECRET_KEY: "" },
      { T3_TEAM_CLERK_PUBLISHABLE_KEY: "" },
      { T3_TEAM_ORIGINS: "" },
      { T3_TEAM_CLERK_SECRET_KEY: "private-value-invalid" },
      { T3_TEAM_CLERK_PUBLISHABLE_KEY: "pk_test_invalid" },
      { T3_TEAM_CLERK_PUBLISHABLE_KEY: `pk_live_${btoa("synthetic.clerk.accounts.dev$")}` },
      { T3_TEAM_ORIGINS: "https://user:private-value@team.example.test" },
      { T3_TEAM_ORIGINS: "https://team.example.test/path" },
      { T3_TEAM_ORIGINS: "http://public.example.test" },
      { T3_TEAM_OAUTH_CLIENT_ID: "" },
      { T3_TEAM_OAUTH_ISSUER: "" },
      { T3_TEAM_OAUTH_ISSUER: "https://issuer.example.test/path" },
      { T3_TEAM_OAUTH_CLIENT_ID: " " },
    ];
    for (const invalid of cases) {
      const result = yield* requireTeamServiceConfiguration.pipe(
        Effect.provide(configuration({ ...configured, ...invalid })),
        Effect.flip,
      );
      expect(result._tag).toBe("TeamServiceConfigurationError");
      expect(result.message).toContain(Object.keys(invalid)[0]);
      expect(result.message).not.toContain("private-value");
      expect(result.message).not.toContain(configured.T3_TEAM_CLERK_SECRET_KEY);
    }
    yield* requireTeamServiceConfiguration.pipe(Effect.provide(configuration(configured)));
    yield* requireTeamServiceConfiguration.pipe(
      Effect.provide(
        configuration({
          ...configured,
          T3_TEAM_OAUTH_CLIENT_ID: "",
          T3_TEAM_OAUTH_ISSUER: "",
        }),
      ),
    );
  }),
);

it.effect(
  "dedicated startup serves collaboration only and creates no personal runtime artifacts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-service-" });
      const config = yield* resolveTeamServiceConfig(
        { baseDir: Option.some(baseDir), port: Option.some(0), host: Option.none() },
        Option.none(),
      );
      expect(yield* fs.readDirectory(baseDir)).toEqual([]);
      const staticDir = path.join(baseDir, "client");
      yield* fs.makeDirectory(path.join(staticDir, "assets"), { recursive: true });
      yield* fs.makeDirectory(path.join(staticDir, ".vite"));
      yield* fs.writeFileString(path.join(staticDir, "index.html"), "<html>management</html>");
      yield* fs.writeFileString(
        path.join(staticDir, "assets/app-12345678.js"),
        "export const app = true;",
      );
      yield* fs.writeFileString(
        path.join(staticDir, ".vite/manifest.json"),
        '{"main":{"file":"assets/app-12345678.js"}}',
      );
      const logs: unknown[] = [];
      const context = yield* Layer.build(
        teamServiceLayer.pipe(Layer.provide(configuration(configured))),
      ).pipe(
        Effect.provideService(ServerConfig, { ...config, staticDir }),
        Effect.provideService(
          Logger.CurrentLoggers,
          new Set([
            Logger.make(({ message }) => {
              logs.push(message);
            }),
          ]),
        ),
      );
      expect(logs.flat()).toContain(TEAM_SERVICE_READY);
      const server = Context.get(context, HttpServer.HttpServer);
      if (server.address._tag !== "InetAddressV4" && server.address._tag !== "InetAddressV6")
        throw new Error("Expected TCP test listener");
      const origin = `http://127.0.0.1:${server.address.port}`;
      const request = (
        route: string,
        method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" = "GET",
      ) =>
        HttpClient.execute(HttpClientRequest.make(method)(origin + route)).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        );
      const root = yield* request("/");
      expect(root.status).toBe(302);
      expect(root.headers.location).toBe("/spaces");
      const spaces = yield* request("/spaces");
      expect(spaces.status).toBe(200);
      expect(yield* spaces.text).toBe("<html>management</html>");
      const team = yield* request("/api/team/config");
      expect(yield* team.json).toEqual({
        enabled: true,
        publishableKey: configured.T3_TEAM_CLERK_PUBLISHABLE_KEY,
        agentExecution: "local",
        oauth: { issuer: configured.T3_TEAM_OAUTH_ISSUER, clientId: "public-client" },
      });
      const asset = yield* request("/assets/app-12345678.js");
      expect(asset.status).toBe(200);
      yield* asset.text;
      expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
      const head = yield* request("/assets/app-12345678.js", "HEAD");
      expect(head.status).toBe(200);
      expect(yield* head.text).toBe("");
      for (const route of [
        "/api/config",
        "/api/team/local-account",
        "/api/auth/pair",
        "/api/terminal",
        "/api/workspace",
        "/api/dashboard",
        "/api/preview",
        "/api/relay",
        "/ws",
        "/ws/nested",
        "/oauth",
        "/oauth/token",
        "/.well-known/openid-configuration",
        "/mcp",
        "/mcp/nested",
        "/unknown",
        "/assets/missing.js",
      ]) {
        for (const method of [
          "GET",
          "HEAD",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "OPTIONS",
        ] as const) {
          const response = yield* request(route, method);
          expect(response.status, `${method} ${route}`).toBe(404);
          expect(response.headers["content-type"] ?? "").not.toContain("text/html");
          yield* response.text;
        }
      }
      for (const route of [
        "/api/team/account",
        "/api/team/spaces",
        "/api/team/snapshot",
        "/api/team/provider-status",
        "/api/team/projects/0123456789abcdef0123456789abcdef/native/shell-snapshot",
      ]) {
        const response = yield* request(route);
        expect(response.status).toBe(403);
        yield* response.text;
      }
      for (const unavailable of [
        config.secretsDir,
        config.settingsPath,
        config.environmentIdPath,
        config.anonymousIdPath,
        config.serverRuntimeStatePath,
        config.worktreesDir,
        config.providerLogsDir,
        config.terminalLogsDir,
        config.attachmentsDir,
      ])
        expect(yield* fs.exists(unavailable)).toBe(false);
      expect(yield* fs.exists(config.dbPath)).toBe(true);
      expect(yield* fs.exists(path.join(config.stateDir, "team-native/service-id"))).toBe(true);
    }).pipe(
      Effect.scoped,
      // Node listener shutdown completes through real callbacks, including the zero-grace finalizer.
      TestClock.withLive,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
);

it.effect("invalid dedicated startup fails before opening a listener or creating persistence", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-service-invalid-" });
    const config = yield* resolveTeamServiceConfig(
      { baseDir: Option.some(baseDir), port: Option.some(0), host: Option.none() },
      Option.none(),
    );
    const failure = yield* Layer.build(teamServiceLayer).pipe(
      Effect.provideService(ServerConfig, config),
      Effect.provide(configuration({})),
      Effect.flip,
    );
    expect(failure._tag).toBe("TeamServiceConfigurationError");
    expect(yield* fs.readDirectory(baseDir)).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("normal static routing preserves personal SPA fallback", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-personal-static-" });
    const config = yield* resolveTeamServiceConfig(
      { baseDir: Option.some(baseDir), port: Option.none(), host: Option.none() },
      Option.none(),
    );
    yield* fs.writeFileString(path.join(baseDir, "index.html"), "<html>personal</html>");
    const app = HttpRouter.toWebHandler(
      staticAndDevRouteLayer.pipe(
        Layer.provideMerge(Layer.succeed(ServerConfig, { ...config, staticDir: baseDir })),
        Layer.provideMerge(NodeServices.layer),
      ),
      { disableLogger: true },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => app.dispose()));
    for (const route of ["/", "/thread/old", "/api/missing"]) {
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request(`https://personal.example.test${route}`),
          Context.make(ServerConfig, { ...config, staticDir: baseDir }),
        ),
      );
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.text())).toBe("<html>personal</html>");
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "team-service CLI rejects missing configuration before personal startup or data setup",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-team-cli-invalid-" });
      const failure = yield* Command.runWith(teamServiceCommand, { version: "0.0.0" })([
        "--base-dir",
        baseDir,
      ]).pipe(Effect.provide(configuration({})), Effect.flip);
      expect(failure._tag).toBe("TeamServiceConfigurationError");
      expect(yield* fs.readDirectory(baseDir)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
