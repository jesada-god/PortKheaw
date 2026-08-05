import sharp from 'sharp';
import { resolve } from 'node:path';

const assets = [
  ['kheaw-goal-strong-gain.png', '01_gain_strong.jpg'],
  ['kheaw-goal-gain.png', '02_gain_soft_wink.jpg'],
  ['kheaw-goal-neutral.png', '03_neutral.jpg'],
  ['kheaw-goal-small-loss.png', '04_loss_soft.jpg'],
  ['kheaw-goal-loss.png', '05_loss_big.jpg'],
  ['kheaw-goal-heavy-loss.png', '06_loss_heavy_cry.jpg'],
  ['kheaw-goal-event-gain-over-100.png', '07_event_gain_over_100.jpg'],
  ['kheaw-goal-event-loss-over-50.png', '08_event_loss_over_50.jpg'],
  ['kheaw-goal-event-gain-over-50.png', '09_event_gain_over_50.jpg'],
];

const root = resolve(process.cwd(), 'public', 'brand');

function visibleMask(data, width, height, channels) {
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * channels;
    if (data[offset + 3] > 24) mask[index] = 1;
  }
  return mask;
}

function mascotBounds(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  let best = null;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    const queue = [start];
    seen[start] = 1;
    let cursor = 0;
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (cursor < queue.length) {
      const current = queue[cursor++];
      const x = current % width;
      const y = Math.floor(current / width);
      count += 1;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
          const next = yy * width + xx;
          if (mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
        }
      }
    }
    const candidate = { count, minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
    const central = (minX + maxX) / 2 > width * 0.18 && (minX + maxX) / 2 < width * 1.82;
    if (central && (!best || candidate.count > best.count)) best = candidate;
  }
  if (!best) throw new Error('Mascot silhouette was not detected');
  return best;
}

async function inspect(name) {
  const image = sharp(resolve(root, name));
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { name, bounds: mascotBounds(visibleMask(data, info.width, info.height, info.channels), info.width, info.height), imageWidth: info.width, imageHeight: info.height };
}

const inspected = [];
for (const [source] of assets) inspected.push(await inspect(source));
const normalHeights = inspected.slice(0, 6).map((item) => item.bounds.height).sort((a, b) => a - b);
const targetHeight = Math.round((normalHeights[2] + normalHeights[3]) / 2);
const normalAreas = inspected.slice(0, 6).map((item) => item.bounds.count).sort((a, b) => a - b);
const targetArea = Math.round((normalAreas[2] + normalAreas[3]) / 2);

if (process.argv.includes('--report')) {
  console.log(JSON.stringify({ targetHeight, targetArea, assets: inspected }, null, 2));
  process.exit(0);
}

for (let index = 0; index < assets.length; index += 1) {
  const [source, destination] = assets[index];
  const current = inspected[index];
  // Pixel area follows the mascot's body mass more reliably than the outer
  // bounding box, which may include a tall arrow, crown, tears, or confetti.
  const scale = Math.sqrt(targetArea / current.bounds.count);
  const cropWidth = Math.min(current.imageWidth, Math.max(1, Math.round(current.imageWidth / scale)));
  const cropHeight = Math.min(current.imageHeight, Math.max(1, Math.round(current.imageHeight / scale)));
  const centerX = (current.bounds.minX + current.bounds.maxX) / 2;
  const centerY = (current.bounds.minY + current.bounds.maxY) / 2;
  const left = Math.max(0, Math.min(current.imageWidth - cropWidth, Math.round(centerX - cropWidth / 2)));
  const top = Math.max(0, Math.min(current.imageHeight - cropHeight, Math.round(centerY - cropHeight / 2)));
  await sharp(resolve(root, source))
    .extract({ left, top, width: cropWidth, height: cropHeight })
    .resize(1024, 1024, { fit: 'fill' })
    .flatten({ background: '#151B28' })
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toFile(resolve(root, destination));
}

console.log(JSON.stringify({ targetHeight, targetArea, written: assets.map(([, destination]) => destination) }, null, 2));
