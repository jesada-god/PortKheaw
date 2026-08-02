/**
 * Regenerates the Kheaw brand mark and app icons from the source artwork.
 *
 * This is a one-off asset generator, not part of `npm run build` — its outputs
 * (public/brand/kheaw-mark.png and public/icons/*.png) are committed, so nobody
 * needs to run it to build or deploy the app. `sharp` is therefore deliberately
 * NOT a declared dependency: adding a native image toolchain to every install
 * to serve a script that runs once per brand change is not worth it. Install it
 * on demand when you actually need to regenerate:
 *
 *   npm i -D --no-save sharp && node scripts/build-kheaw-assets.mjs
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sharp = await import('sharp').then((module) => module.default).catch(() => {
  console.error(
    'This script needs sharp, which is not a project dependency by design.\n'
    + 'Install it for this run: npm i -D --no-save sharp',
  );
  process.exit(1);
});

const sourcePath = fileURLToPath(new URL('../docs/brand/kheaw-chroma-source.png', import.meta.url));
const markPath = fileURLToPath(new URL('../public/brand/kheaw-mark.png', import.meta.url));
const iconsDirectory = fileURLToPath(new URL('../public/icons/', import.meta.url));

await mkdir(fileURLToPath(new URL('../public/brand/', import.meta.url)), { recursive: true });
await mkdir(iconsDirectory, { recursive: true });

const { data, info } = await sharp(sourcePath)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const corner = (x, y, channel) => data[((y * info.width + x) * 4) + channel];
const key = [0, 1, 2].map((channel) => Math.round((
  corner(0, 0, channel)
  + corner(info.width - 1, 0, channel)
  + corner(0, info.height - 1, channel)
  + corner(info.width - 1, info.height - 1, channel)
) / 4));

for (let offset = 0; offset < data.length; offset += 4) {
  // The generated "flat" key contains slight lighting variation. Magenta
  // dominance isolates it more reliably than one RGB distance while preserving
  // the pink cheeks (their blue channel is much lower than the key).
  const magentaDominance = Math.min(data[offset], data[offset + 2]) - data[offset + 1];
  const linear = 1 - Math.max(0, Math.min(1, (magentaDominance - 55) / 95));
  const alpha = linear * linear * (3 - (2 * linear));
  data[offset + 3] = Math.round(alpha * 255);

  if (alpha === 0) {
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    continue;
  }

  if (alpha < 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      data[offset + channel] = Math.max(0, Math.min(
        255,
        Math.round((data[offset + channel] - ((1 - alpha) * key[channel])) / alpha),
      ));
    }
    data[offset] = Math.min(data[offset], Math.round(data[offset + 1] * 1.05));
    data[offset + 2] = Math.min(data[offset + 2], Math.round(data[offset + 1] * 0.35));
  }
}

const mark = await sharp(data, {
  raw: {
    width: info.width,
    height: info.height,
    channels: 4,
  },
})
  .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 4 })
  .resize(960, 960, {
    fit: 'contain',
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png({ compressionLevel: 9, palette: false })
  .toBuffer();

await sharp(mark).toFile(markPath);

async function appIcon(size, fileName, mascotScale = 0.76) {
  const mascotSize = Math.round(size * mascotScale);
  const mascot = await sharp(mark)
    .resize(mascotSize, mascotSize, { fit: 'contain' })
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: '#000000',
    },
  })
    .composite([{
      input: mascot,
      left: Math.round((size - mascotSize) / 2),
      top: Math.round((size - mascotSize) / 2),
    }])
    .png({ compressionLevel: 9 })
    .toFile(join(iconsDirectory, fileName));
}

await Promise.all([
  appIcon(192, 'icon-192.png'),
  appIcon(512, 'icon-512.png'),
  appIcon(512, 'maskable-512.png', 0.64),
  // iOS reads `apple-touch-icon` at its own size and does not consult the web
  // app manifest for it. Handing it the 192 meant every Home Screen install
  // resampled a 192 square down to 180 — the one icon a standalone install is
  // judged by, rendered soft. This is that exact size, rendered not resampled.
  appIcon(180, 'apple-touch-icon-180.png'),
]);

console.log(`Built Kheaw assets from ${sourcePath}`);
