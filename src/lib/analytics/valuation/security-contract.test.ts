import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const grounded = readFileSync(new URL('./grounded-research.ts', import.meta.url), 'utf8');
const orchestration = readFileSync(new URL('./orchestration.ts', import.meta.url), 'utf8');
const browserCard = readFileSync(
  new URL('../../../components/analytics/fair-value/FairValueCard.tsx', import.meta.url),
  'utf8',
);
const browserClient = readFileSync(
  new URL('../../../components/analytics/fair-value/fair-value-client.ts', import.meta.url),
  'utf8',
);

describe('Fair Value server-secret boundary', () => {
  it('keeps Gemini configuration in server-only modules', () => {
    expect(grounded.startsWith("import 'server-only';")).toBe(true);
    expect(orchestration.startsWith("import 'server-only';")).toBe(true);
    expect(grounded).toContain('serverEnv.GEMINI_API_KEY');
    expect(browserCard).not.toContain('GEMINI_API_KEY');
    expect(browserClient).not.toContain('GEMINI_API_KEY');
  });

  it('never serializes the Gemini key into research prompts or audit payloads', () => {
    expect(grounded).not.toContain('apiKey: apiKey');
    expect(orchestration).not.toContain('GEMINI_API_KEY');
    expect(orchestration).not.toContain('apiKey');
  });
});
