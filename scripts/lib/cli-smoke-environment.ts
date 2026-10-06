/** Keep archive checks independent of developer tooling while retaining Windows OS prerequisites. */
export function cliSmokeEnvironment(input: {
  platform: NodeJS.Platform;
  home: string;
  scratch: string;
  inherited: NodeJS.ProcessEnv;
  join: (...parts: string[]) => string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: "",
    HOME: input.home,
    USERPROFILE: input.home,
    TMPDIR: input.scratch,
    TEMP: input.scratch,
    TMP: input.scratch,
    T3CODE_HOME: input.home,
    T3CODE_MAINTENANCE_NAMESPACE: input.join(input.scratch, "coordinator"),
  };
  if (input.platform === "win32") {
    const root = input.inherited.SystemRoot ?? input.inherited.windir ?? "C:\\Windows";
    const system = input.join(root, "System32");
    Object.assign(env, {
      SystemRoot: root,
      windir: root,
      ComSpec: input.join(system, "cmd.exe"),
      // ACL enforcement and process ownership need icacls and Windows PowerShell.
      // Node/provider/toolchain install directories remain excluded.
      PATH: [system, input.join(system, "WindowsPowerShell", "v1.0")].join(";"),
      USERNAME: input.inherited.USERNAME,
      USERDOMAIN: input.inherited.USERDOMAIN,
      APPDATA: input.join(input.home, "AppData", "Roaming"),
      LOCALAPPDATA: input.join(input.home, "AppData", "Local"),
    });
  }
  return env;
}
