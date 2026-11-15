export const TYPES = Object.freeze({info:1, readUser:2, writeUser:3, latest:4, reboot:5, activation:6, settingsRead:7, settingsWrite:8, windowRead:9, windowWrite:10, timeSync:11, importBegin:0x20, importData:0x21, importCommit:0x22, importCancel:0x23, imageBegin:0x40, imageData:0x41, imageCommit:0x42, imageCancel:0x43, imageSettingsRead:0x44, imageSettingsWrite:0x45, imagePreview:0x47, imageSelect:0x48, imageFull:0x49, imageProgress:0xc6, cancel:0x11, complete:0x12, error:0xff, historyStream:0x13, streamBegin:0x95, streamData:0x96, streamEnd:0x97});

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
/* Serialize complete frames across the chart and image clients sharing RX. */
function rxWriteState(characteristic) {
    const key = Symbol.for('thplot.rx.queues');
    const queues = globalThis[key] || (globalThis[key] = new WeakMap());
    if (!queues.has(characteristic)) queues.set(characteristic, {size:20, queue:Promise.resolve()});
    return queues.get(characteristic);
}
export function setRxWriteSize(characteristic, size) {
    if (!Number.isInteger(size) || size < 20 || size > 244) throw new Error('请升级设备固件后测试高速上传');
    rxWriteState(characteristic).size = size;
}
export function writeRxFrame(characteristic, frame, isCurrent = () => true) {
    const state = rxWriteState(characteristic);
    const job = state.queue.then(async () => {
        for (let offset = 0; offset < frame.length; offset += state.size) {
            if (!isCurrent()) throw new Error('蓝牙连接已变化');
            await characteristic.writeValueWithoutResponse(frame.slice(offset, offset + state.size));
        }
    });
    state.queue = job.catch(() => {});
    return job;
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
            if (crc16(head.subarray(0, 6)) !== view.getUint16(6) || length > 4096) {
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
        if (id !== this.id || this.finished || payload.length < 8 || (payload.length - 4) % 4) throw new Error('历史数据异常，请重新获取');
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const offset = view.getUint32(0, true), length = payload.length - 4;
        const duplicate = this.chunks.find(chunk => chunk.offset === offset);
        if (duplicate) {
            if (duplicate.payload.length !== payload.length || !duplicate.payload.every((byte, index) => byte === payload[index])) throw new Error('历史数据前后不一致，请重新获取');
            return;
        }
        if (offset !== this.received || this.received + length > this.total) throw new Error('历史数据不完整，请重新获取');
        /* 分片按偏移顺序拼接，点位统一以 0.1 单位编码。 */
        this.chunks.push({offset, bytes:payload.slice(4), payload:payload.slice()});
        this.received += length;
    }
    end(id, payload) {
        if (id !== this.id || payload.length !== 8 || this.finished || this.received !== this.total ||
            new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true) !== this.total) throw new Error('Incomplete history result');
        this.finished = true;
    }
    get progress() { return this.finished ? 100 : this.total ? Math.min(99, Math.floor(this.received * 100 / this.total)) : 0; }
    decode() {
        if (!this.finished) throw new Error('历史尚未接收完成');
        const bytes = new Uint8Array(this.total);
        for (const chunk of this.chunks) bytes.set(chunk.bytes, chunk.offset);
        const view = new DataView(bytes.buffer), points = [];
        for (let index = 0; index < bytes.length / 4; index++) {
            const temperature = view.getInt16(index * 4, true) / 10, humidity = view.getInt16(index * 4 + 2, true) / 10;
            if (temperature < -80 || temperature > 150 || humidity < 0 || humidity > 100) throw new Error('历史数据超出合理范围，请重新获取');
            const history = index < this.metadata.historyCount;
            const recentDuration = Math.max(0, this.metadata.recentCount - 1) * this.metadata.recentStep;
            const secondsAgo = history ? (this.metadata.historyCount - index) * this.metadata.historyStep + recentDuration : (this.metadata.recentCount - (index - this.metadata.historyCount) - 1) * this.metadata.recentStep;
            points.push({temperature, humidity, secondsAgo, density:history && this.metadata.historyStep !== this.metadata.recentStep ? 'compressed' : 'minute'});
        }
        return points;
    }
}
