export function historyImportChecksum(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return (~crc) >>> 0;
}
export function readHistoryCsv(text) {
    const lines = text.replace(/^\ufeff/, '').trim().split(/\r?\n/);
    const columns = lines.shift().split(',').map(value => value.trim());
    const relative = columns[0] === 'seconds_ago';
    if (!(relative ? columns[1] === 'temperature_c' && columns[2] === 'humidity_percent'
        : /^时间 \(UTC[+-]\d{2}:\d{2}\)$/.test(columns[0]) && columns[1] === '温度 (°C)' && columns[2] === '湿度 (%)'))
        throw new Error('CSV 列名不正确，请选择上位机导出的历史 CSV');
    let timezoneSeconds = 0;
    if (!relative) {
        const timezone = /UTC([+-])(\d{2}):(\d{2})/.exec(columns[0]);
        if (Number(timezone[2]) > 23 || Number(timezone[3]) > 59) throw new Error('CSV 时区错误');
        timezoneSeconds = (Number(timezone[2]) * 3600 + Number(timezone[3]) * 60) * (timezone[1] === '+' ? 1 : -1);
    }
    if (!lines.length || lines.length > 10080) throw new Error(lines.length ? '历史数据超过设备容量' : 'CSV 没有历史数据');
    const rows = lines.map((line, index) => {
        const values = line.split(',').map(value => value.trim());
        if (values.length !== columns.length || values.slice(0, 3).some(value => !value)) throw new Error('CSV 第 ' + (index + 2) + ' 行数据不完整');
        let time;
        if (relative) {
            const ago = Number(values[0]);
            if (!Number.isSafeInteger(ago) || ago < 0) throw new Error('CSV 时间错误');
            time = -ago;
        } else {
            const match = /^(\d{4})[/-](\d{2})[/-](\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(values[0]);
            if (!match) throw new Error('CSV 时间格式错误');
            const parts = match.slice(1).map(Number);
            const date = new Date(Date.UTC(parts[0], parts[1] - 1, ...parts.slice(2)));
            const actual = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()];
            if (actual.some((value, i) => value !== parts[i])) throw new Error('CSV 时间不存在');
            time = date.getTime() / 1000 - timezoneSeconds;
        }
        const temperature = Number(values[1]), humidity = Number(values[2]);
        if (!Number.isFinite(temperature) || temperature < -40 || temperature > 125) throw new Error('CSV 温度超出 -40～125 °C');
        if (!Number.isFinite(humidity) || humidity < 0 || humidity > 100) throw new Error('CSV 湿度超出 0～100 %');
        if (Math.abs(temperature * 10 - Math.round(temperature * 10)) > 1e-6 || Math.abs(humidity * 10 - Math.round(humidity * 10)) > 1e-6)
            throw new Error('CSV 精度应为 0.1，请勿导入更高精度的数据');
        return {time, temperature:Math.round(temperature * 10), humidity:Math.round(humidity * 10)};
    });
    const gaps = rows.slice(1).map((row, i) => row.time - rows[i].time);
    if (gaps.some(gap => gap !== 60 && gap !== 300)) throw new Error('CSV 时间间隔必须是连续的 1 分钟或 5 分钟，不能有缺点或倒序');
    const latest = relative ? 0 : rows[rows.length - 1].time;
    const simulatedColumn = columns.indexOf('contains_simulated_history');
    const simulated = simulatedColumn >= 0 && lines.some(line => line.split(',')[simulatedColumn].trim() === '1');
    return {capturedAt:relative ? Date.now() : latest * 1000, simulated,
        points:rows.map((row, index) => ({secondsAgo:latest - row.time, temperature:row.temperature / 10,
            humidity:row.humidity / 10, density:index < gaps.length && gaps[index] === 300 ? 'compressed' : 'minute'}))};
}
export function prepareHistoryImport(text, mode) {
    if (mode !== 0 && mode !== 1) throw new Error('请先读取设备历史颗粒度');
    const preview = readHistoryCsv(text), rows = preview.points;
    const gaps = rows.slice(1).map((row, i) => rows[i].secondsAgo - row.secondsAgo);
    let historyCount;
    if (mode === 1) {
        if (gaps.some(gap => gap !== 60)) throw new Error('设备是 7 天分钟颗粒度，CSV 必须全部为分钟点');
        historyCount = Math.max(0, rows.length - 1440);
    } else {
        const firstMinute = gaps.indexOf(60);
        historyCount = firstMinute < 0 ? gaps.length : firstMinute;
        if (gaps.slice(historyCount).some(gap => gap !== 60)) throw new Error('CSV 时间间隔顺序错误：较早区为 5 分钟，最近区为 1 分钟');
    }
    const recentCount = rows.length - historyCount;
    if (historyCount > 8640 || recentCount > 1440) throw new Error('CSV 超过当前颗粒度的历史容量，请检查设备模式');
    const bytes = new Uint8Array(rows.length * 4), view = new DataView(bytes.buffer);
    rows.forEach((row, i) => { view.setInt16(i * 4, Math.round(row.temperature * 10), true); view.setInt16(i * 4 + 2, Math.round(row.humidity * 10), true); });
    const begin = Uint8Array.of(1, mode, historyCount & 255, historyCount >>> 8, recentCount & 255, recentCount >>> 8);
    const commit = new Uint8Array(4); new DataView(commit.buffer).setUint32(0, historyImportChecksum(bytes), true);
    return {mode, historyCount, recentCount, total:rows.length, bytes, begin, commit};
}
export function historyImportChunk(prepared, offset) {
    if (!Number.isInteger(offset) || offset < 0 || offset >= prepared.total) throw new Error('导入位置错误');
    const count = Math.min(30, prepared.total - offset);
    const chunk = new Uint8Array(2 + count * 4);
    new DataView(chunk.buffer).setUint16(0, offset, true);
    chunk.set(prepared.bytes.subarray(offset * 4, (offset + count) * 4), 2);
    return chunk;
}
export async function uploadHistoryImport(prepared, send, callbacks) {
    let attempted = false, committed = false;
    const checkCancelled = () => { if (callbacks.isCancelled()) throw new Error('导入已取消'); };
    try {
        checkCancelled(); attempted = true;
        const begin = await send(0x20, prepared.begin);
        if (begin.length !== 1 || begin[0] !== 0) throw new Error('导入开始响应错误');
        callbacks.onBegin();
        for (let offset = 0; offset < prepared.total;) {
            checkCancelled();
            const chunk = historyImportChunk(prepared, offset);
            const next = offset + (chunk.length - 2) / 4;
            const ack = await send(0x21, chunk);
            if (ack.length !== 2 || new DataView(ack.buffer, ack.byteOffset, ack.byteLength).getUint16(0, true) !== next)
                throw new Error('设备导入进度不匹配');
            offset = next; callbacks.onProgress(offset);
        }
        checkCancelled(); callbacks.onCommit();
        const ack = await send(0x22, prepared.commit);
        if (ack.length !== 1 || ack[0] !== 0) throw new Error('导入完成响应错误');
        committed = true;
    } finally {
        if (attempted && !committed) { try { await send(0x23, new Uint8Array()); } catch {} }
    }
}
