import { describe, expect, it } from 'vitest';
import {
  ExpiringFailureMemory,
  chooseInstrumentLogoUrl,
  normalizeLogoUrl,
  shouldPersistInstrumentLogo,
  tidyInstrumentName,
} from './logo-policy';

describe('normalizeLogoUrl', () => {
  it('accepts only credential-free HTTPS and same-origin assets', () => {
    expect(normalizeLogoUrl(' https://images.example.test/nvda.png#x '))
      .toBe('https://images.example.test/nvda.png');
    expect(normalizeLogoUrl('/market-logos/spy.svg')).toBe('/market-logos/spy.svg');
    expect(normalizeLogoUrl('http://images.example.test/nvda.png')).toBeNull();
    expect(normalizeLogoUrl('//images.example.test/nvda.png')).toBeNull();
    expect(normalizeLogoUrl('https://user:pass@images.example.test/a.png')).toBeNull();
  });

  it('treats the empty spellings of "no logo" as no logo', () => {
    expect(normalizeLogoUrl('')).toBeNull();
    expect(normalizeLogoUrl('   ')).toBeNull();
    expect(normalizeLogoUrl('null')).toBeNull();
    expect(normalizeLogoUrl(undefined)).toBeNull();
  });
});

describe('chooseInstrumentLogoUrl', () => {
  it('prefers the persisted logo over a provider answer', () => {
    expect(chooseInstrumentLogoUrl({
      persisted: 'https://images.example.test/stored.png',
      provider: 'https://images.example.test/fresh.png',
    })).toBe('https://images.example.test/stored.png');
  });

  it('never lets an empty provider answer erase a working logo', () => {
    for (const provider of [null, undefined, '', '   ']) {
      expect(chooseInstrumentLogoUrl({
        persisted: 'https://images.example.test/stored.png',
        provider,
      })).toBe('https://images.example.test/stored.png');
    }
  });

  it('falls back to the provider, then to nothing', () => {
    expect(chooseInstrumentLogoUrl({
      persisted: null,
      provider: 'https://images.example.test/fresh.png',
    })).toBe('https://images.example.test/fresh.png');
    expect(chooseInstrumentLogoUrl({ persisted: '', provider: null })).toBeNull();
  });
});

describe('shouldPersistInstrumentLogo', () => {
  it('writes only a new, usable URL', () => {
    expect(shouldPersistInstrumentLogo({
      persisted: null,
      resolved: 'https://images.example.test/a.png',
    })).toBe(true);
    expect(shouldPersistInstrumentLogo({
      persisted: 'https://images.example.test/a.png',
      resolved: 'https://images.example.test/a.png',
    })).toBe(false);
    expect(shouldPersistInstrumentLogo({
      persisted: 'https://images.example.test/a.png',
      resolved: null,
    })).toBe(false);
    expect(shouldPersistInstrumentLogo({ persisted: null, resolved: '' })).toBe(false);
  });
});

describe('ExpiringFailureMemory', () => {
  it('remembers a failure for its TTL and then allows another attempt', () => {
    const memory = new ExpiringFailureMemory(1_000);
    memory.remember('ONDS', 10_000);
    expect(memory.has('ONDS', 10_500)).toBe(true);
    expect(memory.has('ONDS', 11_001)).toBe(false);
    // Re-asking after the TTL must not re-arm the memory on its own.
    expect(memory.has('ONDS', 11_002)).toBe(false);
  });

  it('forgets on demand and knows nothing about other symbols', () => {
    const memory = new ExpiringFailureMemory(1_000);
    memory.remember('ONDS', 0);
    expect(memory.has('NVDA', 0)).toBe(false);
    memory.forget('ONDS');
    expect(memory.has('ONDS', 0)).toBe(false);
  });
});

describe('tidyInstrumentName', () => {
  it('drops the listing suffix without rewriting the company', () => {
    expect(tidyInstrumentName('Rocket Lab Corporation - Common Stock'))
      .toBe('Rocket Lab Corporation');
    expect(tidyInstrumentName('Navitas Semiconductor Corporation - Common Stock'))
      .toBe('Navitas Semiconductor Corporation');
    expect(tidyInstrumentName('Alphabet Inc. - Class A Common Stock'))
      .toBe('Alphabet Inc.');
    expect(tidyInstrumentName('State Street SPDR S&P 500 ETF Trust'))
      .toBe('State Street SPDR S&P 500 ETF Trust');
  });
});
