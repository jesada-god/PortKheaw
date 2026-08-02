export type PushDeviceState =
  | 'unsupported'
  | 'blocked'
  | 'unavailable'
  | 'off'
  | 'on';

export function resolvePushDeviceState(input: {
  supported: boolean;
  permission: NotificationPermission;
  subscribed: boolean;
  configured: boolean;
}): PushDeviceState {
  if (!input.supported) return 'unsupported';
  if (input.permission === 'denied') return 'blocked';
  if (!input.configured) return 'unavailable';
  return input.permission === 'granted' && input.subscribed ? 'on' : 'off';
}

export function decodeVapidPublicKey(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(
    (value + padding).replace(/-/g, '+').replace(/_/g, '/'),
  );
  return Uint8Array.from(
    binary,
    (character) => character.charCodeAt(0),
  );
}
