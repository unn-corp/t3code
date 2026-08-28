import { RuntimeMode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { RUNTIME_MODE_PRESENTATION } from "./runtimeModePresentation";

describe("runtime mode presentation", () => {
  it("defines composer presentation for every runtime mode", () => {
    expect(Object.keys(RUNTIME_MODE_PRESENTATION).toSorted()).toEqual(
      [...RuntimeMode.literals].toSorted(),
    );
  });
});
