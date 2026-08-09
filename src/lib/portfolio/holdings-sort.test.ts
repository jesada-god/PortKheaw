import { describe, expect, it } from 'vitest';
import { sortAssets, type SortableAsset } from './holdings-sort';

const asset = (overrides: Partial<SortableAsset> = {}): SortableAsset => ({
  name: 'AAPL', value: 100, todayChange: 1, unrealizedGain: 10, ...overrides,
});

const read = (item: SortableAsset) => item;

describe('sortAssets', () => {
  it('orders by the chosen figure, largest first', () => {
    const items = [asset({ name: 'A', value: 10 }), asset({ name: 'B', value: 90 }), asset({ name: 'C', value: 50 })];
    expect(sortAssets(items, 'value', read).map((item) => item.name)).toEqual(['B', 'C', 'A']);
    const byToday = [asset({ name: 'A', todayChange: -5 }), asset({ name: 'B', todayChange: 5 })];
    expect(sortAssets(byToday, 'today', read).map((item) => item.name)).toEqual(['B', 'A']);
  });

  /*
   * An asset with no verified price is unknown, not smallest. Sorting it to the
   * bottom is what stops it from reading as the day's biggest loss.
   */
  it('puts an unknown figure last rather than treating it as the lowest', () => {
    const items = [asset({ name: 'A', value: null }), asset({ name: 'B', value: -50 }), asset({ name: 'C', value: 10 })];
    expect(sortAssets(items, 'value', read).map((item) => item.name)).toEqual(['C', 'B', 'A']);
  });

  it('breaks ties by name and sorts by name on request', () => {
    const items = [asset({ name: 'TSLA', value: 10 }), asset({ name: 'AAPL', value: 10 })];
    expect(sortAssets(items, 'value', read).map((item) => item.name)).toEqual(['AAPL', 'TSLA']);
    expect(sortAssets(items, 'name', read).map((item) => item.name)).toEqual(['AAPL', 'TSLA']);
  });

  it('never mutates the list it was given', () => {
    const items = [asset({ name: 'A', value: 1 }), asset({ name: 'B', value: 2 })];
    sortAssets(items, 'value', read);
    expect(items.map((item) => item.name)).toEqual(['A', 'B']);
  });
});
