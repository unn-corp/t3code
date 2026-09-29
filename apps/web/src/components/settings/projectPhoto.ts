const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = 65_536;

/** Store a small, portable thumbnail in the project metadata. */
export async function projectPhotoFromFile(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Choose an image smaller than 10 MB.");

  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable.");
    for (const size of [128, 96, 64]) {
      const scale = Math.min(1, size / bitmap.width, size / bitmap.height);
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/webp", 0.85);
      if (dataUrl.startsWith("data:image/webp;base64,") && dataUrl.length <= MAX_DATA_URL_LENGTH) {
        return dataUrl;
      }
    }
    throw new Error("Could not prepare this photo. Try a smaller image.");
  } finally {
    bitmap.close();
  }
}
