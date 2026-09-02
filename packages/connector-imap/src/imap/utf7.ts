const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,";

function decodeChunk(chunk: string): string | null {
  let bits = 0;
  let accumulator = 0;
  const units: number[] = [];
  for (const character of chunk) {
    const value = BASE64.indexOf(character);
    if (value === -1) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 16) {
      bits -= 16;
      units.push((accumulator >> bits) & 0xffff);
    }
  }
  if (bits >= 6 || (accumulator & ((1 << bits) - 1)) !== 0) return null;
  return String.fromCharCode(...units);
}

/**
 * RFC 3501 modified UTF-7. A malformed run is left verbatim: a mailbox name
 * the server chose is not the connector's to reject.
 */
export function decodeModifiedUtf7(wire: string): string {
  let out = "";
  let index = 0;
  while (index < wire.length) {
    const start = wire.indexOf("&", index);
    if (start === -1) return out + wire.slice(index);
    out += wire.slice(index, start);
    const end = wire.indexOf("-", start + 1);
    if (end === -1) return out + wire.slice(start);
    const chunk = wire.slice(start + 1, end);
    if (chunk.length === 0) {
      out += "&";
    } else {
      const decoded = decodeChunk(chunk);
      if (decoded === null) {
        out += wire.slice(start, end + 1);
      } else {
        out += decoded;
      }
    }
    index = end + 1;
  }
  return out;
}
