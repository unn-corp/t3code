import { describe, expect, it } from "@effect/vitest";

import { executableOf, resolveWslHome, wslCommandFromStartArgs } from "./wslTransport.ts";

const SELF_CONTAINED = [
  "-d",
  "Ubuntu",
  "--exec",
  "env",
  "PATH=/usr/bin:/home/u/.nvm/bin",
  "/home/u/.t3/wsl-runtime/sha256-a/t3",
  "--bootstrap-fd",
  "0",
];

describe("wslCommandFromStartArgs", () => {
  it("recovers the runtime the running backend uses, so maintenance verbs run exactly that program", () => {
    expect(wslCommandFromStartArgs(SELF_CONTAINED)).toEqual({
      distroArgs: ["-d", "Ubuntu"],
      path: "/usr/bin:/home/u/.nvm/bin",
      command: ["/home/u/.t3/wsl-runtime/sha256-a/t3"],
    });
  });

  it("accepts the default distribution", () => {
    expect(wslCommandFromStartArgs(SELF_CONTAINED.slice(2))?.distroArgs).toEqual([]);
  });

  it("ignores the dev-url arguments that follow the bootstrap flag", () => {
    expect(
      wslCommandFromStartArgs([...SELF_CONTAINED, "--dev-url", "http://localhost:5733"])?.command,
    ).toEqual(["/home/u/.t3/wsl-runtime/sha256-a/t3"]);
  });

  it("fails closed on a launch shape it does not recognise", () => {
    expect(wslCommandFromStartArgs(["--exec", "node", "--version"])).toBeNull();
    expect(
      wslCommandFromStartArgs(["-d", "--exec", "env", "PATH=/x", "/t3", "--bootstrap-fd", "0"]),
    ).toBeNull();
    expect(
      wslCommandFromStartArgs(["--exec", "env", "HOME=/x", "/t3", "--bootstrap-fd", "0"]),
    ).toBeNull();
    expect(wslCommandFromStartArgs(["--exec", "env", "PATH=/x", "--bootstrap-fd", "0"])).toBeNull();
  });
});

describe("executableOf", () => {
  it("accepts only a self-contained program, never a node plus script pair that depends on a changeable Node", () => {
    expect(executableOf(wslCommandFromStartArgs(SELF_CONTAINED))).toBe(
      "/home/u/.t3/wsl-runtime/sha256-a/t3",
    );
    expect(
      executableOf({
        distroArgs: [],
        path: "/usr/bin",
        command: ["/usr/bin/node", "/repo/apps/server/dist/bin.mjs"],
      }),
    ).toBeNull();
    expect(executableOf(null)).toBeNull();
  });
});

describe("resolveWslHome", () => {
  it("asks the distribution for the canonical path of its own home", async () => {
    const calls: string[][] = [];
    const home = await resolveWslHome("Ubuntu", async (command, args) => {
      calls.push([command, ...args]);
      return { code: 0, stdout: "motd noise\n/home/u/.t3\n", stderr: "" };
    });
    expect(home).toBe("/home/u/.t3");
    expect(calls[0]?.slice(0, 4)).toEqual(["wsl.exe", "-d", "Ubuntu", "--exec"]);
  });

  it("returns null when the distribution cannot answer", async () => {
    expect(
      await resolveWslHome("Ubuntu", async () => ({ code: 1, stdout: "", stderr: "not running" })),
    ).toBeNull();
    expect(
      await resolveWslHome("Ubuntu", async () => ({
        code: 0,
        stdout: "relative/path\n",
        stderr: "",
      })),
    ).toBeNull();
  });
});
