import { assert, describe, it } from "@effect/vitest";
import { appendCliSmokeOutput, redactCliSmokeOutput } from "./cli-smoke-output.ts";

describe("CLI smoke output capture", () => {
  it("retains failure output incrementally with a fixed bound", () => {
    const beforeFailure = appendCliSmokeOutput("", "startup began\n");
    const afterFailure = appendCliSmokeOutput(beforeFailure, "maintenance startup refused\n");
    assert.include(afterFailure, "startup began");
    assert.include(afterFailure, "maintenance startup refused");

    const noisy = appendCliSmokeOutput(afterFailure, "x".repeat(30_000));
    assert.lengthOf(noisy, 20_000);
    assert.include(noisy, "[earlier output omitted]");
    assert.include(noisy, "x".repeat(100));
    assert.notInclude(noisy, "startup began");
    const finalLine = appendCliSmokeOutput(noisy, "late failure\n");
    assert.lengthOf(finalLine, 20_000);
    assert.include(finalLine, "late failure\n");
  });

  it("preserves failure evidence without publishing pairing credentials or their QR code", () => {
    const output = redactCliSmokeOutput(
      "Listening on http://127.0.0.1:47700\nToken: SECRET\nPairing URL: https://host/pair?token=SECRET\nConnection string: http://host?t3=SECRET\n  █▀▀▀▀▀█ QR_SECRET\nstartup refused: owner unreadable\nstderr: ACL failed\n",
    );
    assert.notInclude(output, "SECRET");
    assert.notInclude(output, "http");
    assert.include(output, "Listening on");
    assert.include(output, "startup refused: owner unreadable");
    assert.include(output, "stderr: ACL failed");
  });
});
