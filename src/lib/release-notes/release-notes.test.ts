import { describe, expect, it } from 'vitest';
import {
  normalizeReleaseImportance, parseReleaseBody, validateReleaseDraft,
} from './release-notes';

describe('release bodies are text, and stay text', () => {
  it('reads the usual bullet marks as bullets and keeps everything else', () => {
    expect(parseReleaseBody('• เพิ่มพอร์ตใหม่\n- ปรับปรุงกราฟ\nสรุปการอัปเดต')).toEqual([
      { kind: 'bullet', text: 'เพิ่มพอร์ตใหม่' },
      { kind: 'bullet', text: 'ปรับปรุงกราฟ' },
      { kind: 'paragraph', text: 'สรุปการอัปเดต' },
    ]);
  });

  it('drops blank lines rather than rendering empty rows', () => {
    expect(parseReleaseBody('• หนึ่ง\n\n\n• สอง')).toHaveLength(2);
  });

  /*
   * The body reaches every signed-in reader's session, so markup never becomes
   * markup. Angle brackets survive as *characters* in the parsed text — the
   * renderer escapes them — and the validator refuses the draft before it is
   * ever stored.
   */
  it('never turns a script payload into anything but characters', () => {
    const payload = '<script>alert(1)</script>';
    expect(parseReleaseBody(payload)).toEqual([{ kind: 'paragraph', text: payload }]);
    expect(validateReleaseDraft({
      version: '', title: 'ok', content: payload, importance: 'normal',
    })).toBe('markup');
  });

  it('refuses markup in the title and the version too', () => {
    expect(validateReleaseDraft({
      version: '', title: '<img src=x onerror=1>', content: 'ok', importance: 'normal',
    })).toBe('markup');
    expect(validateReleaseDraft({
      version: '<b>', title: 'ok', content: 'ok', importance: 'normal',
    })).toBe('markup');
  });

  it('requires a title and a body', () => {
    expect(validateReleaseDraft({ version: '', title: '  ', content: 'ok', importance: 'normal' }))
      .toBe('title');
    expect(validateReleaseDraft({ version: '', title: 'ok', content: '  ', importance: 'normal' }))
      .toBe('content');
  });

  it('accepts an ordinary draft', () => {
    expect(validateReleaseDraft({
      version: '1.4.0', title: 'PortKheaw Update', content: '• เพิ่มระบบแจ้งเตือน', importance: 'important',
    })).toBeNull();
  });

  it('fails an unrecognised importance to the quieter presentation', () => {
    expect(normalizeReleaseImportance('critical')).toBe('normal');
    expect(normalizeReleaseImportance(undefined)).toBe('normal');
    expect(normalizeReleaseImportance('important')).toBe('important');
  });
});
