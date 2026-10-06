// @effect-diagnostics nodeBuiltinImport:off globalConsole:off processEnv:off
/** Executable entry used only by the standalone recovery-helper bundle. */
import { main } from "./forkRecoveryHelper.ts";

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (cause) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exit(1);
  },
);
