export type ExifMode = 'gps' | 'all' | 'none';

/**
 * Strip location metadata from a JPEG or PNG. `all` drops the whole EXIF block.
 * `none` returns the same bytes. Other containers are unchanged.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  mode: ExifMode,
): Uint8Array {
  if (mode === 'none') return bytes;
  if (isPng(bytes)) return stripPng(bytes, mode);
  if (isJpeg(bytes)) return stripJpeg(bytes, mode);
  return bytes;
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function stripJpeg(bytes: Uint8Array, mode: ExifMode): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xda || marker === 0xd9) {
      parts.push(bytes.subarray(offset));
      break;
    }
    const size = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    const end = offset + 2 + size;
    if (end > bytes.length) break;
    const segment = bytes.subarray(offset, end);
    if (marker === 0xe1 && ascii(segment, 4, 4) === 'Exif') {
      if (mode === 'all') {
        offset = end;
        continue;
      }
      const cleaned = stripGpsTiff(segment.subarray(10));
      const next = new Uint8Array(10 + cleaned.length);
      next.set(segment.subarray(0, 10));
      next.set(cleaned, 10);
      next[2] = ((next.length - 2) >> 8) & 0xff;
      next[3] = (next.length - 2) & 0xff;
      parts.push(next);
    } else {
      parts.push(segment);
    }
    offset = end;
  }
  return concat(parts);
}

function stripPng(bytes: Uint8Array, mode: ExifMode): Uint8Array {
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    const type = ascii(bytes, offset + 4, 4);
    const chunk = bytes.subarray(offset, end);
    if (type === 'eXIf') {
      if (mode !== 'all') {
        const cleaned = stripGpsTiff(chunk.subarray(8, 8 + length));
        parts.push(pngChunk('eXIf', cleaned));
      }
    } else {
      parts.push(chunk);
    }
    offset = end;
  }
  return concat(parts);
}

/** Drop the GPS IFD pointer (tag 0x8825) and the IFD it points at. */
export function stripGpsTiff(tiff: Uint8Array): Uint8Array {
  if (tiff.length < 8) return tiff;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const read16 = (offset: number) => view.getUint16(offset, little);
  const read32 = (offset: number) => view.getUint32(offset, little);
  const ifd = read32(4);
  if (ifd + 2 > tiff.length) return tiff;
  const count = read16(ifd);
  let gps: number | null = null;
  const kept: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > tiff.length) return tiff;
    const tag = read16(entry);
    if (tag === 0x8825) gps = read32(entry + 8);
    else kept.push(tiff.subarray(entry, entry + 12));
  }
  if (gps === null) return tiff;
  const next = new Uint8Array(tiff.length);
  next.set(tiff);
  const out = new DataView(next.buffer);
  out.setUint16(ifd, kept.length, little);
  let cursor = ifd + 2;
  for (const entry of kept) {
    next.set(entry, cursor);
    cursor += 12;
  }
  const nextIfd = ifd + 2 + count * 12;
  if (nextIfd + 4 <= next.length) {
    out.setUint32(cursor, read32(nextIfd), little);
  }
  if (gps > 0 && gps < next.length) {
    const gpsCount = gps + 2 <= next.length ? read16(gps) : 0;
    const gpsEnd = Math.min(next.length, gps + 2 + gpsCount * 12 + 4);
    next.fill(0, gps, gpsEnd);
  }
  return next;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(Buffer.from(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xed_b8_83_20 : crc >>> 1;
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(offset);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}
