/**
 * Read image files from a browser clipboard/data-transfer payload.
 *
 * Chromium on Linux does not consistently populate `files` for an image copied
 * from every Wayland/X11 source, even when it exposes the same image through
 * `items`. Prefer the normal FileList, then fall back to the item API.
 */
export function imageFilesFromDataTransfer(
  dataTransfer: Pick<DataTransfer, "files" | "items">,
): File[] {
  const files = Array.from(dataTransfer.files).filter((file) => file.type.startsWith("image/"));
  if (files.length > 0) {
    return files;
  }

  return Array.from(dataTransfer.items).flatMap((item) => {
    if (item.kind !== "file" || !item.type.startsWith("image/")) {
      return [];
    }
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}
