// 零依赖的"存储式 ZIP"解包器：只支持 method=0 (stored) 的条目，
// 对应 tools/pack_epaper.py 产出的 epaper-sequence.zip。
// 一次性 fetch 整个 zip，按帧名 fNNNN.png 拆出 Blob URL，把 100 个请求收敛成 1 个。
//
// PNG 本身已是 deflate 压缩，打包时不二次压缩，所以"解包"= 从容器里切出字节，
// 不需要 inflate。若日后需要更小的单文件，可改用 deflated 条目并接 fflate，
// 但本项目 PNG 已压缩，收益几乎为零，故保持零依赖。

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;

function findEOCD(view, bytes) {
  // EOCD 必在文件末尾，从尾部往回扫第一个签名即可，避免误命中 PNG 数据里的巧合字节。
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) return i;
  }
  return -1;
}

// 返回 Map<帧索引(0基), objectURL>
export async function loadEpaperSequenceZip(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`epaper zip 请求失败: ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const eocd = findEOCD(view, bytes);
  if (eocd < 0) throw new Error('找不到 ZIP 的 EOCD 记录');
  const cdCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  const NAME_RE = /f(\d+)\.png$/i;
  const frames = new Map();
  let p = cdOffset;
  for (let n = 0; n < cdCount; n++) {
    if (view.getUint32(p, true) !== CDH_SIG) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const m = NAME_RE.exec(name);
    if (m) {
      if (method !== 0) throw new Error(`仅支持存储式条目，遇到压缩条目: ${name}`);
      const lp = localOffset;
      if (view.getUint32(lp, true) !== LFH_SIG) throw new Error(`本地文件头损坏: ${name}`);
      const lNameLen = view.getUint16(lp + 26, true);
      const lExtraLen = view.getUint16(lp + 28, true);
      const dataStart = lp + 30 + lNameLen + lExtraLen;
      // subarray 共享底层 buffer；new Blob([...]) 会拷贝，不长期持有整包。
      const slice = bytes.subarray(dataStart, dataStart + compSize);
      const blob = new Blob([slice], { type: 'image/png' });
      frames.set(parseInt(m[1], 10) - 1, URL.createObjectURL(blob));
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (frames.size === 0) throw new Error('zip 里没有 fNNNN.png 帧');
  return frames;
}
