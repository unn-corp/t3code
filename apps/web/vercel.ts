import { matchers, type Transform, type VercelConfig } from "@vercel/config/v1";

const ROUTER_HOST = "app.t3.codes";
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const LATEST_ORIGIN = "https://latest.app.t3.codes";
const NIGHTLY_ORIGIN = "https://nightly.app.t3.codes";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

// `@vercel/config` intentionally models only the modern route shape, while
// Vercel's runtime still supports this phase marker. The filesystem phase is
// essential here: the hosted app is an SPA, but its worker, manifest, sounds,
// and icons must be served as their real static files before the SPA fallback.
type FilesystemRoute = { readonly handle: "filesystem" };
type VercelConfigWithFilesystemRoute = Omit<VercelConfig, "routes"> & {
  readonly routes: ReadonlyArray<NonNullable<VercelConfig["routes"]>[number] | FilesystemRoute>;
};

export const config = {
  buildCommand:
    'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: [
    {
      src: "/__t3code/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__t3code/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${NIGHTLY_ORIGIN}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(ROUTER_HOST)],
      dest: `${LATEST_ORIGIN}/$1`,
    },
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/index.html" },
  ],
} satisfies VercelConfigWithFilesystemRoute;
