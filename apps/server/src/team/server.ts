import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { ServerConfig } from "../config.ts";
import { HTTP_ROUTER_CONFIG, HttpServerLive, PlatformServicesLive } from "../httpPlatform.ts";
import { layerConfig as SqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { teamStaticRouteLayer } from "../staticHttp.ts";
import { teamSpacesRouteLayer } from "./http.ts";
import { requireTeamServiceConfiguration } from "./serviceConfig.ts";

export const TEAM_SERVICE_READY = "Teams collaboration service is ready.";
export const teamServiceRoutes = Layer.mergeAll(teamSpacesRouteLayer, teamStaticRouteLayer);

// This graph deliberately has no personal runtime, provider, reactor, pairing,
// terminal, or local account administration layers.
export const teamServiceLayer = Layer.unwrap(
  Effect.gen(function* () {
    yield* requireTeamServiceConfiguration;
    const config = yield* ServerConfig;
    return HttpRouter.serve(teamServiceRoutes, {
      disableLogger: !config.logWebSocketEvents,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(
      Layer.provide(SqlitePersistenceLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(PlatformServicesLive),
      Layer.tap(() => Effect.logInfo(TEAM_SERVICE_READY)),
    );
  }),
);

export const runTeamService = Layer.launch(teamServiceLayer);
