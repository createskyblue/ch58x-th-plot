import {readHistoryCsv, prepareHistoryImport, uploadHistoryImport} from './history-import.mjs';
import {TYPES, encodeFrame, FrameParser, HistoryReceiver, activationKey, formatBuildStamp} from './protocol.mjs';

const element = id => document.getElementById(id);
const status = text => { element('status').textContent = text; };
const hex = bytes => [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const receiver = new HistoryReceiver();
let device, rx, tx, nextId = 0, sending = Promise.resolve(), rawUser = new Uint8Array(), points = [], exportId = null;
let lastProgress = 0, ending = false, rebooting = false;
let importJob = null;
let chartOrigin = null, previewSequence = 0, plottedSimulated = false;
const DEVICE_RANGE_LABELS = ['1 小时', '2 小时', '3 小时', '4 小时', '6 小时', '8 小时', '12 小时', '1 天', '3 天', '7 天', '15 天', '30 天'];
let rangeReady = false, rangeBusy = false;
let activated = false, settingsBusy = false, settingsReady = false, settingsError = '', savedSettings = [0, 0];
function settingsControls() {
    const rangeLocked = !rx || !activated || rangeBusy || settingsBusy || exportId !== null || !!importJob;
    element('read-device-range').disabled = rangeLocked;
    element('device-range').disabled = rangeLocked || !rangeReady;
    for (const id of ['history-mode', 'refresh-on-change', 'save-settings']) element(id).disabled = !rx || !activated || !settingsReady || settingsBusy || rangeBusy || exportId !== null || !!importJob;
    element('history-file').disabled = exportId !== null || !!importJob;
    element('import-history').disabled = !rx || !activated || !settingsReady || settingsBusy || rangeBusy || exportId !== null || !!importJob;
    element('cancel-import').disabled = !importJob || importJob.committing;
    for (const id of ['save-user', 'clear-user']) element(id).disabled = !rx || !!importJob || rangeBusy;
    element('history').disabled = !rx || exportId !== null || !!importJob || rangeBusy;
    element('reboot').disabled = !rx || exportId !== null || !!importJob || rangeBusy;
    element('settings-state').textContent = !activated ? '未激活' : settingsError ? '已激活，设置读取失败：' + settingsError : settingsReady ? '已激活' : '已激活，正在读取设置';
}
async function verifyActivation() {
    rangeReady = false; element('range-state').textContent = '连接并激活设备后可读取。';
    activated = false; settingsReady = false; settingsError = ''; settingsControls();
    const data = await request(TYPES.activation);
    if (data.length !== 1 || data[0] > 1) throw new Error('激活校验响应错误');
    activated = data[0] === 1;
    if (activated) {
        try { await readSettings(); }
        catch (error) {
            if (!rx || !device?.gatt?.connected) throw error;
            /* A settings error is reported by the card while the link remains usable. */
        }
    }
    if (activated) {
        try { await readDeviceRange(); }
        catch (error) { if (!rx || !device?.gatt?.connected) throw error; }
    }
    settingsControls();
}
async function readSettings() {
    settingsReady = false; settingsError = ''; settingsControls();
    try {
        const data = await request(TYPES.settingsRead);
        if (data.length !== 2 || data[0] > 1 || data[1] > 1) throw new Error('设置响应错误');
        savedSettings = [...data]; element('history-mode').value = String(data[0]); element('refresh-on-change').checked = !!data[1];
        settingsReady = true;
    } catch (error) { settingsError = error.message; throw error; }
    finally { settingsControls(); }
}
const pending = new Map();
const deviceButtons = ['latest', 'save-user', 'read-user', 'clear-user', 'history', 'disconnect', 'reboot'];
function connected(enabled) { for (const name of deviceButtons) element(name).disabled = !enabled; element('connect').disabled = enabled; settingsControls(); }
function renderProgress() {
    const progress = ending ? Math.min(99, receiver.progress) : receiver.progress;
    element('progress').value = progress; element('percentage').textContent = progress + '%';
    element('transfer-detail').textContent = receiver.received + ' / ' + receiver.total + ' 有效历史字节 · 协议头与 nonce 不计入进度';
}
function rejectPending(reason) {
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(reason); }
    pending.clear();
}
function disconnected() {
    rangeReady = false; rangeBusy = false; element('range-state').textContent = '连接并激活设备后可读取。';
    device?.removeEventListener('gattserverdisconnected', disconnected);
    tx?.removeEventListener('characteristicvaluechanged', notificationReceived);
    rejectPending(new Error('蓝牙连接已断开'));
    /* 重启是我们自己要求的断连，提示要把用户下一步该做什么说清楚 */
    const afterReboot = rebooting;
    rebooting = false;
    rx = tx = null; sending = Promise.resolve();
    if (importJob) importJob.cancelled = true;
    activated = false; settingsControls();
    parser.reset();
    if (exportId !== null) abortHistory('连接断开，本次结果已丢弃；请从头获取');
    connected(false); element('connection').textContent = '未连接'; element('build-stamp').textContent = '—';
    status(afterReboot ? '设备已重启，蓝牙已关闭；长按设备按键重新打开蓝牙窗口后即可再次连接' : '连接已断开');
}
function notificationReceived(event) {
    parser.accept(new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength));
}
function write(id, type, data = new Uint8Array()) {
    const frame = encodeFrame(id, type, data);
    const characteristic = rx;
    const job = sending.then(async () => {
        if (!characteristic || characteristic !== rx) throw new Error('设备未连接');
        for (let offset = 0; offset < frame.length; offset += 20)
            await characteristic.writeValueWithResponse(frame.slice(offset, offset + 20));
    });
    sending = job.catch(() => {});
    return job;
}
function allocateId() { const id = 0x8000 | nextId; nextId = (nextId + 1) & 0x7fff; return id; }
function request(type, data = new Uint8Array()) {
    const id = allocateId();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('指令超时')); }, 5000);
        pending.set(id, {resolve, reject, timer, type});
        write(id, type, data).catch(error => { clearTimeout(timer); pending.delete(id); reject(error); });
    });
}
const errors = {1:'请求格式错误', 2:'设备忙，请稍后重试', 3:'设备密钥派生或 UID 不可用，历史导出已拒绝（不会返回明文）', 4:'传感器或 Flash 操作失败', 5:'设备操作超时', 6:'设备未激活，无法修改设置'};
const parser = new FrameParser(onFrame, error => { if (exportId !== null) abortHistory(error.message); else status(error.message); });
function onFrame(message) {
    const operation = pending.get(message.id);
    if (operation) {
        clearTimeout(operation.timer); pending.delete(message.id);
        if (message.type === TYPES.error) { if (message.data[0] === 6) { activated = false; settingsControls(); } operation.reject(new Error(errors[message.data[0]] || '设备返回错误')); }
        else if (message.type !== (operation.type === TYPES.cancel || operation.type === TYPES.complete ? operation.type + 0x82 : operation.type + 0x80)) operation.reject(new Error('指令响应类型不匹配'));
        else operation.resolve(message.data);
        return;
    }
    if (message.id !== exportId) return;
    try {
        if (message.type === TYPES.error) throw new Error(errors[message.data[0]] || '历史导出失败');
        if (message.type === TYPES.begin) { receiver.begin(message.id, message.data); lastProgress = Date.now(); element('transfer-status').textContent = receiver.metadata.simulated ? '正在接收全部历史（含模拟预填数据）' : '正在接收全部历史'; }
        else if (message.type === TYPES.data) { const before = receiver.received; receiver.data(message.id, message.data); if (receiver.received !== before) lastProgress = Date.now(); }
        else if (message.type === TYPES.end) {
            receiver.end(message.id, message.data); ending = true; renderProgress(); finishHistory().catch(error => abortHistory(error.message));
        } else throw new Error('意外的历史响应类型');
        renderProgress();
    } catch (error) { abortHistory(error.message); }
}
async function finishHistory() {
    const id = exportId;
    const payload = Uint8Array.of(id & 255, id >>> 8);
    await request(TYPES.complete, payload);
    if (exportId !== id) return;
    ending = false; exportId = null; element('cancel').disabled = true; element('history').disabled = !rx;
    settingsControls();
    renderProgress(); element('transfer-status').textContent = receiver.metadata.simulated ? '传输完整，设备已恢复历史写入（含模拟预填数据）' : '传输完整，设备已恢复历史写入';
    element('encrypted').disabled = false; element('decrypt').disabled = false;
    try { decodeHistory(); } catch (error) { status('传输已完成；' + error.message); }
}
function abortHistory(reason) {
    const oldId = exportId;
    exportId = null; ending = false; receiver.abort(); points = []; drawChart(); renderProgress();
    chartOrigin = null; element('chart-source').textContent = '尚无历史数据';
    settingsControls();
    element('transfer-status').textContent = '传输未完成'; element('transfer-detail').textContent = reason;
    element('cancel').disabled = true; element('history').disabled = !rx;
    element('encrypted').disabled = element('decrypt').disabled = true;
    if (oldId !== null && rx) request(TYPES.cancel, Uint8Array.of(oldId & 255, oldId >>> 8)).catch(() => {});
    status(reason);
}
function rawEditor() {
    const text = element('user-data').value;
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(text)) throw new Error('原始 HEX 必须由完整双字符字节组成，不自动去除空白');
    return Uint8Array.from((text.match(/../g) || []).map(byte => parseInt(byte, 16)));
}
function showUser() {
    element('encoding').value = 'hex';
    element('user-data').value = hex(rawUser);
    element('user-size').textContent = rawUser.length + ' / 64 字节';
}
async function readUser() {
    const data = await request(TYPES.readUser);
    if (!data.length || data[0] > 64 || data.length !== data[0] + 1) throw new Error('寄存数据长度错误');
    rawUser = data.slice(1); showUser();
}
function decodeHistory() {
    const decoded = receiver.decode(activationKey(rawEditor()));
    points = decoded; chartOrigin = 'device'; plottedSimulated = receiver.metadata.simulated;
    element('chart-source').textContent = '设备历史 · ' + points.length + ' 个点'; drawChart(); element('csv').disabled = false;
    status('已在本地解密 ' + points.length + ' 点；格式检查通过不代表数据已认证');
}
function download(name, data, type) {
    const blob = new Blob([data], {type}); const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function drawChart() {
    const canvas = element('chart'), context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#60756e'; context.font = '14px sans-serif';
    if (!points.length) { context.fillText('完成全量接收与本地解密后显示曲线', 28, 42); return; }
    const left = 62, right = canvas.width - 50, top = 24, bottom = 270;
    const duration = Math.max(1, points[0].secondsAgo);
    const temperatures = points.map(point => point.temperature);
    const low = Math.floor(Math.min(...temperatures) - 1), high = Math.ceil(Math.max(...temperatures) + 1);
    context.strokeStyle = '#e2eae5'; context.lineWidth = 1;
    for (let tick = 0; tick <= 4; tick++) {
        const vertical = top + tick * (bottom - top) / 4;
        context.beginPath(); context.moveTo(left, vertical); context.lineTo(right, vertical); context.stroke();
        context.fillStyle = '#60756e'; context.fillText((high - tick * (high - low) / 4).toFixed(1), 10, vertical + 5);
        context.fillText((100 - tick * 25).toString(), right + 10, vertical + 5);
        const seconds = duration * (1 - tick / 4);
        const label = seconds >= 86400 ? (seconds / 86400).toFixed(1) + 'd' : seconds >= 3600 ? (seconds / 3600).toFixed(1) + 'h' : (seconds / 60).toFixed(1) + 'm';
        context.fillText(label, left + tick * (right - left) / 4 - 14, bottom + 28);
    }
    for (const [field, color, minimum, maximum] of [['temperature', '#d07c46', low, high], ['humidity', '#458eac', 0, 100]]) {
        context.strokeStyle = color; context.lineWidth = 2; context.beginPath();
        points.forEach((point, index) => {
            const horizontal = right - point.secondsAgo / duration * (right - left);
            const vertical = bottom - (point[field] - minimum) / (maximum - minimum) * (bottom - top);
            if (index === 0) context.moveTo(horizontal, vertical); else context.lineTo(horizontal, vertical);
        }); context.stroke();
    }
}
function action(id, handler, event = 'click') { element(id).addEventListener(event, async () => { try { await handler(); } catch (error) { status(error.message); } }); }
action('connect', async () => {
    if (!navigator.bluetooth || !isSecureContext) throw new Error('请在支持 Web Bluetooth 的浏览器中通过 localhost / HTTPS 打开');
    device = await navigator.bluetooth.requestDevice({filters:[{services:[0xffe0]}]});
    device.addEventListener('gattserverdisconnected', disconnected);
    let stage = '建立 GATT 连接';
    try {
        const server = await device.gatt.connect();
        stage = '发现 FFE0 服务';
        const service = await server.getPrimaryService(0xffe0);
        stage = '发现 FFE1 写入特征'; rx = await service.getCharacteristic(0xffe1);
        stage = '发现 FFE4 通知特征'; tx = await service.getCharacteristic(0xffe4);
        parser.reset();
        tx.addEventListener('characteristicvaluechanged', notificationReceived);
        stage = '订阅 FFE4 通知'; await tx.startNotifications();
        stage = '读取系统信息';
        const info = await request(TYPES.info);
        /* 固件 v1 只发 32 字节，新固件在后面追加 20 字节编译时间戳；两种长度都要认 */
        if ((info.length !== 32 && info.length !== 52) || info[0] !== 1) throw new Error('不支持的设备协议版本');
        const view = new DataView(info.buffer, info.byteOffset, info.byteLength);
        element('uid').textContent = info[1] ? hex(info.slice(4, 12)) : '硬件 UID 不可用';
        element('build-stamp').textContent = info.length === 52 ? formatBuildStamp(info.slice(32, 52)) : '固件未上报';
        element('sensor').textContent = ['未检测', 'AHT20', 'SHT40'][info[3]] || '未知';
        element('uptime').textContent = Math.floor(view.getUint32(24, true) / 1000) + ' 秒';
        element('simulation').textContent = info[31] & 1 ? '模拟预填：历史含假数据；立即读取仍为真实测量' : '真实采样';
        stage = '读取寄存值';
        await readUser();
        stage = '校验设备激活状态'; await verifyActivation();
        connected(true); element('connection').textContent = '已连接'; element('device-name').textContent = device.name || 'TH-Plot';
        /* 连上就自动读一次当前温湿度，省得用户再点一下。
           温湿度读不出来不算连接失败：链路是好的，不该因为一次采样把连接断掉。 */
        status('已连接，正在读取当前温湿度…');
        let latestError = '';
        try { await refreshLatest(); } catch (error) { latestError = error.message; }
        const derivation = info[30] === 2 ? '；设备使用公开 UID 测试派生，请在独立 keygen 页面生成激活码'
            : info[30] === 1 ? '；设备使用私有派生器' : '；设备未启用密钥派生器';
        status((latestError ? '已连接，但读取当前温湿度失败：' + latestError
            : '已连接，已读取当前温湿度' + derivation) + (settingsError ? '；设备设置读取失败：' + settingsError : ''));
    } catch (error) {
        device.removeEventListener('gattserverdisconnected', disconnected);
        device.gatt.disconnect();
        disconnected();
        throw new Error('连接/初始化失败（' + stage + '）：' + error.message);
    }
});
action('disconnect', () => device?.gatt.disconnect());
/* 重启要人在旁边按一下 BOOT 才能重新连上，所以先弹窗确认再发，不能点一下就复位。 */
function closeRebootDialog() {
    const dialog = element('reboot-dialog');
    if (!dialog.open) return;
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
}
action('reboot', () => {
    const dialog = element('reboot-dialog');
    if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
});
element('reboot-cancel').addEventListener('click', closeRebootDialog);
element('reboot-confirm').addEventListener('click', async () => {
    closeRebootDialog();
    if (!rx || rebooting) return;
    rebooting = true;
    element('reboot').disabled = true;
    status('已发送重启指令，等待设备复位…');
    try {
        await request(TYPES.reboot);
    } catch (error) {
        /* 设备真的复位时会先触发 disconnected 把 rebooting 清掉，这里的失败就不用再报一遍 */
        if (!rebooting) return;
        rebooting = false;
        element('reboot').disabled = !rx;
        status(error.message);
    }
});
/* 读一次即时温湿度并写回卡片。不设 status：调用方自己决定怎么说，
   连接后自动读和用户点「立即读取」的文案不一样。 */
async function refreshLatest() {
    const data = await request(TYPES.latest);
    if (data.length !== 9 || data[0]) throw new Error('即时测量失败，原显示未更新');
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    element('temperature').textContent = (view.getInt16(1, true) / 10).toFixed(1) + ' °C';
    element('humidity').textContent = (view.getInt16(3, true) / 10).toFixed(1) + ' %';
    element('measured').textContent = '设备运行 ' + (view.getUint32(5, true) / 1000).toFixed(1) + ' 秒时测量，不是墙钟时间';
}
action('latest', async () => {
    status('正在进行即时传感器测量…');
    await refreshLatest();
    status('即时测量已更新');
});
action('read-user', async () => { await readUser(); status('已原样读取寄存值'); });
action('save-user', async () => {
    if (importJob) return;
    const bytes = rawEditor(); if (bytes.length > 64) throw new Error('寄存值超过 64 字节，不会截断');
    activated = false; settingsControls();
    await request(TYPES.writeUser, bytes); await readUser();
    await verifyActivation();
    if (hex(rawUser) !== hex(bytes)) throw new Error('写入后的回读不一致');
    status('寄存值已写入并回读验证' + (settingsError ? '；设备设置读取失败：' + settingsError : ''));
});
action('clear-user', async () => { if (importJob) return; await request(TYPES.writeUser); await readUser(); await verifyActivation(); status('寄存值已清空'); });
async function readDeviceRange() {
    const link = rx;
    rangeReady = false; rangeBusy = true;
    element('range-state').textContent = '正在读取当前范围…'; settingsControls();
    try {
        const data = await request(TYPES.windowRead);
        if (rx !== link) throw new Error('蓝牙连接已变化');
        if (data.length !== 1 || data[0] >= DEVICE_RANGE_LABELS.length) throw new Error('时间范围响应错误');
        element('device-range').value = String(data[0]);
        element('range-state').textContent = '当前：' + DEVICE_RANGE_LABELS[data[0]];
        rangeReady = true;
    } catch (error) {
        element('range-state').textContent = rx ? '读取失败：' + error.message : '连接并激活设备后可读取。';
        throw error;
    } finally { rangeBusy = false; settingsControls(); }
}
action('read-device-range', async () => {
    if (!rx || !activated || rangeBusy || settingsBusy || importJob || exportId !== null) return;
    await readDeviceRange(); status('已读取设备当前时间范围');
});
action('device-range', async () => {
    if (!rx || !activated || !rangeReady || rangeBusy || settingsBusy || importJob || exportId !== null) return;
    const index = Number(element('device-range').value);
    if (!Number.isInteger(index) || index < 0 || index >= DEVICE_RANGE_LABELS.length) throw new Error('请选择有效的时间范围');
    rangeBusy = true; settingsControls();
    try {
        const ack = await request(TYPES.windowWrite, Uint8Array.of(index));
        if (ack.length !== 1 || ack[0] !== 0) throw new Error('时间范围设置响应错误');
        await readDeviceRange();
        status('设备已切换时间范围，屏幕将刷新');
    } catch (error) {
        rangeReady = false;
        element('range-state').textContent = rx ? '切换未确认，请重新读取当前范围。' : '连接并激活设备后可读取。';
        throw error;
    } finally { rangeBusy = false; settingsControls(); }
}, 'change');
action('save-settings', async () => {
    if (!activated || !settingsReady || settingsBusy || rangeBusy || exportId !== null || importJob || !rx) return;
    const mode = Number(element('history-mode').value), immediate = element('refresh-on-change').checked ? 1 : 0;
    if (mode !== savedSettings[0] && !confirm('切换历史颗粒度会清空设备已有历史，建议先导出。继续切换？')) return;
    if (immediate && !savedSettings[1] && !confirm('开启温湿度变化立即刷新会降低续航时间，尤其空调造成的周期性温度变化可能导致频繁刷新。仍然开启？')) return;
    settingsBusy = true; settingsControls();
    try { await request(TYPES.settingsWrite, Uint8Array.of(mode, immediate)); await readSettings(); status('设备设置已保存'); }
    finally { settingsBusy = false; settingsControls(); }
});
settingsControls();
element('encoding').addEventListener('change', showUser);
function showLocalPreview(preview, file) {
    points = preview.points;
    chartOrigin = 'local'; plottedSimulated = preview.simulated;
    element('chart-source').textContent = '本地文件预览 · ' + (file.name || 'CSV') + ' · ' + points.length + ' 个点';
    drawChart();
    element('csv').disabled = false;
}
function clearLocalPreview() {
    if (chartOrigin !== 'local') return;
    points = [];
    chartOrigin = null; plottedSimulated = false;
    element('chart-source').textContent = '尚无历史数据'; element('csv').disabled = true;
    drawChart();
}
element('history-file').addEventListener('change', async () => {
    const sequence = ++previewSequence, file = element('history-file').files?.[0];
    if (importJob || exportId !== null) return;
    clearLocalPreview();
    element('import-progress').hidden = true;
    if (!file) { element('import-status').textContent = '选择 CSV 可在本地预览；导入设备需连接并激活。'; return; }
    element('import-status').textContent = '正在读取 CSV…';
    try {
        if (file.size > 2 * 1024 * 1024) throw new Error('CSV 文件过大');
        const preview = readHistoryCsv(await file.text());
        if (sequence !== previewSequence || element('history-file').files?.[0] !== file || importJob || exportId !== null) return;
        showLocalPreview(preview, file);
        element('import-status').textContent = '已预览 ' + preview.points.length + ' 个点；尚未写入设备。导入时会校验设备颗粒度。';
    } catch (error) {
        if (sequence !== previewSequence || element('history-file').files?.[0] !== file || importJob || exportId !== null) return;
        element('import-status').textContent = error.message;
    }
});
action('cancel-import', () => { if (importJob && !importJob.committing) { importJob.cancelled = true; element('import-status').textContent = '正在取消导入…'; } });
action('import-history', async () => {
    if (!rx || !activated || !settingsReady || settingsBusy || rangeBusy || exportId !== null || importJob) return;
    const file = element('history-file').files?.[0];
    if (!file) throw new Error('请先选择历史 CSV');
    if (file.size > 2 * 1024 * 1024) throw new Error('CSV 文件过大');
    ++previewSequence;
    const job = {link:rx, cancelled:false, committing:false}; importJob = job; settingsControls();
    const send = (type, data) => { if (rx !== job.link) return Promise.reject(new Error('蓝牙连接已变化')); return request(type, data); };
    try {
        await readSettings();
        const text = await file.text();
        if (job.cancelled || rx !== job.link) throw new Error('导入已取消');
        showLocalPreview(readHistoryCsv(text), file);
        const prepared = prepareHistoryImport(text, savedSettings[0]);
        if (job.cancelled) throw new Error('导入已取消');
        if (!confirm('将用 CSV 中的 ' + prepared.total + ' 个点替换设备全部历史。取消或中断导入后历史会清空，建议先导出备份。继续导入？')) {
            element('import-status').textContent = '已取消，设备历史未修改'; return;
        }
        element('import-progress').hidden = false; element('import-progress').value = 0;
        await uploadHistoryImport(prepared, send, {
            isCancelled:() => job.cancelled,
            onBegin:() => { receiver.abort(); },
            onProgress:offset => { element('import-progress').value = Math.floor(offset * 100 / prepared.total); element('import-status').textContent = '正在导入 ' + offset + ' / ' + prepared.total + ' 个点'; },
            onCommit:() => { job.committing = true; settingsControls(); element('import-status').textContent = '正在确认导入结果…'; }
        });
        element('import-status').textContent = '已导入 ' + prepared.total + ' 个点，设备将刷新当前时间范围';
        status('历史导入完成');
    } catch (error) { element('import-status').textContent = error.message; throw error; }
    finally { if (importJob === job) { importJob = null; settingsControls(); } }
});
action('history', async () => {
    if (importJob) return;
    ++previewSequence; chartOrigin = null; element('chart-source').textContent = '正在获取设备历史…';
    receiver.abort(); points = []; drawChart(); element('csv').disabled = true; exportId = allocateId(); lastProgress = Date.now(); ending = false;
    settingsControls();
    element('cancel').disabled = false; element('history').disabled = true;
    element('encrypted').disabled = element('decrypt').disabled = true;
    element('transfer-status').textContent = '等待设备冻结历史并开始导出'; renderProgress();
    try { await write(exportId, TYPES.history); } catch (error) { abortHistory(error.message); }
});
action('cancel', () => abortHistory('用户取消，本次未完成结果已丢弃'));
action('decrypt', decodeHistory);
action('encrypted', () => download('th-plot-encrypted.json', JSON.stringify({version:1, metadata:receiver.metadata, total:receiver.total, chunks:receiver.chunks.map(chunk => ({offset:chunk.offset, nonce:hex(chunk.nonce), ciphertext:hex(chunk.ciphertext)})), authenticated:false}, null, 2), 'application/json'));
action('csv', () => download('th-plot-history.csv', '\ufeffseconds_ago,temperature_c,humidity_percent,density,contains_simulated_history\n' + points.map(point => [point.secondsAgo, point.temperature.toFixed(1), point.humidity.toFixed(1), point.density, plottedSimulated ? 1 : 0].join(',')).join('\n'), 'text/csv;charset=utf-8'));
async function importEncrypted() {
    if (exportId !== null) throw new Error('历史传输进行中，完成或取消后再导入密文');
    const file = element('import-encrypted').files?.[0];
    if (!file) throw new Error('请先选择已保存的密文 JSON');
    const document = JSON.parse(await file.text());
    receiver.loadExport(document); points = []; drawChart(); renderProgress();
    ++previewSequence; chartOrigin = null; element('chart-source').textContent = '密文历史尚未解密';
    element('transfer-status').textContent = receiver.metadata.simulated ? '密文已导入（含模拟预填数据）' : '密文已导入';
    element('encrypted').disabled = false; element('decrypt').disabled = false; element('csv').disabled = true;
    status('密文已导入；请输入原始字节 HEX 激活码后点击“本地解密”');
}
element('import-encrypted').addEventListener('change', async () => { try { await importEncrypted(); } catch (error) { status(error.message); } });
/* 帧间超时：连续 3 秒没有“成功进账一帧”才判卡死，每帧重置，不设整体时长上限。
   与固件 HISTORY_STALL_TIMEOUT_MS 和 web/index.html 保持一致。 */
setInterval(() => { if (exportId !== null && Date.now() - lastProgress >= 3000) abortHistory('传输超时，本次结果已丢弃；请从头获取'); }, 250);
drawChart();
