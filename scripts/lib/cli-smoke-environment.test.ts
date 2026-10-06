// @effect-diagnostics nodeBuiltinImport:off - exercises Windows and POSIX path contracts on either runner.
import * as NodePath from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { cliSmokeEnvironment } from "./cli-smoke-environment.ts";

describe("archive smoke environment", () => {
  const inherited = {
    PATH: "C:\\developer\\node;C:\\developer\\providers",
    SystemRoot: "D:\\Windows",
    USERNAME: "fixture-operator",
    USERDOMAIN: "DEVICE",
    NODE_OPTIONS: "--require private-bootstrap.js",
    T3CODE_HOME: "C:\\real-data",
    T3CODE_MAINTENANCE_NAMESPACE: "C:\\real-coordinator",
    API_KEY: "private",
  };

  it("allows Windows OS tools without inheriting developer tools or credentials", () => {
    const env = cliSmokeEnvironment({
      platform: "win32",
      home: "C:\\fixture\\home",
      scratch: "C:\\fixture",
      inherited,
      join: NodePath.win32.join,
    });
    assert.include(env.PATH!, "D:\\Windows\\System32");
    assert.include(env.PATH!, "D:\\Windows\\System32\\WindowsPowerShell\\v1.0");
    assert.notInclude(env.PATH!, "developer");
    assert.equal(env.USERNAME, "fixture-operator");
    assert.equal(env.ComSpec, "D:\\Windows\\System32\\cmd.exe");
    assert.isUndefined(env.NODE_OPTIONS);
    assert.isUndefined(env.API_KEY);
    assert.equal(env.T3CODE_HOME, "C:\\fixture\\home");
    assert.equal(env.T3CODE_MAINTENANCE_NAMESPACE, "C:\\fixture\\coordinator");
    assert.equal(env.APPDATA, "C:\\fixture\\home\\AppData\\Roaming");
    assert.equal(env.LOCALAPPDATA, "C:\\fixture\\home\\AppData\\Local");
  });

  it("uses windir when SystemRoot is unavailable", () => {
    const env = cliSmokeEnvironment({
      platform: "win32",
      home: "C:\\fixture\\home",
      scratch: "C:\\fixture",
      inherited: { windir: "E:\\Windows" },
      join: NodePath.win32.join,
    });
    assert.include(env.PATH!, "E:\\Windows\\System32");
    assert.equal(env.SystemRoot, "E:\\Windows");
    assert.isUndefined(env.USERNAME);
  });

  it("keeps POSIX paths empty and runtime data inside the fixture", () => {
    const env = cliSmokeEnvironment({
      platform: "linux",
      home: "/fixture/home",
      scratch: "/fixture",
      inherited,
      join: NodePath.posix.join,
    });
    assert.equal(env.PATH, "");
    assert.equal(env.T3CODE_HOME, "/fixture/home");
    assert.equal(env.T3CODE_MAINTENANCE_NAMESPACE, "/fixture/coordinator");
    assert.isUndefined(env.SystemRoot);
    assert.isUndefined(env.API_KEY);
  });
});
