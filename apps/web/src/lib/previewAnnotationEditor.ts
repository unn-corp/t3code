import type {
  PreviewAnnotationElementTarget,
  PreviewAnnotationPayload,
  PreviewAnnotationPoint,
  PreviewAnnotationRect,
} from "@t3tools/contracts";

export function annotationPoint(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  x: number,
  y: number,
  width: number,
  height: number,
): PreviewAnnotationPoint {
  return {
    x: Math.max(0, Math.min(width, ((x - rect.left) / Math.max(1, rect.width)) * width)),
    y: Math.max(0, Math.min(height, ((y - rect.top) / Math.max(1, rect.height)) * height)),
  };
}
export function annotationRegion(
  a: PreviewAnnotationPoint,
  b: PreviewAnnotationPoint,
): PreviewAnnotationRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}
export function snapshotElementAt(
  elements: readonly PreviewAnnotationElementTarget[],
  point: PreviewAnnotationPoint,
): PreviewAnnotationElementTarget | null {
  return (
    elements
      .filter(
        ({ rect }) =>
          point.x >= rect.x &&
          point.y >= rect.y &&
          point.x <= rect.x + rect.width &&
          point.y <= rect.y + rect.height,
      )
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0] ?? null
  );
}
export function appendAnnotationTranscript(comment: string, transcript: string): string {
  const text = transcript.trim();
  return text ? `${comment}${comment && !/\s$/.test(comment) ? " " : ""}${text}` : comment;
}

/** Render marks onto the frozen image, without asking the live page to capture again. */
export async function renderAnnotationScreenshot(
  annotation: PreviewAnnotationPayload,
): Promise<PreviewAnnotationPayload> {
  const screenshot = annotation.screenshot;
  if (!screenshot) return annotation;
  const image = new Image();
  image.src = screenshot.dataUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = screenshot.width;
  canvas.height = screenshot.height;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error("Could not prepare the annotated screenshot. Your annotation is still saved.");
  context.drawImage(image, 0, 0);
  context.scale(
    screenshot.width / screenshot.cropRect.width,
    screenshot.height / screenshot.cropRect.height,
  );
  context.strokeStyle = "#2563eb";
  context.lineWidth = 2;
  for (const rect of [
    ...annotation.elements.map((target) => target.rect),
    ...annotation.regions.map((target) => target.rect),
  ])
    context.strokeRect(rect.x, rect.y, rect.width, rect.height);
  for (const stroke of annotation.strokes) {
    context.strokeStyle = stroke.color;
    context.lineWidth = stroke.width;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.beginPath();
    stroke.points.forEach((point, index) =>
      index === 0 ? context.moveTo(point.x, point.y) : context.lineTo(point.x, point.y),
    );
    context.stroke();
  }
  return { ...annotation, screenshot: { ...screenshot, dataUrl: canvas.toDataURL("image/png") } };
}
