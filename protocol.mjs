export const TYPES = Object.freeze({info:1, readUser:2, writeUser:3, latest:4, reboot:5, activation:6, settingsRead:7, settingsWrite:8, windowRead:9, windowWrite:10, importBegin:0x20, importData:0x21, importCommit:0x22, importCancel:0x23, history:0x10, cancel:0x11, complete:0x12, begin:0x90, data:0x91, end:0x92, error:0xff});

export function formatBuildStamp(bytes) {
    const match = /^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}:\d{2}:\d{2})$/.exec(String.fromCharCode(...bytes).trim());
    if (!match) return '编译时间格式错误';
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[1]) + 1;
    if (!month) return '编译时间格式错误';
    return match[3] + '-' + String(month).padStart(2, '0') + '-' + match[2].padStart(2, '0') + ' ' + match[4];
}

export function crc16(bytes) {
    let crc = 0;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xa001 : 0);
    }
    return crc;
}
export function encodeFrame(id, type, payload = new Uint8Array()) {
    if (payload.length > 128) throw new Error('Request exceeds device payload limit');
    const frame = new Uint8Array(payload.length ? payload.length + 10 : 8);
    const view = new DataView(frame.buffer);
    frame[0] = 1; view.setUint16(1, id); view.setUint16(3, payload.length); frame[5] = type;
    view.setUint16(6, crc16(frame.subarray(0, 6)));
    if (payload.length) { frame.set(payload, 8); view.setUint16(frame.length - 2, crc16(payload)); }
    return frame;
}
export class FrameParser {
    constructor(onFrame, onError = () => {}) { this.onFrame = onFrame; this.onError = onError; this.buffer = []; this.last = 0; }
    reset() { this.buffer = []; }
    accept(bytes, now = Date.now()) {
        if (now - this.last >= 1000) this.reset();
        this.last = now;
        for (const byte of bytes) {
            if (this.buffer.length === 0 && byte !== 1) continue;
            this.buffer.push(byte);
            if (this.buffer.length < 8) continue;
            const head = Uint8Array.from(this.buffer.slice(0, 8));
            const view = new DataView(head.buffer);
            const length = view.getUint16(3);
            if (crc16(head.subarray(0, 6)) !== view.getUint16(6) || length > 246) {
                this.reset(); this.onError(new Error('Invalid TinyFrame header')); continue;
            }
            const total = length ? length + 10 : 8;
            if (this.buffer.length < total) continue;
            const data = Uint8Array.from(this.buffer.slice(8, 8 + length));
            const trailer = length ? ((this.buffer[total - 2] << 8) | this.buffer[total - 1]) : 0;
            const id = view.getUint16(1), type = head[5];
            this.reset();
            if (length && crc16(data) !== trailer) { this.onError(new Error('Invalid TinyFrame payload CRC')); continue; }
            this.onFrame({id, type, data});
        }
    }
}
const rotate = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0;
function quarter(state, first, second, third, fourth) {
    state[first] = (state[first] + state[second]) >>> 0; state[fourth] = rotate(state[fourth] ^ state[first], 16);
    state[third] = (state[third] + state[fourth]) >>> 0; state[second] = rotate(state[second] ^ state[third], 12);
    state[first] = (state[first] + state[second]) >>> 0; state[fourth] = rotate(state[fourth] ^ state[first], 8);
    state[third] = (state[third] + state[fourth]) >>> 0; state[second] = rotate(state[second] ^ state[third], 7);
}
export function chacha20(input, key, nonce) {
    if (key.length !== 32 || nonce.length !== 12) throw new Error('ChaCha20 requires a 32-byte key and 12-byte nonce');
    const initial = new Uint32Array(16);
    initial.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
    const keyView = new DataView(key.buffer, key.byteOffset, key.byteLength);
    const nonceView = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
    for (let index = 0; index < 8; index++) initial[4 + index] = keyView.getUint32(index * 4, true);
    initial[12] = 1;
    for (let index = 0; index < 3; index++) initial[13 + index] = nonceView.getUint32(index * 4, true);
    const output = input.slice();
    for (let offset = 0; offset < output.length; offset += 64) {
        const state = initial.slice();
        for (let round = 0; round < 10; round++) {
            quarter(state, 0, 4, 8, 12); quarter(state, 1, 5, 9, 13); quarter(state, 2, 6, 10, 14); quarter(state, 3, 7, 11, 15);
            quarter(state, 0, 5, 10, 15); quarter(state, 1, 6, 11, 12); quarter(state, 2, 7, 8, 13); quarter(state, 3, 4, 9, 14);
        }
        const stream = new Uint8Array(64); const streamView = new DataView(stream.buffer);
        for (let index = 0; index < 16; index++) streamView.setUint32(index * 4, (state[index] + initial[index]) >>> 0, true);
        for (let index = 0; index < Math.min(64, output.length - offset); index++) output[offset + index] ^= stream[index];
        initial[12]++;
    }
    return output;
}
export function activationKey(raw) {
    if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('激活码寄存值必须是原始 32 字节 key；请在上位机选择“原始字节 HEX”并输入 64 个十六进制字符');
    return raw.slice();
}
function parseHex(text, label) {
    if (typeof text !== 'string' || text.length % 2 || !/^[0-9a-fA-F]*$/.test(text)) throw new Error(label + '不是有效 HEX');
    return Uint8Array.from((text.match(/../g) || []).map(byte => parseInt(byte, 16)));
}
export class HistoryReceiver {
    constructor() { this.abort(); }
    abort() { this.id = null; this.metadata = null; this.chunks = []; this.received = 0; this.total = 0; this.finished = false; }
    begin(id, payload) {
        if (this.id !== null || payload.length !== 24) throw new Error('Invalid history start');
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const historyCount = view.getUint16(2, true), recentCount = view.getUint16(4, true), total = view.getUint32(20, true);
        /* 上限必须与固件 TrendHistory.h 一致：长期 8640 点（5 分钟 × 30 天）、最近 1440 点（1 分钟 × 1 天） */
        if (payload[0] !== 1 || (payload[1] !== 1 && payload[1] !== 3) || historyCount > 8640 || recentCount > 1440 || total !== (historyCount + recentCount) * 4) throw new Error('Invalid history metadata');
        this.id = id; this.total = total;
        this.metadata = {historyCount, recentCount, simulated:!!(payload[1] & 2), historyStep:view.getUint32(8, true), recentStep:view.getUint32(12, true), effective:view.getUint32(16, true)};
    }
    data(id, payload) {
        if (id !== this.id || this.finished || payload.length < 20 || (payload.length - 16) % 4) throw new Error('Invalid history data');
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const offset = view.getUint32(0, true), length = payload.length - 16;
        const duplicate = this.chunks.find(chunk => chunk.offset === offset);
        if (duplicate) {
            if (duplicate.payload.length !== payload.length || !duplicate.payload.every((byte, index) => byte === payload[index])) throw new Error('Changed duplicate history frame');
            return;
        }
        if (offset !== this.received || this.received + length > this.total) throw new Error('Missing or out-of-order history frame');
        const nonce = payload.slice(4, 16);
        if (this.chunks.some(chunk => chunk.nonce.every((byte, index) => byte === nonce[index]))) throw new Error('Repeated encryption nonce');
        this.chunks.push({offset, nonce, ciphertext:payload.slice(16), payload:payload.slice()});
        this.received += length;
    }
    end(id, payload) {
        if (id !== this.id || payload.length !== 8 || this.finished || this.received !== this.total ||
            new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true) !== this.total) throw new Error('Incomplete history result');
        this.finished = true;
    }
    loadExport(document) {
        if (!document || document.version !== 1 || !document.metadata || !Array.isArray(document.chunks)) throw new Error('密文 JSON 格式错误');
        const metadata = document.metadata;
        const payload = new Uint8Array(24), view = new DataView(payload.buffer);
        payload[0] = 1; payload[1] = metadata.simulated ? 3 : 1;
        view.setUint16(2, metadata.historyCount, true); view.setUint16(4, metadata.recentCount, true);
        view.setUint32(8, metadata.historyStep, true); view.setUint32(12, metadata.recentStep, true);
        view.setUint32(16, metadata.effective, true); view.setUint32(20, document.total, true);
        this.begin(0, payload);
        for (const chunk of document.chunks) {
            const nonce = parseHex(chunk.nonce, 'nonce');
            const ciphertext = parseHex(chunk.ciphertext, 'ciphertext');
            if (!Number.isInteger(chunk.offset) || chunk.offset < 0 || chunk.offset > 0xffffffff || nonce.length !== 12 || ciphertext.length === 0 || ciphertext.length % 4) throw new Error('密文 JSON 分片格式错误');
            const frame = new Uint8Array(ciphertext.length + 16), frameView = new DataView(frame.buffer);
            frameView.setUint32(0, chunk.offset, true); frame.set(nonce, 4); frame.set(ciphertext, 16);
            this.data(0, frame);
        }
        const end = new Uint8Array(8); new DataView(end.buffer).setUint32(0, document.total, true); this.end(0, end);
    }
    get progress() { return this.finished ? 100 : this.total ? Math.min(99, Math.floor(this.received * 100 / this.total)) : 0; }
    decode(key) {
        if (!this.finished) throw new Error('History has not finished');
        const bytes = new Uint8Array(this.total);
        for (const chunk of this.chunks) bytes.set(chacha20(chunk.ciphertext, key, chunk.nonce), chunk.offset);
        const view = new DataView(bytes.buffer), points = [];
        for (let index = 0; index < bytes.length / 4; index++) {
            const temperature = view.getInt16(index * 4, true) / 10, humidity = view.getInt16(index * 4 + 2, true) / 10;
            if (temperature < -80 || temperature > 150 || humidity < 0 || humidity > 100) throw new Error('解密值超出合理范围，激活码可能错误；这不是密码学认证');
            const history = index < this.metadata.historyCount;
            const recentDuration = Math.max(0, this.metadata.recentCount - 1) * this.metadata.recentStep;
            const secondsAgo = history ? (this.metadata.historyCount - index) * this.metadata.historyStep + recentDuration : (this.metadata.recentCount - (index - this.metadata.historyCount) - 1) * this.metadata.recentStep;
            points.push({temperature, humidity, secondsAgo, density:history && this.metadata.historyStep !== this.metadata.recentStep ? 'compressed' : 'minute'});
        }
        return points;
    }
}
