/**
 * Extracts the loading-pose Kheaw from the supplied artwork.
 *
 * Same deal as `build-kheaw-assets.mjs`: a one-off asset generator, not part of
 * `npm run build`. Its output (public/brand/kheaw-loading.webp) is committed, so
 * nobody needs to run it to build or deploy. `sharp` is deliberately NOT a
 * project dependency — install it on demand when the artwork changes:
 *
 *   npm i -D --no-save sharp && node scripts/build-kheaw-loading-asset.mjs
 *
 * The source frame is a full illustration: speech bubble on top, mascot below,
 * motion ticks either side, and a baked contact shadow under the body. The
 * loader rebuilds the bubble and the shadow in HTML/CSS — text has to be real
 * text to stay sharp and readable, and the shadow has to animate against the
 * bounce — so all three are stripped here and only the mascot survives. The
 * mascot's own pixels are never redrawn, recoloured or resampled beyond a
 * single Lanczos downscale.
 *
 * Everything below keys off the source's existing alpha channel, which already
 * separates artwork from background; nothing is chroma-keyed or guessed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const sharp = await import('sharp').then((module) => module.default).catch(() => {
  console.error(
    'This script needs sharp, which is not a project dependency by design.\n'
    + 'Install it for this run: npm i -D --no-save sharp',
  );
  process.exit(1);
});

const sourcePath = fileURLToPath(new URL('../docs/brand/kheaw-loading-source.png', import.meta.url));
const outputPath = fileURLToPath(new URL('../public/brand/kheaw-loading.webp', import.meta.url));

/*
 * The bubble occupies rows 99–315 of the source and the mascot rows 326–730,
 * with a fully transparent band between them — so the split is a plain crop,
 * not a mask. Columns are taken wide and trimmed to the real bounding box at
 * the end.
 */
const MASCOT_FRAME = { left: 522, top: 326, width: 481, height: 405 };
/** Widest the mascot is ever rendered (180px) at 2x device pixel ratio. */
const OUTPUT_WIDTH = 360;

const { data, info } = await sharp(sourcePath)
  .extract(MASCOT_FRAME)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const { width, height, channels } = info;
const pixels = Buffer.from(data);
const alphaAt = (index) => pixels[(index * channels) + 3];
const rgbAt = (index) => [
  pixels[index * channels],
  pixels[(index * channels) + 1],
  pixels[(index * channels) + 2],
];
const saturation = ([r, g, b]) => {
  const high = Math.max(r, g, b);
  return high === 0 ? 0 : (high - Math.min(r, g, b)) / high;
};
const NEIGHBOURS_8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/*
 * 1. Keep only the largest connected run of artwork. The mascot — body, sprout
 *    and face — is one blob; the four motion ticks beside it are their own
 *    small islands. The threshold is deliberately near zero so a tick's faint
 *    anti-aliased tail leaves with the tick rather than surviving as a speck at
 *    the edge of the trimmed frame.
 */
const label = new Int32Array(width * height).fill(-1);
const sizes = [];
for (let seed = 0; seed < width * height; seed += 1) {
  if (alphaAt(seed) <= 2 || label[seed] !== -1) continue;
  const id = sizes.length;
  const stack = [seed];
  label[seed] = id;
  let size = 0;
  while (stack.length) {
    const current = stack.pop();
    size += 1;
    const x = current % width;
    const y = (current - x) / width;
    for (const [dx, dy] of NEIGHBOURS_8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const neighbour = (ny * width) + nx;
      if (label[neighbour] === -1 && alphaAt(neighbour) > 2) {
        label[neighbour] = id;
        stack.push(neighbour);
      }
    }
  }
  sizes.push(size);
}
const mascotId = sizes.reduce((best, size, id) => (size > sizes[best] ? id : best), 0);
for (let index = 0; index < width * height; index += 1) {
  if (label[index] !== -1 && label[index] !== mascotId) pixels[(index * channels) + 3] = 0;
}

/*
 * 2. Erase the baked contact shadow, which is drawn as part of the same blob.
 *    It is the only artwork that is both washed out and light — the body is
 *    saturated lime and its outline is near-black green — so a flood inward
 *    from the bottom edge across pale, desaturated pixels fills the ellipse and
 *    stops dead at the outline.
 */
const isShadow = (index) => {
  const rgb = rgbAt(index);
  return saturation(rgb) < 0.34 && Math.max(...rgb) > 118;
};
const queued = new Uint8Array(width * height);
const frontier = [];
for (let x = 0; x < width; x += 1) {
  const index = ((height - 1) * width) + x;
  if (alphaAt(index) > 0 && isShadow(index)) {
    queued[index] = 1;
    frontier.push(index);
  }
}
while (frontier.length) {
  const current = frontier.pop();
  pixels[(current * channels) + 3] = 0;
  const x = current % width;
  const y = (current - x) / width;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const neighbour = (ny * width) + nx;
    if (!queued[neighbour] && alphaAt(neighbour) > 0 && isShadow(neighbour)) {
      queued[neighbour] = 1;
      frontier.push(neighbour);
    }
  }
}

// 3. Trim to what is left, so the rendered box is mascot and nothing else.
let left = width;
let right = -1;
let top = height;
let bottom = -1;
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    if (alphaAt((y * width) + x) <= 8) continue;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
}

const quantised = await sharp(pixels, { raw: { width, height, channels } })
  .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
  .resize({ width: OUTPUT_WIDTH, kernel: 'lanczos3' })
  // Quantised rather than truecolour: the artwork is flat cel shading with a
  // handful of gradients, so 256 colours is visually identical at a quarter of
  // the bytes — and this file is on the critical path of every slow page.
  .png({ palette: true, quality: 90, effort: 10 })
  .toBuffer();

/*
 * Shipped as lossless WebP, encoded from the quantised PNG above rather than
 * from the raw pixels: the 256-colour reduction is what WebP's lossless mode
 * compresses so well, so the two steps compound. 45,484 bytes to 38,034.
 *
 * Lossless, not q80 — and not AVIF. This is the LCP element of every slow route
 * in the product, and both lossy paths were measured against the PNG before
 * being rejected: WebP q80 shifted colour channels by up to 72/255 across flat
 * cel-shaded fills, and AVIF q80 moved the alpha channel by up to 18, which
 * frays the cut-out edge the loader depends on. Lossless is pixel-identical
 * (max RGB delta 0, max alpha delta 0) and still 16% smaller, and WebP decodes
 * faster than AVIF on the low-end phones this asset exists for.
 */
const output = await sharp(quantised).webp({ lossless: true, effort: 6 }).toBuffer();

await mkdir(fileURLToPath(new URL('../public/brand/', import.meta.url)), { recursive: true });
await writeFile(outputPath, output);

const meta = await sharp(output).metadata();
console.log(
  `Built ${outputPath} — ${meta.width}x${meta.height}, ${output.length} bytes `
  + `(trimmed from ${right - left + 1}x${bottom - top + 1} of ${sourcePath})`,
);
