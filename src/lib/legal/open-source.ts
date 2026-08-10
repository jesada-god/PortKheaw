/**
 * Third-party attribution, as data.
 *
 * Deliberately *not* part of `legalDocuments`. That catalogue is consent-pinned:
 * each document carries a `version` a purchase acceptance records, and the server
 * refuses a consent pinned to any other. An attribution page has nothing to do
 * with what a buyer agreed to, and adding a sixth slug would drag it into that
 * machinery — and into the billing tests — for no reason. It is a plain page.
 *
 * What it exists for: Lightweight Charts is Apache-2.0, and its README adds one
 * condition on top of the licence — the attribution notice from the upstream
 * NOTICE file, plus a link to tradingview.com, has to appear on a page of the
 * site available to users. The library's own way of collecting that debt is
 * `layout.attributionLogo`, a mark drawn inside the plot, and upstream states
 * that a product meeting the requirement elsewhere may switch it off. This page
 * plus the one-line credit under each chart is that elsewhere, which is what
 * lets both chart hosts pass `attributionLogo: false`.
 */

export interface OpenSourceNotice {
  name: string;
  /** The version actually installed. Pinned, and asserted against the package. */
  version: string;
  license: string;
  licenseUrl: string;
  homepage: string;
  /**
   * The upstream NOTICE file, verbatim.
   *
   * Note the copyright glyph: upstream spells it with U+0441 (Cyrillic es), not
   * the Latin "c". It looks like a typo and is not ours to correct — reproducing
   * the notice means reproducing it.
   */
  notice: readonly string[];
  /** Why it is here, in the reader's language. */
  usedFor: string;
}

export const TRADINGVIEW_HOMEPAGE = 'https://www.tradingview.com/';

export const LIGHTWEIGHT_CHARTS_NOTICE: OpenSourceNotice = {
  name: 'TradingView Lightweight Charts™',
  version: '5.2.0',
  license: 'Apache License 2.0',
  licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0',
  homepage: TRADINGVIEW_HOMEPAGE,
  notice: [
    'TradingView Lightweight Charts™',
    'Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/',
  ],
  usedFor: 'ใช้วาดกราฟราคา ปริมาณการซื้อขาย อินดิเคเตอร์ และเส้นระดับต่าง ๆ ในหน้าวิเคราะห์หุ้น',
};

export const openSourceNotices: readonly OpenSourceNotice[] = [LIGHTWEIGHT_CHARTS_NOTICE];

export const OPEN_SOURCE_PAGE = {
  href: '/open-source',
  title: 'ซอฟต์แวร์โอเพนซอร์สที่เราใช้',
  subtitle: 'รายการไลบรารีของบุคคลที่สาม สัญญาอนุญาต และประกาศแสดงที่มา',
  intro:
    'PortKheaw ใช้ซอฟต์แวร์โอเพนซอร์สของบุคคลที่สามบางส่วนในการทำงาน '
    + 'หน้านี้แสดงรายชื่อไลบรารี เวอร์ชันที่ใช้จริง สัญญาอนุญาต และประกาศแสดงที่มาตามที่เจ้าของลิขสิทธิ์กำหนด',
} as const;
