const nativeDecoder =
  typeof TextDecoder === "function" ? new TextDecoder("utf-8", { fatal: true }) : null;

export function decodeUtf8(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  let index = 0;

  while (index < bytes.length) {
    const lead = bytes[index];
    let codePoint: number;
    let width: number;

    if (lead < 0x80) {
      codePoint = lead;
      width = 1;
    } else if ((lead & 0xe0) === 0xc0) {
      codePoint = lead & 0x1f;
      width = 2;
    } else if ((lead & 0xf0) === 0xe0) {
      codePoint = lead & 0x0f;
      width = 3;
    } else if ((lead & 0xf8) === 0xf0) {
      codePoint = lead & 0x07;
      width = 4;
    } else {
      throw new Error(`Invalid UTF-8 lead byte at index ${index}`);
    }

    if (index + width > bytes.length) {
      throw new Error(`Truncated UTF-8 sequence at index ${index}`);
    }

    for (let offset = 1; offset < width; offset += 1) {
      const continuation = bytes[index + offset];
      if ((continuation & 0xc0) !== 0x80) {
        throw new Error(`Invalid UTF-8 continuation byte at index ${index + offset}`);
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }

    chunk += String.fromCodePoint(codePoint);
    index += width;

    if (chunk.length >= 8192) {
      parts.push(chunk);
      chunk = "";
    }
  }

  parts.push(chunk);
  return parts.join("");
}

export function decodeSocketFrame(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(data));
  }

  if (ArrayBuffer.isView(data)) {
    return decodeBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  throw new Error(
    `Unsupported WebSocket frame ${Object.prototype.toString.call(data)}; expected text or binary`,
  );
}

function decodeBytes(bytes: Uint8Array): string {
  return nativeDecoder === null ? decodeUtf8(bytes) : nativeDecoder.decode(bytes);
}
