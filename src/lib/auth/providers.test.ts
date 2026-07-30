import { describe, expect, it } from 'vitest';
import { NO_EXTERNAL_PROVIDERS, parseEnabledProviders } from './providers';

describe('parseEnabledProviders', () => {
  it('reports Google as available only when the project has actually enabled it', () => {
    // The live answer for this project at the time of writing.
    expect(parseEnabledProviders({ external: { google: false, email: true } })).toEqual({ google: false });
    expect(parseEnabledProviders({ external: { google: true, email: true } })).toEqual({ google: true });
  });

  it('fails closed on anything it cannot read, so a broken button is never rendered', () => {
    for (const payload of [null, undefined, 'nope', 42, {}, { external: null }, { external: 'google' }]) {
      expect(parseEnabledProviders(payload)).toEqual(NO_EXTERNAL_PROVIDERS);
    }
  });

  it('requires a real boolean, not a truthy string, before showing the button', () => {
    expect(parseEnabledProviders({ external: { google: 'true' } })).toEqual({ google: false });
    expect(parseEnabledProviders({ external: { google: 1 } })).toEqual({ google: false });
  });

  /**
   * The settings document carries a lot more than this. Only the one boolean the
   * UI needs is kept, so no provider configuration detail can leak into a page
   * an anonymous visitor can read.
   */
  it('keeps nothing from the settings document except the one boolean the UI needs', () => {
    const parsed = parseEnabledProviders({
      external: { google: true, apple: true, github: true, email: true },
      disable_signup: false,
      mailer_autoconfirm: false,
      saml_enabled: false,
      sms_provider: 'twilio',
    });
    expect(Object.keys(parsed)).toEqual(['google']);
  });
});
