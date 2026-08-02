export function deviceLabelFromUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'อุปกรณ์นี้';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'iPhone หรือ iPad';
  if (/android/i.test(userAgent)) return 'Android';
  if (/windows/i.test(userAgent)) return 'Windows';
  if (/macintosh|mac os/i.test(userAgent)) return 'Mac';
  if (/linux/i.test(userAgent)) return 'Linux';
  return 'อุปกรณ์นี้';
}
