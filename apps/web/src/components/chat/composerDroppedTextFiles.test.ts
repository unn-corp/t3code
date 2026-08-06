import { describe, expect, it } from "vite-plus/test";

import { formatDroppedTextFiles } from "./composerDroppedTextFiles";

const file = (name: string, contents: string, size = contents.length) => ({
  name,
  size,
  text: async () => contents,
});

describe("formatDroppedTextFiles", () => {
  it("adds a labelled text-file block to the prompt", async () => {
    await expect(
      formatDroppedTextFiles([file("config.json", '{"enabled":true}')]),
    ).resolves.toEqual({
      text: '\n\n<attached-file name="config.json">\n{"enabled":true}\n</attached-file>',
      rejectedNames: [],
    });
  });

  it("rejects binary-looking and oversized files", async () => {
    await expect(
      formatDroppedTextFiles([
        file("archive.zip", "PK\0binary"),
        file("large.log", "ok", 512 * 1024 + 1),
      ]),
    ).resolves.toEqual({ text: "", rejectedNames: ["archive.zip", "large.log"] });
  });
});
