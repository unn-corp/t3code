import { expect, it } from "vite-plus/test";
import {
  annotationPoint,
  annotationRegion,
  appendAnnotationTranscript,
  snapshotElementAt,
} from "./previewAnnotationEditor";
import type { PreviewAnnotationElementTarget } from "@t3tools/contracts";

it("maps scaled screenshot gestures to the captured viewport and bounds marks", () => {
  expect(
    annotationPoint({ left: 20, top: 30, width: 400, height: 300 }, 220, 180, 800, 600),
  ).toEqual({ x: 400, y: 300 });
  expect(
    annotationPoint({ left: 20, top: 30, width: 400, height: 300 }, -10, 500, 800, 600),
  ).toEqual({ x: 0, y: 600 });
  expect(annotationRegion({ x: 100, y: 200 }, { x: 40, y: 50 })).toEqual({
    x: 40,
    y: 50,
    width: 60,
    height: 150,
  });
});
it("selects the smallest captured element under a point without consulting the live page", () => {
  const element = {
    pageUrl: "https://example.com",
    pageTitle: null,
    tagName: "button",
    selector: "#button",
    htmlPreview: "<button>Send</button>",
    componentName: null,
    source: null,
    stack: [],
    styles: "",
    pickedAt: "2026-10-08T00:00:00.000Z",
  };
  const targets: PreviewAnnotationElementTarget[] = [
    { id: "container", element, rect: { x: 0, y: 0, width: 300, height: 300 } },
    { id: "button", element, rect: { x: 50, y: 50, width: 80, height: 40 } },
  ];
  expect(snapshotElementAt(targets, { x: 70, y: 60 })?.id).toBe("button");
  expect(snapshotElementAt(targets, { x: 600, y: 60 })).toBeNull();
});
it("keeps typed comments when a transcript arrives", () => {
  expect(appendAnnotationTranscript("Make it smaller.", " Also use blue. ")).toBe(
    "Make it smaller. Also use blue.",
  );
  expect(appendAnnotationTranscript("Existing text\n", "More text")).toBe(
    "Existing text\nMore text",
  );
  expect(appendAnnotationTranscript("Existing", "   ")).toBe("Existing");
});
