import * as Effect from "effect/Effect";
import { AcpRequestError } from "effect-acp/errors";

import type { AcpSessionRuntime } from "../provider/acp/AcpSessionRuntime.ts";

/** Denies ACP client tools. Provider-owned tools and global hooks remain within the provider's trust boundary. */
export const denyArchitectAcpTools = Effect.fn("denyArchitectAcpTools")(function* (
  runtime: AcpSessionRuntime["Service"],
) {
  const denyClientTool = () =>
    Effect.fail(
      new AcpRequestError({
        code: -32601,
        errorMessage: "Tools are disabled for Organization Architect generation.",
      }),
    );

  yield* runtime.handleRequestPermission(() =>
    Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
  );
  yield* runtime.handleElicitation(() => Effect.succeed({ action: "decline" as const }));
  yield* runtime.handleReadTextFile(denyClientTool);
  yield* runtime.handleWriteTextFile(denyClientTool);
  yield* runtime.handleCreateTerminal(denyClientTool);
  yield* runtime.handleTerminalOutput(denyClientTool);
  yield* runtime.handleTerminalWaitForExit(denyClientTool);
  yield* runtime.handleTerminalKill(denyClientTool);
  yield* runtime.handleTerminalRelease(denyClientTool);
  yield* runtime.handleUnknownExtRequest(denyClientTool);
});
