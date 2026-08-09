/**
 * Client-side ordering for lists the page already has in memory.
 *
 * Sorting is a reading preference, not a query: the holdings are already
 * calculated and already on the screen, so re-ordering them costs one pass and
 * no round trip. Nothing here changes a value — it only decides which row is
 * read first.
 *
 * A missing figure always sorts last, whichever direction is chosen. An asset
 * with no verified price is not "the smallest"; it is unknown, and putting it
 * at the bottom is what stops it from looking like a loss.
 */
export type HoldingSortKey = 'value' | 'today' | 'gain' | 'name';

export const HOLDING_SORT_LABELS: Record<HoldingSortKey, string> = {
  value: 'มูลค่าสินทรัพย์',
  today: 'กำไร/ขาดทุนวันนี้',
  gain: 'กำไร/ขาดทุนรวม',
  name: 'ชื่อ A–Z',
};

export interface SortableAsset {
  name: string;
  value: number | null;
  todayChange: number | null;
  unrealizedGain: number | null;
}

function figure(asset: SortableAsset, key: HoldingSortKey): number | null {
  if (key === 'value') return asset.value;
  if (key === 'today') return asset.todayChange;
  if (key === 'gain') return asset.unrealizedGain;
  return null;
}

export function sortAssets<T>(
  items: readonly T[],
  key: HoldingSortKey,
  read: (item: T) => SortableAsset,
): T[] {
  return [...items].sort((left, right) => {
    const leftAsset = read(left);
    const rightAsset = read(right);
    if (key === 'name') return leftAsset.name.localeCompare(rightAsset.name);
    const leftValue = figure(leftAsset, key);
    const rightValue = figure(rightAsset, key);
    if (leftValue === null && rightValue === null) return leftAsset.name.localeCompare(rightAsset.name);
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    if (leftValue === rightValue) return leftAsset.name.localeCompare(rightAsset.name);
    return rightValue - leftValue;
  });
}
