/**
 * How far price has to travel to reach a level, written one way everywhere.
 *
 * There were two formatters and they disagreed about the same number. The modal
 * printed the pair as `ระยะขึ้น / ระยะลง: +10.83% / +6.23%` from one, while the
 * sentence three lines above it printed `ลงถึงแนวรับ -6.23%` from the other —
 * and a third call site inside the engine printed the very same downside as
 * `+6.23%` again. The distance to the support below is not negative, and it is
 * not positive either: it is a DISTANCE, and the direction is a separate fact
 * about it.
 *
 * So the sign is gone. The label carries the direction (`ขึ้น` / `ลง`) and the
 * number carries the magnitude, which also removes the older ambiguity of a
 * reader having to decide whether `+6.23%` meant "up 6.23%" or "6.23% of room
 * on the downside".
 *
 * Signed percentages elsewhere in the product — a price CHANGE, where the sign
 * is the whole point — are a different quantity and are not formatted here.
 */

/** `10.83%`. Never signed: a distance has a direction, not a sign. */
export function distancePercentText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.abs(value).toFixed(2)}%`;
}

/** `1.06 ATR`, on the same no-sign rule. */
export function distanceAtrText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.abs(value).toFixed(2)} ATR`;
}

/** `0.83×`, for a distance quoted in expected moves. */
export function distanceExpectedMovesText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${Math.abs(value).toFixed(2)}×`;
}

/**
 * `ขึ้นถึงแนวต้าน 10.83%` / `ลงถึงแนวรับ 6.23%`.
 *
 * The one place the direction and the magnitude are joined, so a caller cannot
 * pair "ลง" with a value it negated on the way in.
 */
export function directedDistanceText(
  direction: 'up' | 'down',
  target: string,
  percent: number | null | undefined,
): string {
  const heading = direction === 'up' ? 'ขึ้นถึง' : 'ลงถึง';
  return `${heading}${target} ${distancePercentText(percent)}`;
}
