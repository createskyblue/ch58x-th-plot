import {TYPES} from './protocol.js';
import {IMAGE_WIDTH, IMAGE_HEIGHT, crc32} from './image-dither.js?v=transparent-alpha-preset-fix';

export function clipboardImage(items) {
  for (const item of items || []) if (item.type.startsWith('image/')) return item.getAsFile();
  return null;
}

export async function uploadImageBytes(stored, request, send, callbacks) {
  const started = performance.now();
  const checksum = crc32(stored);
  const begin = new Uint8Array(12), view = new DataView(begin.buffer);
  view.setUint16(0, IMAGE_WIDTH, true); view.setUint16(2, IMAGE_HEIGHT, true);
  view.setUint32(4, stored.length, true); view.setUint32(8, checksum, true);
  const checkCancelled = () => { if (callbacks.isCancelled()) throw new Error('上传已取消'); };
  const checkReply = data => { if (data.length !== 1 || data[0] !== 0) throw new Error('设备上传响应错误'); };
  try {
    checkCancelled();
    checkReply(await request(TYPES.imageBegin, begin, 10000));
    const transferStarted = performance.now();
    for (let offset = 0; offset < stored.length; offset += 116) {
      checkCancelled();
      const chunk = stored.subarray(offset, offset + 116), payload = new Uint8Array(4 + chunk.length);
      new DataView(payload.buffer).setUint32(0, offset, true); payload.set(chunk, 4);
      await send(TYPES.imageData, payload);
      callbacks.onQueued?.(offset + chunk.length);
    }
    checkCancelled(); callbacks.onCommit?.();
    const commit = new Uint8Array(4); new DataView(commit.buffer).setUint32(0, checksum, true);
    checkReply(await request(TYPES.imageCommit, commit, 10000));
    return {transferMs:performance.now() - transferStarted, totalMs:performance.now() - started};
  } catch (error) {
    try { await request(TYPES.imageCancel); } catch { /* A disconnected device cancels locally. */ }
    throw error;
  }
}
