import { describe, expect, it } from "vite-plus/test";

import { imageFilesFromDataTransfer } from "./composerImageClipboard";

const image = new File(["image"], "clipboard.png", { type: "image/png" });

describe("imageFilesFromDataTransfer", () => {
  it("uses clipboard files when they are available", () => {
    expect(
      imageFilesFromDataTransfer({
        files: [image] as unknown as FileList,
        items: [] as unknown as DataTransferItemList,
      }),
    ).toEqual([image]);
  });

  it("falls back to image clipboard items when FileList is empty", () => {
    expect(
      imageFilesFromDataTransfer({
        files: [] as unknown as FileList,
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => image,
          },
        ] as unknown as DataTransferItemList,
      }),
    ).toEqual([image]);
  });

  it("does not claim non-image clipboard items", () => {
    expect(
      imageFilesFromDataTransfer({
        files: [] as unknown as FileList,
        items: [
          {
            kind: "file",
            type: "application/pdf",
            getAsFile: () => new File(["pdf"], "file.pdf", { type: "application/pdf" }),
          },
        ] as unknown as DataTransferItemList,
      }),
    ).toEqual([]);
  });
});
