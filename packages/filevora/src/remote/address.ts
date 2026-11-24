import { isIP } from 'node:net';

export type BlockReason =
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'multicast'
  | 'metadata'
  | 'unspecified'
  | 'reserved';

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.google.com',
  'metadata.goog',
  'instance-data',
]);

/** True when the hostname is a cloud metadata name, before DNS. */
export function isMetadataHost(hostname: string): boolean {
  return METADATA_HOSTS.has(hostname.toLowerCase().replace(/\.+$/, ''));
}

/**
 * Decode a hostname that is an IPv4 address, including decimal, hex, octal,
 * and short forms. Returns a dotted quad, or null when it is not an address.
 */
export function decodeIPv4Hostname(hostname: string): string | null {
  const value = hostname.trim().toLowerCase();
  if (value.includes(':')) return null;
  const parts = value.split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  if (parts.some((part) => part.length === 0)) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const parsed = readPart(part);
    if (parsed === null) return null;
    numbers.push(parsed);
  }
  let packed = 0;
  for (let index = 0; index < numbers.length; index += 1) {
    const last = index === numbers.length - 1;
    const bits = last ? 32 - 8 * index : 8;
    const shift = last ? 0 : 24 - 8 * index;
    const part = numbers[index] ?? 0;
    if (part < 0 || part >= 2 ** bits) return null;
    packed |= part << shift;
  }
  return quad(packed >>> 0);
}

function readPart(part: string): number | null {
  if (/^0x[0-9a-f]+$/.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part, 8);
  if (/^\d+$/.test(part)) return Number.parseInt(part, 10);
  return null;
}

function quad(packed: number): string {
  return [
    (packed >>> 24) & 0xff,
    (packed >>> 16) & 0xff,
    (packed >>> 8) & 0xff,
    packed & 0xff,
  ].join('.');
}

/** Why an IP cannot be used as a remote origin. Null means it is a public address. */
export function blockReason(address: string): BlockReason | null {
  const mapped = mappedIPv4(address);
  if (mapped) return blockIPv4(mapped);
  if (isIP(address) === 6) return blockIPv6(address);
  const v4 = isIP(address) === 4 ? address : decodeIPv4Hostname(address);
  if (!v4) return null;
  return blockIPv4(v4);
}

function mappedIPv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1]) return decodeIPv4Hostname(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (!hex?.[1] || !hex[2]) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return quad(((high << 16) | low) >>> 0);
}

function blockIPv4(address: string): BlockReason | null {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part)))
    return 'reserved';
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  const value = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata';
  if (a === 169 && b === 254 && c === 170 && d === 2) return 'metadata';
  if (a === 100 && b === 100 && c === 100 && d === 200) return 'metadata';
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'private';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240 || value === 0xff_ff_ff_ff) return 'reserved';
  return null;
}

function blockIPv6(address: string): BlockReason | null {
  const expanded = expandIPv6(address);
  if (!expanded) return 'reserved';
  const head = expanded[0] ?? 0;
  if (expanded.every((part) => part === 0)) return 'unspecified';
  if (expanded.slice(0, 7).every((part) => part === 0) && expanded[7] === 1)
    return 'loopback';
  if (
    expanded.slice(0, 5).every((part) => part === 0) &&
    expanded[5] === 0xffff
  ) {
    const high = expanded[6] ?? 0;
    const low = expanded[7] ?? 0;
    return blockIPv4(quad(((high << 16) | low) >>> 0));
  }
  if (head >= 0xfe80 && head <= 0xfebf) return 'link-local';
  if (head >= 0xfc00 && head <= 0xfdff) {
    if (
      expanded[0] === 0xfd00 &&
      expanded[1] === 0xec2 &&
      expanded[7] === 0x254 &&
      expanded.slice(2, 7).every((part) => part === 0)
    )
      return 'metadata';
    return 'private';
  }
  if ((head & 0xff00) === 0xff00) return 'multicast';
  return null;
}

function expandIPv6(address: string): number[] | null {
  const lower = address.toLowerCase().split('%')[0] ?? '';
  const halves = lower.split('::');
  if (halves.length > 2) return null;
  const parse = (side: string) =>
    side.length === 0
      ? []
      : side.split(':').map((part) => Number.parseInt(part, 16));
  const left = parse(halves[0] ?? '');
  const right = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (
    [...left, ...right].some((part) => !Number.isInteger(part) || part > 0xffff)
  )
    return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}
