import { expect, it } from "@effect/vitest";

import {
  chromiumLaunchArgs,
  discoverChromium,
  parseDevToolsEndpoint,
} from "./chromiumDiscovery.ts";

const never = () => false;
const always = () => true;

it("prefers an explicitly configured browser over a discovered one", () => {
  expect(
    discoverChromium({
      platform: "linux",
      env: { T3_CHROMIUM_PATH: "/opt/my-chrome" },
      exists: always,
    }),
  ).toBe("/opt/my-chrome");
});

it("honours the puppeteer and chrome path conventions", () => {
  expect(
    discoverChromium({ platform: "linux", env: { CHROME_PATH: "/opt/a" }, exists: always }),
  ).toBe("/opt/a");
  expect(
    discoverChromium({
      platform: "linux",
      env: { PUPPETEER_EXECUTABLE_PATH: "/opt/b" },
      exists: always,
    }),
  ).toBe("/opt/b");
});

it("falls through to discovery when the configured path is stale", () => {
  expect(
    discoverChromium({
      platform: "linux",
      env: { T3_CHROMIUM_PATH: "/opt/removed" },
      exists: (path) => path === "/usr/bin/chromium",
    }),
  ).toBe("/usr/bin/chromium");
});

it("ignores an empty configured path", () => {
  expect(
    discoverChromium({
      platform: "linux",
      env: { T3_CHROMIUM_PATH: "" },
      exists: (path) => path === "/usr/bin/google-chrome",
    }),
  ).toBe("/usr/bin/google-chrome");
});

it("picks the most preferred installed browser", () => {
  expect(
    discoverChromium({
      platform: "linux",
      env: {},
      exists: (path) => path === "/usr/bin/chromium" || path === "/usr/bin/google-chrome",
    }),
  ).toBe("/usr/bin/google-chrome");
});

it("finds a browser on macOS and Windows", () => {
  expect(discoverChromium({ platform: "darwin", env: {}, exists: always })).toContain(
    "Google Chrome",
  );
  expect(discoverChromium({ platform: "win32", env: {}, exists: always })).toContain("chrome.exe");
});

it("returns null when the machine has no browser, rather than guessing", () => {
  expect(discoverChromium({ platform: "linux", env: {}, exists: never })).toBeNull();
});

it("returns null on a platform it knows nothing about", () => {
  expect(discoverChromium({ platform: "aix", env: {}, exists: always })).toBeNull();
});

it("leaves the debugging port to the OS so two servers cannot collide", () => {
  expect(chromiumLaunchArgs("/tmp/profile")).toContain("--remote-debugging-port=0");
  expect(chromiumLaunchArgs("/tmp/profile")).toContain("--user-data-dir=/tmp/profile");
});

it("reads the debugger endpoint chromium prints on startup", () => {
  expect(
    parseDevToolsEndpoint(
      "Some other line\nDevTools listening on ws://127.0.0.1:41235/devtools/browser/abc-123\n",
    ),
  ).toBe("ws://127.0.0.1:41235/devtools/browser/abc-123");
});

it("returns null until the endpoint line has actually arrived", () => {
  expect(parseDevToolsEndpoint("still starting up")).toBeNull();
  expect(parseDevToolsEndpoint("DevTools listening on ")).toBeNull();
});
