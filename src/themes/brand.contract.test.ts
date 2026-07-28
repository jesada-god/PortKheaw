import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('PortKheaw brand and Display contracts', () => {
  it('ships Kheaw in the app shell and all declared manifest assets exist', () => {
    const sidebar = readFileSync(resolve('src/components/layout/Sidebar.tsx'), 'utf8');
    const header = readFileSync(resolve('src/components/layout/Header.tsx'), 'utf8');
    const icon = readFileSync(resolve('app/icon.svg'), 'utf8');
    const manifest = JSON.parse(readFileSync(resolve('app/manifest.json'), 'utf8')) as {
      name: string;
      icons: Array<{ src: string; purpose?: string }>;
    };

    const authCard = readFileSync(resolve('src/components/auth/AuthCard.tsx'), 'utf8');

    expect(sidebar).toContain('<BrandMark');
    expect(header).toContain('<BrandMark');
    expect(authCard).toContain('<BrandMark');
    expect(authCard).not.toContain('>N<');
    expect(icon).toContain('aria-label="PortKheaw"');
    expect(manifest.name).toBe('PortKheaw');
    expect(manifest.icons.some(({ purpose }) => purpose === 'maskable')).toBe(true);
    manifest.icons.forEach(({ src }) => {
      expect(existsSync(resolve(src.replace(/^\//, 'public/').replace('public/icon.svg', 'app/icon.svg')))).toBe(true);
    });
  });

  it('ships PNG icons whose real pixels match what the manifest declares', () => {
    // Reads the PNG IHDR chunk directly (bytes 16-25) so the check needs no
    // image library: a 512-declared icon that is really 192 installs blurry.
    const header = (path: string) => {
      const bytes = readFileSync(resolve(path));
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
      return {
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        colorType: bytes[25],
      };
    };
    const manifest = JSON.parse(readFileSync(resolve('app/manifest.json'), 'utf8')) as {
      background_color: string;
      icons: Array<{ src: string; sizes: string; type: string }>;
    };

    for (const { src, sizes, type } of manifest.icons.filter((entry) => entry.src.endsWith('.png'))) {
      const [declared] = sizes.split('x').map(Number);
      const actual = header(src.replace(/^\//, 'public/'));
      expect(`${src} ${actual.width}x${actual.height} ${type}`)
        .toBe(`${src} ${declared}x${declared} image/png`);
    }

    // The mascot mark itself must stay a transparent cutout (RGBA, colour type 6)
    // so the black plate comes from the container, never baked into the artwork.
    expect(header('public/brand/kheaw-mark.png')).toEqual({ width: 960, height: 960, colorType: 6 });
    // Splash screens paint background_color behind the icon; anything but black
    // would put a coloured halo around the plate the icons already carry.
    expect(manifest.background_color).toBe('#000000');
  });

  it('sits the mascot on one black plate in both appearances and keeps the favicon textless', () => {
    const icon = readFileSync(resolve('app/icon.svg'), 'utf8');
    expect(icon).toContain('fill="#000000"');
    expect(icon).not.toContain('<text');

    for (const file of ['src/themes/portkheaw/dark.css', 'src/themes/portkheaw/light.css']) {
      expect(readFileSync(resolve(file), 'utf8')).toContain('--brand-mark-bg: #000000;');
    }
    for (const file of ['src/components/layout/Sidebar.tsx', 'src/components/layout/Header.tsx']) {
      expect(readFileSync(resolve(file), 'utf8')).toContain('bg-[var(--brand-mark-bg)]');
    }
    expect(readFileSync(resolve('scripts/build-kheaw-assets.mjs'), 'utf8'))
      .toContain("background: '#000000'");
  });

  it('keeps currency and language while exposing all three appearance modes', () => {
    const settings = readFileSync(resolve('app/settings/page.tsx'), 'utf8');
    const controls = readFileSync(resolve('src/themes/ThemeControls.tsx'), 'utf8');
    const registry = readFileSync(resolve('src/themes/registry.ts'), 'utf8');
    expect(settings).toContain('<ThemeControls');
    expect(settings).toContain('name="baseCurrency"');
    expect(settings).toContain('name="language"');
    expect(controls).toContain("value: 'system'");
    expect(controls).toContain("value: 'light'");
    expect(controls).toContain("value: 'dark'");
    expect(registry).toContain("label: 'PortKheaw'");
  });

  it('updates chart colors without recreating the chart or changing its data', () => {
    for (const file of [
      'src/components/stock/chart/LightweightChartHost.tsx',
      'src/components/stock/chart/technical/TechnicalChartHost.tsx',
    ]) {
      const source = readFileSync(resolve(file), 'utf8');
      expect(source).toContain('subscribeToAppearanceChange');
      expect(source).toContain('chart.applyOptions');
    }
  });
});
