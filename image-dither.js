export const IMAGE_WIDTH = 400;
export const IMAGE_HEIGHT = 300;
export const IMAGE_BYTES = (IMAGE_WIDTH * IMAGE_HEIGHT) / 8;

const BAYER8 = [
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

function clamp(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/**
 * Prepare one RGBA layer for grayscale adjustment and dithering.
 * Transparent pixels use white as the processing backdrop so their zero RGB
 * values cannot pollute error diffusion or sharpness around transparent text.
 */
export function prepareMonochromeRgba(rgba, width = IMAGE_WIDTH, height = IMAGE_HEIGHT,
  {brightness = 0, contrast = 100, gamma = 100, invert = false} = {}) {
  if (!rgba || rgba.length < width * height * 4) throw new Error('RGBA 数据不完整');
  const output = new Uint8ClampedArray(rgba);
  const gain = contrast / 100;
  for (let i = 0; i < width * height * 4; i += 4) {
    const alpha = rgba[i + 3] / 255;
    if (alpha <= 0) {
      output[i] = output[i + 1] = output[i + 2] = 255;
      continue;
    }
    const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    let value = luma * alpha + 255 * (1 - alpha);
    value += brightness;
    value = (value - 128) * gain + 128;
    if (gamma !== 100) value = 255 * Math.pow(Math.max(0, Math.min(255, value)) / 255, 100 / gamma);
    if (invert) value = 255 - value;
    value = clamp(value);
    output[i] = output[i + 1] = output[i + 2] = value;
  }
  return output;
}

/**
 * 把 400x300 的 RGBA 像素抖动成 1bpp 整屏位图。
 * mode=color 走带颜色加权的蛇形 Floyd-Steinberg；mode=classic 走 Bayer 8x8。
 * 返回行字节对齐、MSB 在左、1=墨点的 15,000 字节。
 */
export function ditherPixels(rgba, width = IMAGE_WIDTH, height = IMAGE_HEIGHT,
  {mode = 'color', threshold = 50, contrast = 100} = {}) {
  if (!rgba || rgba.length < width * height * 4) throw new Error('RGBA 数据不完整');
  const gray = new Float32Array(width * height);
  const gain = Math.max(0.1, contrast / 100);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    /* 颜色加权而不是简单平均，红色和绿色对亮度贡献不同。 */
    const luma = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
    gray[i] = clamp(128 + (luma - 128) * gain);
  }
  const level = clamp((threshold / 100) * 255);
  const out = new Uint8Array((width * height) / 8);

  if (mode === 'binary') {
    for (let i = 0; i < gray.length; i++) {
      if (gray[i] < level) out[i >> 3] |= 0x80 >> (i & 7);
    }
    return out;
  }

  if (mode === 'classic') {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const ordered = (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) * 4;
        if (gray[y * width + x] < ordered + (level - 128) * 0.55) {
          const bit = y * width + x;
          out[bit >> 3] |= 0x80 >> (bit & 7);
        }
      }
    }
    return out;
  }

  /* 蛇形 Floyd-Steinberg：每一行反向扫描，避免固定方向的拖尾。 */
  for (let y = 0; y < height; y++) {
    const reverse = (y & 1) !== 0;
    for (let step = 0; step < width; step++) {
      const x = reverse ? width - 1 - step : step;
      const index = y * width + x;
      const old = gray[index];
      const next = old >= level ? 255 : 0;
      const error = old - next;
      if (next === 0) out[index >> 3] |= 0x80 >> (index & 7);
      const push = (dx, dy, factor) => {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && nx < width && ny < height) gray[ny * width + nx] += error * factor;
      };
      push(reverse ? -1 : 1, 0, 7 / 16);
      push(reverse ? 1 : -1, 1, 3 / 16);
      push(0, 1, 5 / 16);
      push(reverse ? -1 : 1, 1, 1 / 16);
    }
  }
  return out;
}

export function monoToRgba(bits, width = IMAGE_WIDTH, height = IMAGE_HEIGHT) {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const ink = (bits[i >> 3] & (0x80 >> (i & 7))) !== 0;
    const value = ink ? 0 : 255;
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}
