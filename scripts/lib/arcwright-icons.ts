import { PNG } from "pngjs";
import sharp from "sharp";

export const ICON_BACKGROUND = "#0a0a0a";

// Neutral lettering changes with the surface; the blue bolt and alpha stay intact.
export function lightLettering(contents: Buffer): Buffer {
  const image = PNG.sync.read(contents);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset]!;
    const green = image.data[offset + 1]!;
    const blue = image.data[offset + 2]!;
    if (Math.max(red, green, blue) - Math.min(red, green, blue) <= 24) {
      image.data[offset] = 255 - red;
      image.data[offset + 1] = 255 - green;
      image.data[offset + 2] = 255 - blue;
    }
  }
  return PNG.sync.write(image);
}

export function monochromeLogo(contents: Buffer): Buffer {
  const image = PNG.sync.read(contents);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = 255;
    image.data[offset + 1] = 255;
    image.data[offset + 2] = 255;
  }
  return PNG.sync.write(image);
}

export async function trimLogo(contents: Buffer): Promise<Buffer> {
  return sharp(contents).trim({ background: "#00000000", threshold: 1 }).png().toBuffer();
}

export async function renderLogoCanvas(
  mark: Buffer,
  size: number,
  fraction = 0.76,
  background = ICON_BACKGROUND,
): Promise<Buffer> {
  const extent = Math.round(size * fraction);
  const artwork = await sharp(await trimLogo(mark))
    .resize(extent, extent, { fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([
      {
        input: artwork.data,
        left: Math.floor((size - artwork.info.width) / 2),
        top: Math.floor((size - artwork.info.height) / 2),
      },
    ])
    .png()
    .toBuffer();
}

export async function renderMacIcon(mark: Buffer): Promise<Buffer> {
  // Keep the classic macOS 824px body inside its 1024px canvas.
  const mask = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="824" height="824"><rect width="824" height="824" rx="184" fill="white"/></svg>',
  );
  const body = await sharp(await renderLogoCanvas(mark, 824))
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  return sharp({
    create: { width: 1024, height: 1024, channels: 4, background: "#00000000" },
  })
    .composite([{ input: body, left: 100, top: 100 }])
    .png()
    .toBuffer();
}
