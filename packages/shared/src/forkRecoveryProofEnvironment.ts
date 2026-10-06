// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export interface RecoveryProofPaths {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly temp: string;
  readonly appData: string;
  readonly localAppData: string;
  readonly coordinator: string;
}

/**
 * Keep recovery proof processes away from developer tools and private data while
 * retaining only the Windows account and system locations needed by OS ACL tools.
 */
export function recoveryProofEnvironment(input: {
  readonly platform: "linux-x64" | "windows-x64";
  readonly paths: RecoveryProofPaths;
  readonly inherited?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  if (input.platform === "linux-x64")
    return {
      PATH: "",
      HOME: input.paths.home,
      TMPDIR: input.paths.temp,
      T3CODE_MAINTENANCE_NAMESPACE: input.paths.coordinator,
    };

  const inherited = input.inherited ?? {};
  const value = (name: string) =>
    Object.entries(inherited).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const systemRoot = value("SystemRoot");
  const username = value("USERNAME");
  const userdomain = value("USERDOMAIN");
  if (!systemRoot || !username)
    throw new Error("Windows recovery proof requires SystemRoot and USERNAME.");

  const windowsPath = NodePath.win32;
  const system32 = windowsPath.join(systemRoot, "System32");
  return {
    SystemRoot: systemRoot,
    SystemDrive: value("SystemDrive") ?? windowsPath.parse(systemRoot).root.replace(/\\$/, ""),
    OS: "Windows_NT",
    ComSpec: windowsPath.join(system32, "cmd.exe"),
    USERNAME: username,
    ...(userdomain === undefined ? {} : { USERDOMAIN: userdomain }),
    PATH: [system32, windowsPath.join(system32, "WindowsPowerShell", "v1.0")].join(";"),
    HOME: input.paths.home,
    USERPROFILE: input.paths.home,
    TEMP: input.paths.temp,
    TMP: input.paths.temp,
    APPDATA: input.paths.appData,
    LOCALAPPDATA: input.paths.localAppData,
    T3CODE_MAINTENANCE_NAMESPACE: input.paths.coordinator,
  };
}
