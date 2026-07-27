import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force the Supabase-unconfigured branch so the middleware builds and returns the
// security headers without constructing a Supabase client or hitting the network.
vi.mock('@/src/config/env/client', () => ({
  isSupabaseConfigured: false,
  clientEnv: { NEXT_PUBLIC_SUPABASE_URL: undefined },
}));

const ORIGINAL_WS_URL = process.env.NEXT_PUBLIC_MARKET_WS_URL;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string): void {
  (process.env as Record<string, string>).NODE_ENV = value;
}

async function directiveOf(prefix: string): Promise<string> {
  // Import lazily so each test observes the current process.env values.
  const { middleware } = await import('./middleware');
  const response = await middleware(new NextRequest('http://localhost:3000/'));
  const policy = response.headers.get('Content-Security-Policy') ?? '';
  const directive = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return directive ?? '';
}

async function connectSrc(): Promise<string> {
  return directiveOf('connect-src ');
}

async function scriptSrc(): Promise<string> {
  return directiveOf('script-src ');
}

async function imgSrc(): Promise<string> {
  return directiveOf('img-src ');
}

describe('middleware CSP connect-src for the market WebSocket Gateway', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (ORIGINAL_WS_URL === undefined) delete process.env.NEXT_PUBLIC_MARKET_WS_URL;
    else process.env.NEXT_PUBLIC_MARKET_WS_URL = ORIGINAL_WS_URL;
    setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
  });

  it('allows the local ws Gateway origin in development from the env URL', async () => {
    setNodeEnv('development');
    process.env.NEXT_PUBLIC_MARKET_WS_URL = 'ws://localhost:8081/ws';
    const directive = await connectSrc();
    expect(directive).toContain(`'self'`);
    expect(directive).toContain('ws://localhost:8081');
    // Only the origin is allowed — never the full path.
    expect(directive).not.toContain('ws://localhost:8081/ws');
  });

  it('falls back to the local ws Gateway in development when the env URL is unset', async () => {
    setNodeEnv('development');
    delete process.env.NEXT_PUBLIC_MARKET_WS_URL;
    const directive = await connectSrc();
    expect(directive).toContain('ws://localhost:8081');
  });

  it('allows only the wss Gateway origin from env in production, no hardcoded domain', async () => {
    setNodeEnv('production');
    process.env.NEXT_PUBLIC_MARKET_WS_URL = 'wss://gateway.example.com/ws';
    const directive = await connectSrc();
    expect(directive).toContain('wss://gateway.example.com');
    expect(directive).not.toContain('/ws');
    expect(directive).not.toContain('localhost');
  });

  it('adds no Gateway source in production when the env URL is unset', async () => {
    setNodeEnv('production');
    delete process.env.NEXT_PUBLIC_MARKET_WS_URL;
    const directive = await connectSrc();
    expect(directive).toBe(`connect-src 'self'`);
    expect(directive).not.toContain('localhost');
  });

  it('never widens the policy to a wildcard and ignores an unparseable URL', async () => {
    setNodeEnv('production');
    process.env.NEXT_PUBLIC_MARKET_WS_URL = 'not a url';
    const directive = await connectSrc();
    expect(directive).toBe(`connect-src 'self'`);
    expect(directive).not.toContain('*');
  });
});

describe('middleware CSP img-src for publisher news thumbnails', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
  });

  it('permits any HTTPS publisher CDN so real article thumbnails can render', async () => {
    setNodeEnv('production');
    const directive = await imgSrc();
    expect(directive).toContain(`'self'`);
    expect(directive).toContain('https:');
    // The previous single-host allowlist meant no genuine news image ever loaded.
    expect(directive).not.toContain('picsum.photos');
  });

  it('never widens img-src to plaintext HTTP or a wildcard', async () => {
    setNodeEnv('production');
    const directive = await imgSrc();
    expect(directive).not.toContain('http:');
    expect(directive).not.toContain('*');
  });
});

describe('middleware CSP script-src never allows unsafe-eval in production', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    setNodeEnv(ORIGINAL_NODE_ENV ?? 'test');
  });

  it('omits unsafe-eval from script-src in production', async () => {
    setNodeEnv('production');
    const directive = await scriptSrc();
    expect(directive).toContain(`'self'`);
    expect(directive).not.toContain(`'unsafe-eval'`);
  });

  it('omits unsafe-eval from script-src outside development (e.g. test/preview)', async () => {
    setNodeEnv('test');
    const directive = await scriptSrc();
    expect(directive).not.toContain(`'unsafe-eval'`);
  });

  it('permits unsafe-eval ONLY in development (Next dev needs eval-source-map)', async () => {
    setNodeEnv('development');
    const directive = await scriptSrc();
    // Development tooling requires it; it must never leak into a shipped build.
    expect(directive).toContain(`'unsafe-eval'`);
  });
});
