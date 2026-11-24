const SIGNATURES: Array<{
  mime: string;
  check: (bytes: Uint8Array) => boolean;
}> = [
  { mime: 'image/png', check: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47]) },
  { mime: 'image/jpeg', check: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  {
    mime: 'image/gif',
    check: (b) => ascii(b, 6) === 'GIF87a' || ascii(b, 6) === 'GIF89a',
  },
  {
    mime: 'image/webp',
    check: (b) => ascii(b, 4) === 'RIFF' && ascii(b.subarray(8), 4) === 'WEBP',
  },
  { mime: 'application/pdf', check: (b) => ascii(b, 5) === '%PDF-' },
  { mime: 'video/webm', check: (b) => starts(b, [0x1a, 0x45, 0xdf, 0xa3]) },
  {
    mime: 'audio/wav',
    check: (b) => ascii(b, 4) === 'RIFF' && ascii(b.subarray(8), 4) === 'WAVE',
  },
  { mime: 'audio/ogg', check: (b) => ascii(b, 4) === 'OggS' },
  {
    mime: 'application/zip',
    check: (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]),
  },
];

function starts(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  return magic.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, length: number): string {
  return String.fromCharCode(...bytes.subarray(0, length));
}

/**
 * Detect a MIME type from leading bytes. Returns null when the sample is not
 * a known signature. Callers must not trust the client-supplied type instead.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 12 &&
    ascii(bytes, 4) === 'RIFF' &&
    ascii(bytes.subarray(8), 4) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (
    bytes.length >= 12 &&
    ascii(bytes, 4) === 'RIFF' &&
    ascii(bytes.subarray(8), 4) === 'WAVE'
  ) {
    return 'audio/wav';
  }
  for (const signature of SIGNATURES) {
    if (signature.check(bytes)) return signature.mime;
  }
  if (bytes.length >= 12 && ascii(bytes.subarray(4), 4) === 'ftyp') {
    const brand = ascii(bytes.subarray(8), 4);
    if (brand.startsWith('qt')) return 'video/quicktime';
    if (brand === 'M4A ' || brand === 'M4A\0') return 'audio/mp4';
    return 'video/mp4';
  }
  const second = bytes[1];
  if (
    bytes.length >= 3 &&
    (ascii(bytes, 3) === 'ID3' ||
      (bytes[0] === 0xff && second !== undefined && (second & 0xe0) === 0xe0))
  ) {
    return 'audio/mpeg';
  }
  return null;
}

export function mimeAllowed(
  mime: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/*')) return mime.startsWith(pattern.slice(0, -1));
    return pattern === mime;
  });
}

/** Display name only. Slashes and control characters never become object keys. */
export function sanitizeFilename(input: string): string {
  const base = input.split(/[/\\]/).pop() ?? 'file';
  let cleaned = '';
  for (const char of base) {
    const code = char.charCodeAt(0);
    if (code > 31 && code !== 127) cleaned += char;
  }
  cleaned = cleaned.trim();
  const sliced = cleaned.slice(0, 180);
  return sliced.length > 0 ? sliced : 'file';
}

export function metadataObject(input: unknown): Record<string, string> {
  if (input === undefined) return {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('metadata must be an object of strings');
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 32) throw new Error('metadata has too many keys');
  const output: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key))
      throw new Error('metadata key is invalid');
    if (typeof value !== 'string' || value.length > 500)
      throw new Error('metadata values must be short strings');
    output[key] = value;
  }
  if (JSON.stringify(output).length > 8000)
    throw new Error('metadata is too large');
  return output;
}
