/**
 * Where an instrument lives.
 *
 * One spelling of the Stock Detail URL, so a card that opens a symbol and a row
 * that opens the same symbol cannot drift — and so an asset whose ticker needs
 * escaping (`BTC-USD`, `BRK.B`) is escaped everywhere or nowhere.
 */
export function stockDetailHref(symbol: string): string {
  return `/stock/${encodeURIComponent(symbol.trim().toUpperCase())}`;
}
