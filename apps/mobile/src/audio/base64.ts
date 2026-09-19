const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const DECODE_TABLE = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < ALPHABET.length; index += 1) {
    table[ALPHABET.charCodeAt(index)] = index;
  }
  table["=".charCodeAt(0)] = -2;
  return table;
})();

export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const byte0 = bytes[index] ?? 0;
    const byte1 = bytes[index + 1] ?? 0;
    const byte2 = bytes[index + 2] ?? 0;
    const remaining = bytes.length - index;

    chunk += ALPHABET[byte0 >> 2];
    chunk += ALPHABET[((byte0 & 0x03) << 4) | (byte1 >> 4)];
    chunk += remaining > 1 ? ALPHABET[((byte1 & 0x0f) << 2) | (byte2 >> 6)] : "=";
    chunk += remaining > 2 ? ALPHABET[byte2 & 0x3f] : "=";

    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }

  parts.push(chunk);
  return parts.join("");
}

export function decodeBase64(text: string): Uint8Array {
  let padding = 0;
  if (text.endsWith("==")) {
    padding = 2;
  } else if (text.endsWith("=")) {
    padding = 1;
  }

  if (text.length % 4 !== 0) {
    throw new Error("Base64 length must be a multiple of four");
  }

  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let offset = 0;

  for (let index = 0; index < text.length; index += 4) {
    let accumulator = 0;
    let bits = 0;

    for (let position = 0; position < 4; position += 1) {
      const code = text.charCodeAt(index + position);
      const value = code < 128 ? DECODE_TABLE[code] : -1;

      if (value === -1) {
        throw new Error(`Invalid base64 character at index ${index + position}`);
      }

      if (value === -2) {
        continue;
      }

      accumulator = (accumulator << 6) | value;
      bits += 6;
    }

    accumulator <<= 24 - bits;

    for (let shift = 16; shift >= 24 - bits; shift -= 8) {
      if (offset < bytes.length) {
        bytes[offset] = (accumulator >> shift) & 0xff;
        offset += 1;
      }
    }
  }

  return bytes;
}
