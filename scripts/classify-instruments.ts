import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import { createClient } from '@supabase/supabase-js';
import {
  INSTRUMENT_CLASSIFICATION_SCHEMA_VERSION,
  SIC_TAXONOMY_VERSION,
  classifySic,
  isExcludedSecurityName,
  stableIndustrySlug,
  type InstrumentClassification,
  type InstrumentClassificationDataset,
} from '../src/lib/instruments/classification.ts';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const SUBMISSIONS_URL = 'https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip';
const OUTPUT_PATH = join(process.cwd(), 'src', 'generated', 'instrument-classification.json');
const MAX_ARCHIVE_BYTES = 2_000_000_000;
const REQUEST_TIMEOUT_MS = 45_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_ATTEMPTS = 3;

interface InstrumentRow {
  symbol: string;
  name: string;
  exchange: string | null;
  asset_type: string;
  currency: string;
  status: string;
}

interface TickerRow {
  cik: number;
  name: string;
  ticker: string;
  exchange: string | null;
  order: number;
}

interface Submission {
  cik: string;
  entityType?: string;
  sic?: string;
  sicDescription?: string;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  website?: string;
}

interface ZipEntry {
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function userAgent(): string {
  const value = process.env.SEC_EDGAR_USER_AGENT ?? process.env.SEC_USER_AGENT;
  if (!value?.trim()) {
    throw new Error('SEC_EDGAR_USER_AGENT or SEC_USER_AGENT is required');
  }
  return value.trim();
}

async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        headers: {
          'User-Agent': userAgent(),
          Accept: 'application/json, application/zip',
          'Accept-Encoding': 'gzip, deflate',
          ...init.headers,
        },
        signal: controller.signal,
      });
      if (response.ok) return response;
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`SEC request failed with HTTP ${response.status}`);
      }
      lastError = new Error(`SEC request failed with HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('SEC request failed');
}

function validateTickerPayload(value: unknown): {
  fields: string[];
  data: unknown[][];
} {
  if (!value || typeof value !== 'object') throw new Error('SEC ticker payload is not an object');
  const payload = value as { fields?: unknown; data?: unknown };
  if (!Array.isArray(payload.fields) || !Array.isArray(payload.data)) {
    throw new Error('SEC ticker payload is missing fields or data');
  }
  const fields = payload.fields.map(String);
  if (fields.join(',') !== 'cik,name,ticker,exchange') {
    throw new Error(`Unexpected SEC ticker schema: ${fields.join(',')}`);
  }
  if (payload.data.length < 1_000 || payload.data.some((row) => !Array.isArray(row) || row.length !== fields.length)) {
    throw new Error('SEC ticker payload failed coverage or row-shape validation');
  }
  return { fields, data: payload.data as unknown[][] };
}

async function loadTickerRows(): Promise<{
  rows: TickerRow[];
  lastModified: string | null;
}> {
  const response = await fetchWithRetry(TICKERS_URL);
  const payload = validateTickerPayload(await response.json());
  return {
    rows: payload.data.map((row, order) => ({
      cik: Number(row[0]),
      name: String(row[1]),
      ticker: String(row[2]).toUpperCase(),
      exchange: row[3] === null ? null : String(row[3]),
      order,
    })),
    lastModified: response.headers.get('last-modified'),
  };
}

async function loadInstrumentRows(): Promise<InstrumentRow[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('Supabase URL and a read-capable key are required');
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rows: InstrumentRow[] = [];
  for (let from = 0; ; from += 1_000) {
    const { data, error } = await client
      .from('market_instruments')
      .select('symbol,name,exchange,asset_type,currency,status')
      .eq('status', 'active')
      .order('symbol')
      .range(from, from + 999);
    if (error) throw new Error(`Instrument Master read failed: ${error.code}`);
    rows.push(...(data as InstrumentRow[]));
    if (data.length < 1_000) break;
  }
  if (rows.length < 1_000) throw new Error('Instrument Master coverage is unexpectedly small');
  return rows;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function ensureArchive(): Promise<{
  path: string;
  lastModified: string | null;
  checksum: string;
}> {
  const head = await fetchWithRetry(SUBMISSIONS_URL, { method: 'HEAD' });
  const length = Number(head.headers.get('content-length'));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_ARCHIVE_BYTES) {
    throw new Error(`SEC submissions archive size is outside the safe limit: ${length}`);
  }
  const lastModified = head.headers.get('last-modified');
  const identity = createHash('sha256')
    .update(`${length}:${lastModified ?? ''}`)
    .digest('hex')
    .slice(0, 16);
  const cacheDirectory = join(process.cwd(), 'node_modules', '.cache', 'portkheaw');
  mkdirSync(cacheDirectory, { recursive: true });
  const archivePath = join(cacheDirectory, `sec-submissions-${identity}.zip`);
  if (existsSync(archivePath) && statSync(archivePath).size === length) {
    return { path: archivePath, lastModified, checksum: await sha256(archivePath) };
  }

  const temporaryPath = `${archivePath}.${process.pid}.tmp`;
  rmSync(temporaryPath, { force: true });
  const response = await fetchWithRetry(SUBMISSIONS_URL, {}, DOWNLOAD_TIMEOUT_MS);
  if (!response.body) throw new Error('SEC submissions response has no body');
  const hash = createHash('sha256');
  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_ARCHIVE_BYTES) {
        callback(new Error('SEC submissions archive exceeded the safe size limit'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      counter,
      createWriteStream(temporaryPath, { flags: 'wx' }),
    );
    if (received !== length) {
      throw new Error(`SEC submissions archive was truncated: ${received}/${length}`);
    }
    renameSync(temporaryPath, archivePath);
    return { path: archivePath, lastModified, checksum: hash.digest('hex') };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function readExactly(fd: number, length: number, position: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, position + offset);
    if (!count) throw new Error('Unexpected end of SEC submissions archive');
    offset += count;
  }
  return buffer;
}

function safeZipNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`SEC submissions ZIP ${label} exceeds the safe integer limit`);
  }
  return Number(value);
}

function zipIndex(path: string, neededNames: Set<string>): Map<string, ZipEntry> {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const tailLength = Math.min(size, 65_557);
    const tail = readExactly(fd, tailLength, size - tailLength);
    let end = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === 0x06054b50) {
        end = index;
        break;
      }
    }
    if (end < 0) throw new Error('SEC submissions ZIP end record was not found');
    let entryCount = tail.readUInt16LE(end + 10);
    let centralSize = tail.readUInt32LE(end + 12);
    let centralOffset = tail.readUInt32LE(end + 16);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      const locatorOffset = end - 20;
      if (locatorOffset < 0 || tail.readUInt32LE(locatorOffset) !== 0x07064b50) {
        throw new Error('SEC submissions ZIP64 locator was not found');
      }
      const zip64Offset = safeZipNumber(
        tail.readBigUInt64LE(locatorOffset + 8),
        'end-record offset',
      );
      const zip64 = readExactly(fd, 56, zip64Offset);
      if (zip64.readUInt32LE(0) !== 0x06064b50) {
        throw new Error('SEC submissions ZIP64 end record is invalid');
      }
      entryCount = safeZipNumber(zip64.readBigUInt64LE(32), 'entry count');
      centralSize = safeZipNumber(zip64.readBigUInt64LE(40), 'central-directory size');
      centralOffset = safeZipNumber(zip64.readBigUInt64LE(48), 'central-directory offset');
    }
    const central = readExactly(fd, centralSize, centralOffset);
    const selected = new Map<string, ZipEntry>();
    let cursor = 0;
    let parsed = 0;
    while (cursor < central.length && parsed < entryCount) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) {
        throw new Error('SEC submissions ZIP central directory is invalid');
      }
      const compression = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localHeaderOffset = central.readUInt32LE(cursor + 42);
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
      if (neededNames.has(name)) {
        selected.set(name, { compression, compressedSize, uncompressedSize, localHeaderOffset });
      }
      cursor += 46 + nameLength + extraLength + commentLength;
      parsed += 1;
    }
    return selected;
  } finally {
    closeSync(fd);
  }
}

function readZipJson(path: string, entry: ZipEntry): Submission {
  const fd = openSync(path, 'r');
  try {
    const header = readExactly(fd, 30, entry.localHeaderOffset);
    if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('Invalid ZIP local header');
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
    const compressed = readExactly(fd, entry.compressedSize, start);
    const content = entry.compression === 0
      ? compressed
      : entry.compression === 8
        ? inflateRawSync(compressed)
        : null;
    if (!content || content.length !== entry.uncompressedSize) {
      throw new Error(`Unsupported or invalid ZIP entry compression ${entry.compression}`);
    }
    return JSON.parse(content.toString('utf8')) as Submission;
  } finally {
    closeSync(fd);
  }
}

function normalizedTicker(symbol: string): string {
  return symbol.toUpperCase().replace(/\./g, '-');
}

function cikFile(cik: number): string {
  return `CIK${String(cik).padStart(10, '0')}.json`;
}

function websiteDomain(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
      .hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isoSourceDate(value: string | null): string {
  const parsed = value ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('SEC submissions archive is missing a valid Last-Modified timestamp');
  }
  return parsed.toISOString();
}

function atomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  const fd = openSync(temporary, 'w');
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const [instrumentRows, tickerSource, archive] = await Promise.all([
    loadInstrumentRows(),
    loadTickerRows(),
    ensureArchive(),
  ]);
  const tickerBySymbol = new Map<string, TickerRow>();
  for (const row of tickerSource.rows) {
    if (!tickerBySymbol.has(row.ticker)) tickerBySymbol.set(row.ticker, row);
  }
  const matchedCiks = new Set(
    instrumentRows
      .filter((row) => row.asset_type === 'Stock')
      .map((row) => tickerBySymbol.get(normalizedTicker(row.symbol))?.cik)
      .filter((cik): cik is number => Number.isInteger(cik)),
  );
  const neededFiles = new Set([...matchedCiks].map(cikFile));
  const entries = zipIndex(archive.path, neededFiles);
  if (entries.size / neededFiles.size < 0.98) {
    throw new Error(`SEC submissions archive coverage is too small: ${entries.size}/${neededFiles.size}`);
  }
  const submissions = new Map<number, Submission>();
  for (const cik of [...matchedCiks].sort((a, b) => a - b)) {
    const entry = entries.get(cikFile(cik));
    if (!entry) continue;
    const submission = readZipJson(archive.path, entry);
    if (!submission.cik || !Array.isArray(submission.tickers)) continue;
    submissions.set(cik, submission);
  }

  const sourceUpdatedAt = isoSourceDate(archive.lastModified);
  const primarySymbolByCik = new Map<number, string>();
  for (const row of instrumentRows) {
    if (row.asset_type !== 'Stock' || isExcludedSecurityName(row.name)) continue;
    const ticker = tickerBySymbol.get(normalizedTicker(row.symbol));
    if (!ticker) continue;
    const submission = submissions.get(ticker.cik);
    if (submission?.entityType !== 'operating' || !classifySic(submission.sic)) continue;
    const existing = primarySymbolByCik.get(ticker.cik);
    if (!existing || ticker.order < (tickerBySymbol.get(normalizedTicker(existing))?.order ?? Infinity)) {
      primarySymbolByCik.set(ticker.cik, row.symbol);
    }
  }

  const instruments: InstrumentClassification[] = instrumentRows.map((row) => {
    const ticker = tickerBySymbol.get(normalizedTicker(row.symbol));
    const submission = ticker ? submissions.get(ticker.cik) : undefined;
    const taxonomy = classifySic(submission?.sic);
    const isStock = row.asset_type === 'Stock';
    const excludedName = isExcludedSecurityName(row.name);
    const operating = submission?.entityType === 'operating';
    const primary = ticker ? primarySymbolByCik.get(ticker.cik) === row.symbol : false;
    const verdict: InstrumentClassification['verdict'] = !isStock || excludedName
      ? 'excluded-asset'
      : submission && !operating
        ? 'excluded-entity'
        : taxonomy && ticker && !primary
          ? 'duplicate-company'
          : taxonomy && ticker && operating
            ? 'verified'
            : 'unknown';
    const classified: InstrumentClassification = {
      symbol: row.symbol,
      companyIdentity: ticker ? `sec-cik:${String(ticker.cik).padStart(10, '0')}` : null,
      companyName: row.name,
      exchange: row.exchange,
      assetType: row.asset_type,
      currency: row.currency,
      cik: ticker ? String(ticker.cik).padStart(10, '0') : null,
      sicCode: submission?.sic && /^\d{4}$/.test(submission.sic) ? submission.sic : null,
      sicDescription: submission?.sicDescription?.trim() || null,
      sectorKey: taxonomy?.sectorKey ?? null,
      sectorNameEn: taxonomy?.sectorNameEn ?? null,
      sectorNameTh: taxonomy?.sectorNameTh ?? null,
      industryKey: taxonomy?.industryKey ?? null,
      industryNameEn: taxonomy?.industryNameEn ?? null,
      industryNameTh: taxonomy?.industryNameTh ?? null,
      stableSlug: taxonomy ? stableIndustrySlug(taxonomy.industryKey) : null,
      websiteDomain: websiteDomain(submission?.website),
      logoUrl: null,
      metadataSource: ticker ? 'sec-edgar-submissions+instrument-master' : 'instrument-master',
      taxonomyVersion: SIC_TAXONOMY_VERSION,
      updatedAt: sourceUpdatedAt,
      verdict,
      confidence: verdict === 'verified' || verdict === 'duplicate-company' ? 'high' : 'none',
      rankingEligible: verdict === 'verified',
    };
    return classified;
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));

  const stocks = instruments.filter((row) => row.assetType === 'Stock');
  const dataset: InstrumentClassificationDataset = {
    schemaVersion: INSTRUMENT_CLASSIFICATION_SCHEMA_VERSION,
    taxonomyVersion: SIC_TAXONOMY_VERSION,
    generatedAt: sourceUpdatedAt,
    source: {
      tickerExchangeUrl: TICKERS_URL,
      submissionsArchiveUrl: SUBMISSIONS_URL,
      tickerExchangeLastModified: tickerSource.lastModified,
      submissionsLastModified: archive.lastModified,
      submissionsSha256: archive.checksum,
    },
    coverage: {
      instrumentCount: instruments.length,
      stockCount: stocks.length,
      etfCount: instruments.filter((row) => row.assetType === 'ETF').length,
      secTickerMatches: stocks.filter((row) => row.cik).length,
      verifiedClassifications: stocks.filter((row) => row.verdict === 'verified').length,
      unknownStocks: stocks.filter((row) => row.verdict === 'unknown').length,
      excludedStocks: stocks.filter((row) => row.verdict.startsWith('excluded-')).length,
      duplicateCompanySymbols: stocks.filter((row) => row.verdict === 'duplicate-company').length,
    },
    instruments,
  };

  const serialized = `${JSON.stringify(dataset)}\n`;
  if (checkOnly) {
    if (!existsSync(OUTPUT_PATH)) throw new Error('Generated classification dataset is missing');
    if (readFileSync(OUTPUT_PATH, 'utf8') !== serialized) {
      throw new Error('Generated classification dataset is not deterministic or is out of date');
    }
  } else {
    atomicJson(OUTPUT_PATH, dataset);
  }
  process.stdout.write(`${JSON.stringify({
    event: 'instrument_classification_complete',
    checkOnly,
    output: OUTPUT_PATH,
    bytes: Buffer.byteLength(serialized),
    archiveBytes: statSync(archive.path).size,
    archiveSha256: archive.checksum,
    ...dataset.coverage,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    event: 'instrument_classification_error',
    message: error instanceof Error ? error.message : 'Unknown classification error',
  })}\n`);
  process.exitCode = 1;
});
