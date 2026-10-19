/* Minimal LZ4 block codec (no frame header).  The device only needs the
   decompressor; the browser uses this compressor before BLE upload. */
export function lz4CompressBlock(input) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = [];
  const table = new Int32Array(1 << 16).fill(-1);
  let anchor = 0;
  let index = 0;
  const read32 = at => src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24);

  const emitLiterals = length => {
    if (length >= 15) {
      out.push(15);
      let rest = length - 15;
      while (rest >= 255) { out.push(255); rest -= 255; }
      out.push(rest);
    } else {
      out.push(length);
    }
  };

  while (index + 4 <= src.length) {
    const sequence = read32(index);
    const slot = ((sequence * 2654435761) >>> 16) & 0xffff;
    const reference = table[slot];
    table[slot] = index;
    if (reference >= 0 && index - reference < 65535 && read32(reference) === sequence) {
      let matchLength = 4;
      while (index + matchLength < src.length &&
             src[reference + matchLength] === src[index + matchLength]) matchLength++;
      const literals = index - anchor;
      const token = out.length;
      out.push(0);
      out[token] = (Math.min(literals, 15) << 4) | Math.min(matchLength - 4, 15);
      if (literals >= 15) {
        let rest = literals - 15;
        while (rest >= 255) { out.push(255); rest -= 255; }
        out.push(rest);
      }
      for (let at = anchor; at < index; at++) out.push(src[at]);
      const offset = index - reference;
      out.push(offset & 0xff, (offset >>> 8) & 0xff);
      if (matchLength - 4 >= 15) {
        let rest = matchLength - 4 - 15;
        while (rest >= 255) { out.push(255); rest -= 255; }
        out.push(rest);
      }
      index += matchLength;
      anchor = index;
    } else {
      index++;
    }
  }
  const literals = src.length - anchor;
  const token = out.length;
  out.push(0);
  out[token] = Math.min(literals, 15) << 4;
  if (literals >= 15) {
    let rest = literals - 15;
    while (rest >= 255) { out.push(255); rest -= 255; }
    out.push(rest);
  }
  for (let at = anchor; at < src.length; at++) out.push(src[at]);
  return Uint8Array.from(out);
}

export function lz4DecompressBlock(input, outputSize) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  const out = new Uint8Array(outputSize);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip++];
    let literals = token >>> 4;
    if (literals === 15) {
      let value;
      do { value = src[ip++]; literals += value; } while (value === 255);
    }
    if (op + literals > out.length) throw new Error('LZ4 literal overflow');
    for (let i = 0; i < literals; i++) out[op++] = src[ip++];
    if (op === out.length) break;
    if (ip + 2 > src.length) throw new Error('LZ4 missing offset');
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('LZ4 invalid offset');
    let match = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let value;
      do { value = src[ip++]; match += value; } while (value === 255);
    }
    if (op + match > out.length) throw new Error('LZ4 match overflow');
    let from = op - offset;
    for (let i = 0; i < match; i++) out[op++] = out[from++];
  }
  if (op !== out.length) throw new Error('LZ4 short output');
  return out;
}
