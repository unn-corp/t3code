/**
 * Finding a Chromium to render previews with, on a host that has no desktop app.
 *
 * Deliberately never downloads a browser. `npx t3` is a small install and a
 * ~150MB Chromium download on first preview would be a surprising thing for it
 * to do. If the machine already has Chrome, Chromium, or Edge, previews work;
 * if it does not, the viewer is told so and nothing else changes.
 */
export const CHROMIUM_PATH_ENV_VARS = [
  "T3_CHROMIUM_PATH",
  "CHROME_PATH",
  "PUPPETEER_EXECUTABLE_PATH",
] as const;

/** Candidate binaries per platform, most preferred first. */
const CANDIDATES: Record<string, ReadonlyArray<string>> = {
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
    "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
};

export interface ChromiumDiscoveryInput {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Injected so discovery stays a pure decision, testable without a disk. */
  readonly exists: (path: string) => boolean;
}

/**
 * An explicit env var always wins, even over a better-known install: someone
 * who set it is telling us which browser to use. It is honoured only when the
 * path actually exists, so a stale value falls through to discovery rather than
 * failing every launch.
 */
export function discoverChromium(input: ChromiumDiscoveryInput): string | null {
  for (const name of CHROMIUM_PATH_ENV_VARS) {
    const configured = input.env[name];
    if (configured && configured.length > 0 && input.exists(configured)) {
      return configured;
    }
  }
  for (const candidate of CANDIDATES[input.platform] ?? []) {
    if (input.exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Flags for a preview browser. Headless, isolated to a scratch profile, and
 * with no first-run interstitials that would render instead of the page.
 * `--remote-debugging-port=0` lets the OS pick, so two servers on one machine
 * cannot collide.
 */
export function chromiumLaunchArgs(userDataDir: string): ReadonlyArray<string> {
  return [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--mute-audio",
    "about:blank",
  ];
}

const DEVTOOLS_ENDPOINT = /^DevTools listening on (ws:\/\/\S+)$/mu;

/**
 * Chromium prints its debugger endpoint to stderr once, and the port is only
 * knowable from that line when the port was left to the OS.
 */
export function parseDevToolsEndpoint(stderrChunk: string): string | null {
  return DEVTOOLS_ENDPOINT.exec(stderrChunk)?.[1] ?? null;
}
