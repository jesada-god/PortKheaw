import sharp from 'sharp';
import { resolve } from 'node:path';

/*
 * Builds the nine Portfolio Goal mascot variants the app ships.
 *
 * Two things have to hold for every one of them, and neither can be papered
 * over in CSS:
 *
 *  - The file itself must be alpha-transparent. An earlier revision flattened
 *    onto the card colour and wrote JPEG, which drew a hard rectangle the
 *    moment the surface behind it was anything but that one colour (the
 *    Overview card, light theme, the gradient hero). JPEG has no alpha channel
 *    at all, so the output is PNG.
 *
 *  - Kheaw's *body* must read the same size in all nine. The event artwork
 *    draws a smaller Kheaw to make room for a crown, a rocket, confetti,
 *    lightning or a warning sign, so a naive "same canvas" export makes the
 *    celebration and disaster moods look shrunken next to the ordinary ones.
 *
 * The measurement is the widest scanline of the largest opaque component —
 * that is the base of the body, which is the widest part of the drawing in all
 * nine. Pixel area would be wrong here: a crown or a rocket welded to the
 * silhouette counts into the same component and inflates it. Detached
 * decorations (confetti, lightning, the warning triangle) form their own
 * components and are excluded from the measurement, but they are never cropped
 * away — the frame is sized so all of them survive.
 *
 * A prop drawn in front of the body defeats that measurement on its own, which
 * is what `measureBody` exists to catch. The empty-state variant holds a laptop
 * that overlaps the silhouette, so the opaque component is body-plus-laptop and
 * its widest scanline is 805px against a real body of 653px. Normalising on 805
 * would have shipped a Kheaw drawn at 81% of every other variant — a mascot that
 * looks shrunken precisely because he is carrying something.
 */

const assets = [
  ['kheaw-goal-strong-gain.png', '01_gain_strong.png'],
  ['kheaw-goal-gain.png', '02_gain_soft_wink.png'],
  ['kheaw-goal-neutral.png', '03_neutral.png'],
  ['kheaw-goal-small-loss.png', '04_loss_soft.png'],
  ['kheaw-goal-loss.png', '05_loss_big.png'],
  ['kheaw-goal-heavy-loss.png', '06_loss_heavy_cry.png'],
  ['kheaw-goal-event-gain-over-100.png', '07_event_gain_over_100.png'],
  ['kheaw-goal-event-loss-over-50.png', '08_event_loss_over_50.png'],
  ['kheaw-goal-event-gain-over-50.png', '09_event_gain_over_50.png'],
  ['kheaw-goal-empty.png', '10_empty_laptop.png'],
];

const root = resolve(process.cwd(), 'public', 'brand');

/** Square export edge. Four times the largest rendered size, which is 112px. */
const FRAME = 512;
/** Where the body's feet land inside the frame, leaving room for a shadow. */
const BASELINE = Math.round(FRAME * 0.918);
/** Body width every variant is normalised to, in output pixels. */
const BODY_WIDTH = Math.round(FRAME * 0.605);
const ALPHA_FLOOR = 24;
/*
 * Kheaw himself is always a saturated colour — he is drawn green when up, and
 * tinted yellow, pink and red as the moods darken — while the props are not:
 * the laptop is grey, its screen near-black. `CHROMA_FLOOR` is what tells the
 * two apart, and `PROP_TOLERANCE` is how much wider than the coloured body the
 * opaque silhouette may be before that difference is read as a prop lying over
 * it rather than as the body's own dark outline.
 */
const CHROMA_FLOOR = 40;
const VALUE_FLOOR = 60;
const PROP_TOLERANCE = 1.1;

function silhouette(data, width, height, channels) {
  const opaque = new Uint8Array(width * height);
  for (let index = 0; index < opaque.length; index += 1) {
    if (data[index * channels + 3] > ALPHA_FLOOR) opaque[index] = 1;
  }
  return opaque;
}

/** The silhouette with every achromatic pixel — outline, eyes, props — removed. */
function coloured(data, width, height, channels) {
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * channels;
    if (data[offset + 3] <= ALPHA_FLOOR) continue;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const peak = Math.max(red, green, blue);
    if (peak > VALUE_FLOOR && peak - Math.min(red, green, blue) > CHROMA_FLOOR) mask[index] = 1;
  }
  return mask;
}

function measure(opaque, width, height) {
  const seen = new Uint8Array(opaque.length);
  const content = { minX: width, minY: height, maxX: 0, maxY: 0 };
  let body = null;

  for (let start = 0; start < opaque.length; start += 1) {
    if (!opaque[start]) continue;
    const startX = start % width;
    const startY = Math.floor(start / width);
    content.minX = Math.min(content.minX, startX);
    content.maxX = Math.max(content.maxX, startX);
    content.minY = Math.min(content.minY, startY);
    content.maxY = Math.max(content.maxY, startY);
    if (seen[start]) continue;

    const queue = [start];
    seen[start] = 1;
    const rowMin = new Int32Array(height).fill(width);
    const rowMax = new Int32Array(height).fill(-1);
    let cursor = 0;
    let count = 0;
    let bottom = 0;
    while (cursor < queue.length) {
      const current = queue[cursor++];
      const x = current % width;
      const y = Math.floor(current / width);
      count += 1;
      if (y > bottom) bottom = y;
      if (x < rowMin[y]) rowMin[y] = x;
      if (x > rowMax[y]) rowMax[y] = x;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy += 1) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx += 1) {
          const next = yy * width + xx;
          if (opaque[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
        }
      }
    }
    if (body && count <= body.count) continue;

    let widest = 0;
    let widestRow = 0;
    for (let y = 0; y < height; y += 1) {
      if (rowMax[y] < 0) continue;
      const span = rowMax[y] - rowMin[y] + 1;
      if (span > widest) { widest = span; widestRow = y; }
    }
    body = {
      count,
      width: widest,
      bottom,
      centerX: (rowMin[widestRow] + rowMax[widestRow]) / 2,
    };
  }

  if (!body) throw new Error('Mascot silhouette was not detected');
  return { body, content };
}

/**
 * The body, measured from the silhouette unless a prop is lying over it.
 *
 * The silhouette is the right thing to measure almost always: it includes the
 * body's own dark outline, which is part of how big Kheaw looks. It stops being
 * the right thing when an achromatic prop is drawn across the body, because
 * then the opaque component is no longer only Kheaw. The two measurements are
 * taken and compared rather than chosen per file, so nothing has to be declared
 * by hand and the nine existing variants — whose readings differ by under 1% —
 * keep the silhouette measurement they were exported with.
 */
function measureBody(data, width, height, channels) {
  const opaque = measure(silhouette(data, width, height, channels), width, height);
  const chroma = measure(coloured(data, width, height, channels), width, height);
  const propOverlaps = opaque.body.width > chroma.body.width * PROP_TOLERANCE;
  return {
    body: propOverlaps ? chroma.body : opaque.body,
    // Bounds always come from the silhouette: the prop must not be measured as
    // the body, and must not be cropped away either.
    content: opaque.content,
    measuredBy: propOverlaps ? 'colour' : 'silhouette',
    silhouetteWidth: opaque.body.width,
    colouredWidth: chroma.body.width,
  };
}

async function inspect(name) {
  const { data, info } = await sharp(resolve(root, name)).ensureAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  const measured = measureBody(data, info.width, info.height, info.channels);
  /*
   * The largest body width this variant could take before its own decorations
   * would leave the frame. The export uses the smallest cap across all nine so
   * every mascot ends up the same size and nothing is ever clipped.
   */
  const halfWidth = Math.max(
    measured.body.centerX - measured.content.minX,
    measured.content.maxX - measured.body.centerX,
  );
  const above = measured.body.bottom - measured.content.minY;
  const below = measured.content.maxY - measured.body.bottom;
  const cap = Math.min(
    (FRAME / 2) * measured.body.width / halfWidth,
    BASELINE * measured.body.width / above,
    below > 0 ? (FRAME - BASELINE) * measured.body.width / below : Number.POSITIVE_INFINITY,
  );
  return { name, ...measured, cap, imageWidth: info.width, imageHeight: info.height };
}

const inspected = [];
for (const [source] of assets) inspected.push(await inspect(source));

const cap = Math.min(...inspected.map((item) => item.cap));
if (BODY_WIDTH > cap) {
  throw new Error(`BODY_WIDTH ${BODY_WIDTH} exceeds the safe cap ${cap.toFixed(1)} for these sources`);
}

if (process.argv.includes('--report')) {
  console.log(JSON.stringify({ frame: FRAME, baseline: BASELINE, bodyWidth: BODY_WIDTH, cap, assets: inspected }, null, 2));
  process.exit(0);
}

async function write(source, destination, current, scale) {
  const window = Math.round(FRAME / scale);
  const left = Math.round(current.body.centerX - (FRAME / 2) / scale);
  const top = Math.round(current.body.bottom - BASELINE / scale);
  // The window is allowed to sit outside the source; padding it with real
  // transparency is what keeps the frame square without stretching anything.
  const pad = Math.max(
    0,
    -left,
    -top,
    left + window - current.imageWidth,
    top + window - current.imageHeight,
  ) + 2;
  const padded = await sharp(resolve(root, source)).ensureAlpha()
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer();
  await sharp(padded)
    .extract({ left: left + pad, top: top + pad, width: window, height: window })
    .resize(FRAME, FRAME, { fit: 'fill' })
    .png({ compressionLevel: 9, effort: 10 })
    .toFile(resolve(root, destination));
}

/** The body of a written file, read back the same way its source was read. */
async function verify(destination) {
  const { data, info } = await sharp(resolve(root, destination)).ensureAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  return measureBody(data, info.width, info.height, info.channels).body.width;
}

/*
 * Scaling to a measured width does not land exactly on that width, because the
 * resample softens the edge the measurement is taken from and the crop window
 * is snapped to whole source pixels. For the nine that is a sub-pixel residual:
 * they are measured and rendered off the same silhouette and land within 1px of
 * the target on the first try. For a variant measured off colour it is not —
 * dropping the prop also drops the edge that antialiases into it, and the
 * empty-state Kheaw came out 315px wide against a target of 310.
 *
 * So the output is read back, and when the first attempt misses, a bounded
 * sweep of nearby scales is exported and the closest kept. It is a sweep rather
 * than a feedback loop because the measurement is not monotonic in the scale —
 * shifting the crop by one source pixel moves the sampling grid, and a
 * correcting loop oscillates between 304 and 315 forever without ever landing.
 */
const TOLERANCE = 0.005;
const SWEEP = 0.03;
const SWEEP_STEPS = 24;

async function bestScale(source, destination, current, analytic) {
  await write(source, destination, current, analytic);
  const first = await verify(destination);
  if (Math.abs(first - BODY_WIDTH) <= BODY_WIDTH * TOLERANCE) return { scale: analytic, bodyWidth: first };

  let best = { scale: analytic, bodyWidth: first };
  for (let step = 0; step <= SWEEP_STEPS; step += 1) {
    const scale = analytic * (1 - SWEEP + (2 * SWEEP * step) / SWEEP_STEPS);
    await write(source, destination, current, scale);
    const bodyWidth = await verify(destination);
    const better = Math.abs(bodyWidth - BODY_WIDTH) < Math.abs(best.bodyWidth - BODY_WIDTH);
    if (better) best = { scale, bodyWidth };
    if (Math.abs(bodyWidth - BODY_WIDTH) === 0) break;
  }
  // The sweep left the file at whichever scale it tried last.
  await write(source, destination, current, best.scale);
  return best;
}

const written = [];
for (let index = 0; index < assets.length; index += 1) {
  const [source, destination] = assets[index];
  const current = inspected[index];
  const { bodyWidth } = await bestScale(source, destination, current, BODY_WIDTH / current.body.width);
  written.push({ destination, measuredBy: current.measuredBy, bodyWidth });
}

const worst = Math.max(...written.map((item) => Math.abs(item.bodyWidth - BODY_WIDTH)));
if (worst > BODY_WIDTH * TOLERANCE) {
  throw new Error(`A variant's body is ${worst}px from ${BODY_WIDTH}px after correction`);
}

console.log(JSON.stringify({
  frame: FRAME,
  baseline: BASELINE,
  bodyWidth: BODY_WIDTH,
  cap: Number(cap.toFixed(1)),
  written,
}, null, 2));
