import {TYPES, encodeFrame, FrameParser, writeRxFrame, setRxWriteSize} from './protocol.js';
import {IMAGE_WIDTH, IMAGE_HEIGHT, IMAGE_BYTES, ditherPixels, monoToRgba, prepareMonochromeRgba} from './image-dither.js?v=transparent-alpha-preset-fix';
import {lz4CompressBlock} from './lz4.js';
import {uploadImageBytes} from './image-transfer.js';
import {CanvasEditor} from './canvas-editor.js?v=project-idb5';
import localforage from './vendor/localforage.js?v=project-idb5';

const element = id => document.getElementById(id);
const status = text => { element('image-status').textContent = text; };
const uploadState = text => { element('image-upload-state').textContent = text; };
const setProgress = value => { element('image-progress-bar').style.width = Math.max(0, Math.min(100, value)) + '%'; };
const syncParameterLabels = () => {
  for (const name of ['threshold', 'contrast', 'brightness', 'gamma', 'sharpness'])
    element(`image-${name}-value`).value = element(`image-${name}`).value;
};
/* 工程里带着图片数据，localStorage 只有 5 MB，一张手机照片就能顶满。
   所以工程一律存 IndexedDB（localForage 默认驱动），localStorage 只留旧版本迁移。 */
const projectStore = localforage.createInstance({name:'thplot', storeName:'projects'});
const projectKey = slot => 'project.' + slot;
let suppressSave = false;

/* 编辑时 onChange 触发得很密，保存按顺序排队，避免旧快照晚到把新快照盖掉。 */
let saveQueue = Promise.resolve();
function saveProject(slot = selectedSlot) {
  /* 先固定槽位号：await 期间如果用户切了槽，不能把旧画布写进新槽。 */
  const target = slot;
  saveQueue = saveQueue.then(async () => {
    if (!editor) return;
    await projectStore.setItem(projectKey(target), await editor.exportProject());
  }).catch(error => { status('保存工程失败：' + error.message); });
  return saveQueue;
}

/* 旧版本把工程压在 localStorage，图片一大就写不进去，保存直接报超配额。
   打开页面时把旧记录搬进 IndexedDB，再把 localStorage 让出来。
   槽位自己的记录优先，旧的单份工程最后处理，只有槽 1 空着才落进去。 */
async function migrateLegacyProjects() {
  const entries = [];
  for (let slot = 0; slot < SLOT_COUNT; slot++) entries.push(['thplot.canvas.project.' + slot, slot]);
  entries.push(['thplot.canvas.project', 0]);
  for (const [key, slot] of entries) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { continue; }
    if (!raw) continue;
    try {
      const project = JSON.parse(raw);
      if (!(await projectStore.getItem(projectKey(slot))))
        await projectStore.setItem(projectKey(slot), project);
    } catch {}
    try { localStorage.removeItem(key); } catch {}
  }
}

async function loadSlotProject(slot) {
  /* 加载期间 editor.clear()/import 会触发 onChange，必须先压住自动保存，
     否则空画布会把刚切过去的那份工程覆盖掉。 */
  suppressSave = true;
  try {
    const saved = await projectStore.getItem(projectKey(slot));
    editor.clear();
    if (saved) {
      try { await editor.importProject(saved); }
      catch { await projectStore.removeItem(projectKey(slot)); }
    }
  } finally { suppressSave = false; }
  renderPreview();
  controls();
}

let device, rx, tx;
let nextId = 0;
let sending = Promise.resolve();
let connected = false;
let activated = false;
let imageEnabled = false;
let uploading = false;
let uploadCancelled = false, committing = false;
let uploadToken = 0;
let deviceProgress = null;
let editor;
let restoreProjectPromise = Promise.resolve();
let loadSequence = 0;
let importQueue = Promise.resolve(), importsPending = 0;
let bits = null;
let selectedSlot = 0;
let readingPreviews = false;
let renderingPreview = false;
let previewScheduled = false;
let invert = false;
const commonBrowserFonts=['sans-serif','serif','monospace','Arial','Georgia','Times New Roman','Courier New'];
const pending = new Map();

const parser = new FrameParser(message => {
  if (message.type === TYPES.imageProgress) {
    const progress = deviceProgress;
    if (!uploading || uploadCancelled || !progress || message.id !== progress.id || message.data.length !== 4) return;
    const received = new DataView(message.data.buffer, message.data.byteOffset, 4).getUint32(0, true);
    if (received < progress.received || received > progress.total) return;
    progress.received = received;
    setProgress(Math.min(99, Math.floor(received * 100 / progress.total)));
    uploadState(received === progress.total ? '正在校验并保存…' :
      '设备已接收 ' + received + ' / ' + progress.total + ' 字节');
    return;
  }
  const job = pending.get(message.id);
  if (!job) return;
  if (message.type === TYPES.error) {
    const code = message.data[0];
    const labels = ['', '设备暂时没法处理，请稍后重试', '设备正忙，请稍等再试', '这个功能设备不支持', '存储操作没成功，请重试', '等太久了，请再试一次', '设备未激活'];
    pending.delete(message.id);
    clearTimeout(job.timer);
    job.reject(new Error(labels[code] || ('设备错误 ' + code)));
    return;
  }
  pending.delete(message.id);
  clearTimeout(job.timer);
  if (message.type !== job.type + 0x80) {
    job.reject(new Error('设备响应类型不匹配'));
    return;
  }
  job.resolve(message.data);
});

function settlePending(error) {
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.reject(error);
  }
  pending.clear();
}

function sendBytes(frame) {
  const characteristic = rx;
  const job = sending.then(async () => {
    if (!characteristic || characteristic !== rx) throw new Error('设备未连接');
    await writeRxFrame(characteristic, frame, () => characteristic === rx);
  });
  sending = job.catch(() => {});
  return job;
}

function request(type, payload = new Uint8Array(), timeout = 6000) {
  if (!connected || !rx || !tx) return Promise.reject(new Error('请先连接设备'));
  const id = 0x8000 | nextId;
  nextId = (nextId + 1) & 0x7fff;
  if (type === TYPES.imageBegin && deviceProgress) deviceProgress.id = id;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('设备响应超时'));
    }, timeout);
    pending.set(id, {resolve, reject, timer, type});
    sendBytes(encodeFrame(id, type, payload)).catch(error => {
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
}

function setConnected(value) {
  connected = value;
  element('image-connect').disabled = value;
  element('image-disconnect').disabled = !value;
  controls();
}

function controls() {
  const canImage = connected && !uploading;
  element('image-image-enabled').disabled = !connected || uploading;
  element('image-upload').disabled = !canImage || !bits || importsPending > 0;
  element('image-cancel').disabled = !uploading || uploadCancelled || committing;
  /* 进度条只在上传时出现，空闲时不占位置。 */
  element('image-progress').hidden = !uploading;
  element('image-read-previews').disabled = !connected || uploading || readingPreviews;
  /* 按钮灰着必须告诉用户为什么，否则只会以为功能坏了 */
  const readHint = element('image-read-hint');
  if (readHint) readHint.textContent = !connected ? '未连接设备，点顶部「连接设备」'
    : readingPreviews ? '正在读取三个槽位…'
    : uploading ? '上传中，暂不可读取' : '回传 80×60 缩略图';
  element('image-read-previews').title = connected ? '读取设备上三个槽位的缩略图'
    : '请先点顶部「连接设备」';
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const full = element(`image-slot-full-${slot}`);
    if (full) full.disabled = !connected || uploading || readingPreviews;
  }
  if (editor && editor.locked !== uploading) editor.setLocked(uploading);
  for (const id of ['image-file','image-add-text','image-add-qr','image-clear','image-invert','image-preset'])
    element(id).disabled = uploading;
  syncEditorControls();
  for (const id of ['image-dither-mode', 'image-threshold', 'image-contrast', 'image-brightness', 'image-gamma', 'image-sharpness'])
    element(id).disabled = uploading;
}

async function readActivation() {
  const data = await request(TYPES.activation);
  activated = data.length === 1 && data[0] === 1;
  controls();
}

async function readImageEnabled() {
  try {
    const data = await request(TYPES.imageSettingsRead);
    imageEnabled = data.length >= 1 && data[0] === 1;
    element('image-image-enabled').checked = imageEnabled;
    element('image-image-state').textContent = imageEnabled ? '壁纸页已开启' : '壁纸页未开启';
  } catch (error) {
    element('image-image-state').textContent = error.message;
  }
}

async function connect() {
  if (!navigator.bluetooth || !isSecureContext)
    throw new Error('请在支持 Web Bluetooth 的浏览器中通过 localhost / HTTPS 打开');
  element('image-connect').disabled = true;
  status('正在建立 GATT 连接…');
  device = await navigator.bluetooth.requestDevice({filters: [{services: [0xffe0]}]});
  device.addEventListener('gattserverdisconnected', disconnected);
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(0xffe0);
  rx = await service.getCharacteristic(0xffe1);
  tx = await service.getCharacteristic(0xffe4);
  parser.reset();
  tx.addEventListener('characteristicvaluechanged', event => {
    parser.accept(new Uint8Array(event.target.value.buffer, event.target.value.byteOffset,
      event.target.value.byteLength));
  });
  await tx.startNotifications();
  setConnected(true);
  status('已连接');
  readActivation().catch(() => {});
  await readImageEnabled();
}

function disconnected() {
  device?.removeEventListener('gattserverdisconnected', disconnected);
  device = null;
  rx = tx = null;
  settlePending(new Error('蓝牙连接已断开'));
  uploading = false;
  uploadToken++;
  deviceProgress = null;
  setConnected(false);
  status('连接已断开。');
  uploadState('');
  setProgress(0);
}

function renderPreview() {
  if (renderingPreview) return;
  renderingPreview = true;
  if (!editor?.objects.length) {
    bits = null;
    element('image-preview').getContext('2d').clearRect(0,0,IMAGE_WIDTH,IMAGE_HEIGHT);
    element('image-compression-state').textContent = '添加图片或文本框开始编辑。';
    controls();
    renderingPreview = false;
    return;
  }
  const work = document.createElement('canvas');
  work.width = IMAGE_WIDTH;
  work.height = IMAGE_HEIGHT;
  const context = work.getContext('2d', {willReadFrequently: true});
  context.fillStyle='#fff';context.fillRect(0,0,IMAGE_WIDTH,IMAGE_HEIGHT);
  const rgba=new Uint8ClampedArray(IMAGE_WIDTH*IMAGE_HEIGHT*4);rgba.fill(255);
  for(const object of editor.objects){
    const layer=editor.layerCanvas ? editor.layerCanvas(object) : editor.exportCanvas();
    const pixels=layer.getContext ? layer.getContext('2d').getImageData(0,0,IMAGE_WIDTH,IMAGE_HEIGHT).data : new Uint8ClampedArray(IMAGE_WIDTH*IMAGE_HEIGHT*4).fill(255);
    const params=object.monoParams||{mode:'color',threshold:50,contrast:100,brightness:0,gamma:100,sharpness:100,invert:false};
    const adjusted=prepareMonochromeRgba(pixels,IMAGE_WIDTH,IMAGE_HEIGHT,params);
    if(params.sharpness>0){
      const copy=new Uint8ClampedArray(adjusted),amount=params.sharpness/100;
      for(let y=1;y<IMAGE_HEIGHT-1;y++) for(let x=1;x<IMAGE_WIDTH-1;x++){
        const i=(y*IMAGE_WIDTH+x)*4,c=copy[i],n=copy[i-IMAGE_WIDTH*4],s=copy[i+IMAGE_WIDTH*4],w=copy[i-4],e=copy[i+4];
        const v=Math.max(0,Math.min(255,c+amount*(4*c-n-s-w-e)));
        adjusted[i]=adjusted[i+1]=adjusted[i+2]=v;
      }
    }
    const layerBits=ditherPixels(adjusted,IMAGE_WIDTH,IMAGE_HEIGHT,{mode:params.mode,threshold:params.threshold,contrast:100});
    const mono=monoToRgba(layerBits);
    for(let i=0;i<mono.length;i+=4){
      const alpha=pixels[i+3]/255;
      if(alpha>0){const base=rgba[i];rgba[i]=rgba[i+1]=rgba[i+2]=Math.round(mono[i]*alpha+base*(1-alpha));rgba[i+3]=255;}
    }
  }
  bits = new Uint8Array(IMAGE_BYTES);
  for(let i=0;i<IMAGE_WIDTH*IMAGE_HEIGHT;i++) if(rgba[i*4]<128) bits[i>>3]|=0x80>>(i&7);
  const preview = element('image-preview').getContext('2d');
  preview.putImageData(new ImageData(monoToRgba(bits), IMAGE_WIDTH, IMAGE_HEIGHT), 0, 0);
  const packed = lz4CompressBlock(bits);
  element('image-compression-state').textContent = packed.length > 16384
    ? `压缩后 ${packed.length} 字节，超过 16 KB，请换传统 Bayer 抖动`
    : `LZ4 压缩后 ${packed.length} / ${bits.length} 字节（${Math.round(packed.length * 100 / bits.length)}%），上传更快`;
  controls();
  renderingPreview = false;
}

function schedulePreview() {
  if (previewScheduled) return;
  previewScheduled = true;
  const schedule = globalThis.requestAnimationFrame || (callback => setTimeout(callback, 0));
  schedule(() => {
    previewScheduled = false;
    renderPreview();
  });
}

function setValue(id, value) {
  const input=element(id);
  if (String(input.value) !== String(value)) input.value=value;
}

function syncEditorControls() {
  if (!editor) return;
  const object=editor.selected, text=object?.type==='textbox', qr=object?.isQr===true;
  const layers=element('image-layers');
  const options=editor.objects.map((item,index)=>{
    const option=document.createElement('option');
    option.value=String(index);
    option.textContent=(index+1)+' · '+(item.type==='textbox' ? item.text.replace(/\n/g,' ').slice(0,24) || '空文本框'
      : item.isQr ? '二维码 · '+(item.qrText||'').slice(0,24) : '图片');
    option.selected=item===object;
    return option;
  }).reverse();
  layers.replaceChildren(...options);
  if (!object) layers.selectedIndex=-1;
  layers.disabled=uploading;
  element('image-object-panel').hidden=!object;
  element('image-text-panel').hidden=!text;
  element('image-qr-panel').hidden=!qr;
  for (const id of ['image-layer-delete','image-layer-duplicate','image-layer-up','image-layer-down',
    'image-flip-x','image-flip-y','image-zoom-in','image-zoom-out','image-zoom-reset','image-rotate-left','image-rotate-right',
    'image-object-x','image-object-y','image-object-width','image-object-height','image-object-angle'])
    element(id).disabled=uploading || !object;
  element('image-layer-up').disabled=uploading || !object || editor.objects.at(-1)===object;
  element('image-layer-down').disabled=uploading || !object || editor.objects[0]===object;
  for (const id of ['image-text','image-font-size','image-browser-font','image-local-font-search','image-local-font','image-font-family','image-text-color','image-text-align','image-text-bold'])
    element(id).disabled=uploading || !text;
  if (!object) return;
  const mono=object.monoParams||{mode:'color',threshold:50,contrast:100,brightness:0,gamma:100,sharpness:100,invert:false};
  setValue('image-dither-mode',mono.mode);setValue('image-threshold',mono.threshold);setValue('image-contrast',mono.contrast);setValue('image-brightness',mono.brightness);setValue('image-gamma',mono.gamma);setValue('image-sharpness',mono.sharpness);syncParameterLabels();
  for (const [id,value] of Object.entries({x:object.left,y:object.top,width:object.getScaledWidth(),height:object.getScaledHeight(),angle:object.angle}))
    setValue('image-object-'+id,Math.round(value*10)/10);
  element('image-object-height').disabled=uploading || text;
  if(text) {
    setValue('image-text',object.text);setValue('image-font-size',object.fontSize);
    setValue('image-font-family',object.fontFamily);setValue('image-browser-font',commonBrowserFonts.includes(object.fontFamily)?object.fontFamily:'');setValue('image-text-color',object.fill);const textBg=object.backgroundColor||object.textBackground||'rgba(255,255,255,0)';setValue('image-text-background',typeof textBg==='string'&&textBg.startsWith('#')?textBg:'#ffffff');element('image-text-bg-transparent').checked=textBg==='rgba(255,255,255,0)'||!textBg;
    setValue('image-text-align',object.textAlign);element('image-text-bold').checked=object.fontWeight==='bold';
  }
  if(qr) setValue('image-qr-content',object.qrText||'');
}

function loadFiles(files, {defaultImage=false}={}) {
  files=Array.from(files).filter(file=>file.type.startsWith('image/'));
  if (!files.length || uploading) return Promise.resolve();
  if (!defaultImage) ++loadSequence;
  const revision=loadSequence;
  importsPending++;
  controls();status('正在添加图片…');
  const job=importQueue.then(async()=>{
    for (const file of files) {
      if (uploading) return;
      let loaded;
      if ('createImageBitmap' in window) loaded=await createImageBitmap(file);
      else loaded=await new Promise((resolve,reject)=>{
        const image=new Image(), url=URL.createObjectURL(file);
        image.onload=()=>{URL.revokeObjectURL(url);resolve(image);};
        image.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('无法解码图片'));};image.src=url;
      });
      if (uploading || revision!==loadSequence || (defaultImage && editor.objects.length)) {
        loaded.close?.();return;
      }
      editor.addImage(loaded);
      loaded.close?.();
    }
    status('图片已添加；点击选择图层，拖动或使用控制点调整。');
  });
  importQueue=job.catch(()=>{});
  return job.finally(()=>{importsPending--;controls();});
}

/* 设备把 400x300 按 5x5 块降到 80x60，每块按黑点占比取 0～15 级灰度，
   4bpp 打包共 2400 字节；一帧放不下，按 960 字节分 3 页拉。 */
const PREVIEW_W = 80, PREVIEW_H = 60, PREVIEW_BYTES = 2400, PREVIEW_PAGE = 960, SLOT_COUNT = 3;
/* 0 级当白底跳过，1～15 由浅到深，15 是全黑。 */
const PREVIEW_GRAYS = Array.from({length: 16}, (_, level) => {
  const value = 255 - level * 17;
  return `rgb(${value},${value},${value})`;
});

function drawSlotPreview(canvas, data, slot, valid) {
  const ctx = canvas.getContext('2d');
  /* 每次都先清白底，否则上一次的"未读取"字样或旧缩略图会残留在新图下面。 */
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const label = element(`image-slot-state-${slot}`);
  /* data === null 是"还没读过"，跟设备上真的是空槽不是一回事。状态只写在下方标签，画布不重复写字。 */
  if (data === null) { label.textContent = '未读取'; return; }
  if (!valid) { label.textContent = '空槽'; return; }
  const sx = canvas.width / PREVIEW_W, sy = canvas.height / PREVIEW_H;
  for (let row = 0; row < PREVIEW_H; row++) {
    for (let col = 0; col < PREVIEW_W; col++) {
      const index = row * PREVIEW_W + col;
      const packed = data[2 + (index >> 1)];
      const gray = (index & 1) ? (packed & 0x0F) : (packed >> 4);
      if (!gray) continue;
      ctx.fillStyle = PREVIEW_GRAYS[gray];
      ctx.fillRect(Math.floor(col * sx), Math.floor(row * sy), Math.ceil(sx), Math.ceil(sy));
    }
  }
  label.textContent = '已有壁纸';
}

/* 点缩略图即为选中：既选上传目标，也切到这一张自己的工程。 */
let slotSwitchToken = 0;
async function selectSlot(slot) {
  if (slot < 0 || slot >= SLOT_COUNT || uploading) return;
  const token = ++slotSwitchToken;
  if (slot !== selectedSlot) {
    const previous = selectedSlot;
    /* 切走前把二维码输入框关掉，否则它会盖在新工程上面。 */
    const qrDialog = element('image-qr-dialog');
    if (qrDialog && qrDialog.open) qrDialog.close();
    await saveProject(previous);
    if (token !== slotSwitchToken) return;
    selectedSlot = slot;
    await loadSlotProject(slot);
    if (token !== slotSwitchToken) return;
    status(`已切到第 ${slot + 1} 张的工程。`);
  }
  for (let i = 0; i < SLOT_COUNT; i++)
    element(`image-slot-card-${i}`).classList.toggle('selected', i === slot);
  element('image-upload').textContent = `上传到第 ${slot + 1} 张`;
  /* 选中哪张，设备就显示哪张；空槽时设备不会切过去，这时别报成故障。 */
  if (connected && token === slotSwitchToken) {
    try {
      const reply = await request(TYPES.imageSelect, Uint8Array.of(slot));
      if (reply.length !== 1 || reply[0] !== 0) throw new Error('empty');
      uploadState(`设备已切到第 ${slot + 1} 张。`);
    } catch (error) {
      if (!connected || token !== slotSwitchToken) return;
      /* 设备正在刷屏也会走到这里，不能一律说成"空的"，那样会误导。 */
      const busy = /忙|没法处理|等太久/.test(error.message);
      uploadState(busy ? '设备正忙，等它刷完这一屏再切过去。'
        : `第 ${slot + 1} 张还是空的，上传后设备才会切过去。`);
    }
  }
}

/* 设备正在刷屏时读不了缩略图（解码要借屏幕缓冲），等一下重试即可。 */
/* 缩略图 2400 字节分 3 页拉，每页 960，拼成一份带头信息的结果交给 drawSlotPreview。 */
async function requestPreview(slot) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const packed = new Uint8Array(2 + PREVIEW_BYTES);
      packed[0] = slot;
      for (let offset = 0; offset < PREVIEW_BYTES; offset += PREVIEW_PAGE) {
        const response = await request(TYPES.imagePreview,
          Uint8Array.of(slot, offset & 0xFF, (offset >> 8) & 0xFF));
        if (response.length < 4 || response[0] !== slot)
          throw new Error('缩略图响应错误');
        if ((response[2] | (response[3] << 8)) !== offset)
          throw new Error('缩略图分页错位');
        packed[1] = response[1];
        const chunk = response.subarray(4, 4 + Math.min(PREVIEW_PAGE, PREVIEW_BYTES - offset));
        packed.set(chunk, 2 + offset);
      }
      return packed;
    } catch (error) {
      if (attempt === 2 || !connected) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
}

/* 用刚上传的位图本地算 80×60，立刻刷新卡片。
   上传成功后设备正在整屏刷新，这时向它要缩略图必然被拒，本地算没有这个问题。 */
function downsampledPreview(bits) {
  const out = new Uint8Array(PREVIEW_BYTES);
  const stride = IMAGE_WIDTH / 8, step = IMAGE_WIDTH / PREVIEW_W;
  let index = 0;
  for (let row = 0; row < PREVIEW_H; row++) {
    for (let col = 0; col < PREVIEW_W; col++) {
      let hits = 0;
      for (let dy = 0; dy < step; dy++) {
        const y = row * step + dy;
        for (let dx = 0; dx < step; dx++) {
          const x = col * step + dx;
          if ((bits[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1) hits++;
        }
      }
      const gray = Math.round(hits * 15 / (step * step));
      if ((index & 1) === 0) out[index >> 1] = gray << 4;
      else out[index >> 1] |= gray;
      index++;
    }
  }
  return out;
}

/* 原图按钮：只拉这一张的 400x300 原始位图，分 16 页拼回来，1:1 画进卡片。 */
const IMAGE_FULL_PAGE = 960;
function drawFullImage(canvas, data, slot) {
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(IMAGE_WIDTH, IMAGE_HEIGHT);
  const stride = IMAGE_WIDTH / 8;
  for (let y = 0; y < IMAGE_HEIGHT; y++) {
    for (let x = 0; x < IMAGE_WIDTH; x++) {
      const bit = (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
      const index = (y * IMAGE_WIDTH + x) * 4;
      const value = bit ? 0 : 255;
      image.data[index] = image.data[index + 1] = image.data[index + 2] = value;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  element(`image-slot-state-${slot}`).textContent = '原图';
}

/* 设备刷屏时读不了原图（解码要借屏幕缓冲），等它刷完再读，别直接报失败。 */
async function requestFullPage(slot, offset) {
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await request(TYPES.imageFull,
        Uint8Array.of(slot, offset & 0xFF, (offset >> 8) & 0xFF), 15000);
      if (response.length < 4 || response[0] !== slot)
        throw new Error('原图响应错误');
      if ((response[2] | (response[3] << 8)) !== offset)
        throw new Error('原图分页错位');
      return response;
    } catch (error) {
      if (attempt === 5 || !connected) throw error;
      uploadState(`设备正忙，等它刷完这一屏再读…（第 ${attempt + 1} 次重试）`);
      await new Promise(resolve => setTimeout(resolve, 700));
    }
  }
}

async function readFullImage(slot) {
  if (!connected || uploading || readingPreviews) return;
  readingPreviews = true; controls();
  uploadState(`正在读取第 ${slot + 1} 张原图…`);
  try {
    const data = new Uint8Array(IMAGE_BYTES);
    let valid = 0;
    for (let offset = 0; offset < IMAGE_BYTES; offset += IMAGE_FULL_PAGE) {
      const response = await requestFullPage(slot, offset);
      valid = response[1];
      const chunk = response.subarray(4, 4 + Math.min(IMAGE_FULL_PAGE, IMAGE_BYTES - offset));
      data.set(chunk, offset);
      setProgress((offset + chunk.length) * 100 / IMAGE_BYTES);
    }
    if (!valid) { uploadState(`第 ${slot + 1} 张还是空的。`); return; }
    drawFullImage(element(`image-slot-canvas-${slot}`), data, slot);
    uploadState(`已读取第 ${slot + 1} 张原图，卡片里就是设备上的完整画面。`);
  } catch (error) {
    uploadState(/忙|没法处理|等太久/.test(error.message)
      ? '设备正忙，等它刷完这一屏再点一次「原图」。'
      : '这次没读到原图：' + error.message);
  } finally {
    readingPreviews = false; controls();
  }
}

async function readPreviews() {
  if (!connected || uploading || readingPreviews) return;
  readingPreviews = true; controls();
  try {
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const data = await requestPreview(slot);
      /* 空槽只回全 0 且 valid=0，直接画占位。 */
      drawSlotPreview(element(`image-slot-canvas-${slot}`), data, slot, !!data[1]);
    }
    uploadState('已读取三个槽位的缩略图。');
  } catch (error) {
    uploadState(/忙|没法处理|等太久/.test(error.message)
      ? '设备正忙，等它刷完这一屏再读缩略图。'
      : '这次没读到缩略图：' + error.message);
  } finally {
    readingPreviews = false; controls();
  }
}

async function uploadImage() {
  if (!connected || !bits || uploading || importsPending) return;
  const token = ++uploadToken;
  const link = rx;
  uploadCancelled = committing = false;
  uploading = true;
  controls();
  const stored = lz4CompressBlock(bits);
  if (stored.length > 16384) {
    uploading = false;
    controls();
    uploadState('压缩后仍然超过 16 KB，无法保存；请用传统 Bayer 抖动。');
    return;
  }
  uploadState('正在擦除图片区… 压缩后 ' + stored.length + ' / ' + bits.length + ' 字节');
  setProgress(0);
  deviceProgress = {id:null, total:stored.length, received:0};
  try {
    const info = await request(TYPES.info);
    setRxWriteSize(rx, info[29]);
    const uploadRequest = (...args) => {
      if (token !== uploadToken || rx !== link) return Promise.reject(new Error('蓝牙连接已变化'));
      return request(...args);
    };
    const result = await uploadImageBytes(stored, uploadRequest, (type, payload) => {
      const id = 0x8000 | nextId;
      nextId = (nextId + 1) & 0x7fff;
      return sendBytes(encodeFrame(id, type, payload));
    }, {
      isCancelled: () => token !== uploadToken || uploadCancelled,
      onQueued: () => {
        if (token !== uploadToken || deviceProgress.received) return;
        uploadState('正在传输，等待设备报告接收进度…');
      },
      onCommit: () => { committing = true; controls(); },
    }, selectedSlot);
    if (token !== uploadToken) return;
    imageEnabled = true;
    element('image-image-enabled').checked = true;
    element('image-image-state').textContent = '壁纸页已开启';
    setProgress(100);
    uploadState('上传成功：' + stored.length + ' 字节；传输 ' + (result.transferMs / 1000).toFixed(2) + ' 秒，' + (stored.length / Math.max(1, result.transferMs) * 1000 / 1024).toFixed(2) + ' KiB/s；含擦除和校验共 ' + (result.totalMs / 1000).toFixed(2) + ' 秒。设备已切到图片页。');
    /* 刚写入的槽用本地位图刷新预览，既准确又不用和设备的整屏刷新抢时间。 */
    const preview = new Uint8Array(2 + PREVIEW_BYTES);
    preview[0] = selectedSlot; preview[1] = 1;
    preview.set(downsampledPreview(bits), 2);
    drawSlotPreview(element(`image-slot-canvas-${selectedSlot}`), preview, selectedSlot, true);
  } catch (error) {
    if (token === uploadToken) {
      /* 提交后设备要校验 CRC 再整屏刷新，确认响应偶尔会晚到；这时数据其实已经写进去了，
         不能按"上传失败"提示，否则用户会重复上传。 */
      const timedOut = /超时/.test(error.message);
      uploadState(uploadCancelled ? '已取消；重新上传即可。'
        : timedOut ? '设备已收到全部数据，但确认响应超时（多半是在刷新屏幕）。等几秒点「读取设备缩略图」确认，不要重复上传。'
        : '上传失败：' + error.message + '。直接重新上传即可。');
    }
  } finally {
    if (token === uploadToken) {
      uploading = false;
      deviceProgress = null;
      controls();
    }
  }
}

async function cancelUpload() {
  if (!uploading || committing || uploadCancelled) return;
  uploadCancelled = true;
  controls();
  uploadState('正在取消上传…');
}

async function toggleImage() {
  if (!connected || uploading) return;
  const enabled = element('image-image-enabled').checked;
  element('image-image-enabled').disabled = true;
  try {
    await request(TYPES.imageSettingsWrite, Uint8Array.of(enabled ? 1 : 0));
    imageEnabled = enabled;
    element('image-image-state').textContent = enabled ? '壁纸页已开启' : '壁纸页已关闭';
  } catch (error) {
    element('image-image-enabled').checked = !enabled;
    element('image-image-state').textContent = error.message;
  } finally {
    element('image-image-enabled').disabled = !connected || uploading;
  }
}

function bind() {
  /* 先把初始状态落一遍，后面某个控件取不到时也不会让整页停在错误状态。 */
  controls();
  editor=new CanvasEditor(element('image-editor'),{
    onChange:()=>{++loadSequence;schedulePreview();if(!suppressSave&&typeof saveProject==='function')saveProject();},onSelection:()=>syncEditorControls(),
  });
  editor.bindGestures(element('image-preview'),true);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const target = event.target;
    const tag = target?.tagName;
    /* 输入框里按删除键是编辑文字，不能抢；图层下拉框里按删除才允许删图层。 */
    if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' ||
        (tag === 'SELECT' && target.id !== 'image-layers')) return;
    if (uploading || !editor?.selected || editor.locked) return;
    event.preventDefault();
    editor.removeSelected();
  });
  element('image-add-text').addEventListener('click',()=>editor.addText());
  /* 二维码：弹出内容输入框，确认后按内容生成黑底白块图并作为图层插入。 */
  const qrDialog=element('image-qr-dialog');
  const openQrDialog=()=>{
    element('image-qr-text').value='';
    if (typeof qrDialog.showModal==='function') qrDialog.showModal();
    else qrDialog.setAttribute('open','');
  };
  const closeQrDialog=()=>{
    if (!qrDialog.open) return;
    if (typeof qrDialog.close==='function') qrDialog.close();
    else qrDialog.removeAttribute('open');
  };
  const insertQr=()=>{
    const content=element('image-qr-text').value.trim();
    if (!content) { status('请输入二维码内容。'); return; }
    closeQrDialog();
    try {
      const object=editor.addQr(content);
      if (object) status('二维码已插入；拖动或用控制点缩放调整位置。');
    } catch (error) { status('二维码生成失败：'+error.message); }
  };
  element('image-add-qr').addEventListener('click',()=>{ if (!uploading) openQrDialog(); });
  element('image-qr-cancel').addEventListener('click',closeQrDialog);
  element('image-qr-confirm').addEventListener('click',insertQr);
  element('image-qr-update').addEventListener('click',()=>{
    const object=editor.selected;
    if (!object || object.isQr!==true) return;
    const content=element('image-qr-content').value.trim();
    if (!content) { status('请输入二维码内容。'); return; }
    try { editor.updateQr(object,content); status('二维码已更新。'); }
    catch (error) { status('二维码生成失败：'+error.message); }
  });
  element('image-connect').addEventListener('click', () => connect().catch(error => {
    status(error.message);
    setConnected(false);
  }));
  element('image-disconnect').addEventListener('click', () => device?.gatt.disconnect());
  element('image-file').addEventListener('change', () => {
    loadFiles(element('image-file').files || []).catch(error => status(error.message));
    element('image-file').value='';
  });
  document.addEventListener('paste', event => {
    const files=Array.from(event.clipboardData?.items || []).filter(item=>item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
    if (!files.length || uploading) return;
    event.preventDefault();
    loadFiles(files).catch(error => status('粘贴图片失败：' + error.message));
  });
  document.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = uploading ? 'none' : 'copy';
  });
  document.addEventListener('drop', event => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!files.length) return;
    event.preventDefault();
    if (uploading) return;
    const images=files.filter(file=>file.type.startsWith('image/'));
    if (!images.length) { status('请拖入图片文件。'); return; }
    loadFiles(images).catch(error => status('加载拖入图片失败：' + error.message));
  });
  for (const id of ['image-dither-mode', 'image-threshold', 'image-contrast', 'image-brightness', 'image-gamma', 'image-sharpness'])
    element(id).addEventListener('input', () => {
      if(editor?.selected){editor.selected.monoParams={...(editor.selected.monoParams||{}),mode:element('image-dither-mode').value,threshold:Number(element('image-threshold').value),contrast:Number(element('image-contrast').value),brightness:Number(element('image-brightness').value),gamma:Number(element('image-gamma').value),sharpness:Number(element('image-sharpness').value),invert};if(typeof saveProject==='function')saveProject();}
      element('image-preset').value = 'custom';
      syncParameterLabels();
      renderPreview();
    });

  element('image-project-export').addEventListener('click',async()=>{const blob=new Blob([JSON.stringify(await editor.exportProject(),null,2)],{type:'application/json'});const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download=`thplot-canvas-${selectedSlot+1}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),0);});
  element('image-project-import').addEventListener('change',async()=>{const file=element('image-project-import').files?.[0];if(!file)return;try{await editor.importProject(JSON.parse(await file.text()));await saveProject();status('工程已导入。');}catch(error){status('导入工程失败：'+error.message);}element('image-project-import').value='';});
  element('image-clear').addEventListener('click',()=>{++loadSequence;editor.clear();});
  element('image-layers').addEventListener('change',()=>editor.select(editor.objects[Number(element('image-layers').value)]));
  element('image-layer-delete').addEventListener('click',()=>editor.removeSelected());
  element('image-layer-duplicate').addEventListener('click',()=>editor.duplicateSelected().catch(error=>status(error.message)));
  element('image-layer-up').addEventListener('click',()=>editor.moveSelected(1));
  element('image-layer-down').addEventListener('click',()=>editor.moveSelected(-1));
  const textFields={
    'image-text':['text',value=>value], 'image-font-size':['fontSize',Number],
    'image-font-family':['fontFamily',value=>value], 'image-text-color':['fill',value=>value],
    'image-text-align':['textAlign',value=>value],
  };
  for(const [id,[key,convert]] of Object.entries(textFields)) element(id).addEventListener('input',()=>{
    if(editor.selected?.type!=='textbox') return;
    const input=element(id);
    if(input.checkValidity && !input.checkValidity()) return;
    editor.updateSelected({[key]:convert(input.value)});
  });
  const applyFont = value => { if(editor.selected?.type==='textbox' && value) { setValue('image-font-family',value); editor.updateSelected({fontFamily:value}); } };
  element('image-browser-font').addEventListener('change',event=>applyFont(event.target.value));
  element('image-local-font').addEventListener('change',event=>applyFont(event.target.value));
  element('image-local-font-search').addEventListener('input',event=>filterLocalFonts(event.target.value));
  const updateTextBackground=()=>{const value=element('image-text-bg-transparent').checked?'rgba(255,255,255,0)':element('image-text-background').value;editor.updateSelected({backgroundColor:value,textBackground:value});};
  element('image-text-background').addEventListener('input',updateTextBackground);
  element('image-text-bg-transparent').addEventListener('change',updateTextBackground);
  element('image-swap-text-colors').addEventListener('click',()=>{
    const object=editor.selected;if(!object || object.type!=='textbox') return;
    const textColor=element('image-text-color').value,backgroundColor=element('image-text-background').value;
    element('image-text-color').value=backgroundColor;element('image-text-background').value=textColor;element('image-text-bg-transparent').checked=false;
    editor.updateSelected({fill:backgroundColor,backgroundColor:textColor,textBackground:textColor});
  });
  const commonFonts=['Microsoft YaHei','微软雅黑','SimSun','宋体','SimHei','黑体','KaiTi','楷体','FangSong','仿宋','Helvetica','Verdana','Consolas'];
  let localFonts=commonFonts.slice();
  const renderLocalFonts = names => element('image-local-font').replaceChildren(...names.map(name=>{const o=document.createElement('option');o.value=name;o.textContent=name;return o;}));
  window.filterLocalFonts = query => { const needle=String(query||'').trim().toLocaleLowerCase(); renderLocalFonts(localFonts.filter(name=>!needle||name.toLocaleLowerCase().includes(needle))); };
  const filterLocalFonts = query => window.filterLocalFonts(query);
  renderLocalFonts(localFonts);
  element('image-load-fonts').addEventListener('click',async()=>{ if(!window.queryLocalFonts){status('当前浏览器不支持读取本机字体，请使用自定义字体名称。');return;} try{localFonts=[...new Set((await window.queryLocalFonts()).map(font=>font.family))].sort();filterLocalFonts(element('image-local-font-search').value);status('已读取 '+localFonts.length+' 个本机字体。');}catch(error){status('读取本机字体失败：请在浏览器弹出的权限窗口中允许字体访问。');} });
  element('image-text-bold').addEventListener('change',()=>editor.updateSelected({fontWeight:element('image-text-bold').checked?'bold':'normal'}));
  for(const [id,key] of [['x','left'],['y','top'],['angle','angle']]) element('image-object-'+id).addEventListener('change',()=>{
    const input=element('image-object-'+id);
    if(input.checkValidity())editor.updateSelected({[key]:Number(input.value)});
  });
  for(const dimension of ['width','height']) element('image-object-'+dimension).addEventListener('change',()=>{
    const input=element('image-object-'+dimension),object=editor.selected;
    if(!object || !input.checkValidity())return;
    const value=Number(input.value);
    if(object.type==='textbox')editor.updateSelected({width:value/object.scaleX});
    else {const factor=value/(dimension==='width'?object.getScaledWidth():object.getScaledHeight());editor.transformSelected(factor,0,object.getCenterPoint());}
  });
  element('image-flip-x').addEventListener('click',()=>editor.updateSelected({flipX:!editor.selected?.flipX}));
  element('image-flip-y').addEventListener('click',()=>editor.updateSelected({flipY:!editor.selected?.flipY}));
  element('image-invert').addEventListener('click', () => { invert=!invert; if(editor.selected) editor.selected.monoParams={...(editor.selected.monoParams||{}),invert}; renderPreview(); });
  element('image-preset').addEventListener('change', event => {
    const presets={photo:[0,100,50],portrait:[8,115,52],line:[0,180,62],high:[0,260,55]};
    const values=presets[event.target.value], object=editor?.selected;
    if(!values || !object) return;
    const [brightness,contrast,threshold]=values;
    element('image-brightness').value=brightness;
    element('image-contrast').value=contrast;
    element('image-threshold').value=threshold;
    object.monoParams={...(object.monoParams||{}),brightness,contrast,threshold};
    syncParameterLabels();
    if(typeof saveProject==='function') saveProject();
    renderPreview();
  });

  element('image-zoom-in').addEventListener('click',()=>editor.transformSelected(1.25));
  element('image-zoom-out').addEventListener('click',()=>editor.transformSelected(.8));
  element('image-zoom-reset').addEventListener('click',()=>{
    const object=editor.selected;
    if(!object)return;
    if(object.type==='textbox')editor.updateSelected({scaleX:1,scaleY:1,angle:0,flipX:false,flipY:false});
    else {const scale=Math.max(400/object.width,300/object.height);editor.updateSelected({scaleX:scale,scaleY:scale,left:(400-object.width*scale)/2,top:(300-object.height*scale)/2,angle:0,flipX:false,flipY:false});}
  });
  element('image-rotate-left').addEventListener('click',()=>editor.transformSelected(1,-90));
  element('image-rotate-right').addEventListener('click',()=>editor.transformSelected(1,90));
  element('image-upload').addEventListener('click', uploadImage);
  element('image-cancel').addEventListener('click', cancelUpload);
  element('image-read-previews').addEventListener('click', readPreviews);
  /* 直接点缩略图选槽位，边框高亮就是选中态，不再另设下拉框。 */
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const card = element(`image-slot-card-${slot}`);
    card.addEventListener('click', () => selectSlot(slot));
    card.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSlot(slot); }
    });
    /* 点"原图"只下载这一张，不能顺带把卡片选中事件也触发了。 */
    const fullButton = element(`image-slot-full-${slot}`);
    if (fullButton) fullButton.addEventListener('click', event => {
      event.stopPropagation();
      readFullImage(slot).catch(() => {});
    });
    drawSlotPreview(element(`image-slot-canvas-${slot}`), null, slot, false);
  }
  selectSlot(selectedSlot);
  element('image-image-enabled').addEventListener('change', toggleImage);
  renderPreview();
  controls();
  /* 先搬旧工程，再读第 1 张；之后每个槽位各存各的。 */
  restoreProjectPromise = migrateLegacyProjects().catch(() => {}).then(() => loadSlotProject(selectedSlot));
}

window.addEventListener('thplot:device-ready', event => { rx=event.detail.rx; tx=event.detail.tx; device=event.detail.device; tx.addEventListener('characteristicvaluechanged', event => parser.accept(new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength))); setConnected(true); readActivation().then(()=>readImageEnabled()).catch(()=>{}); });
window.addEventListener('thplot:device-lost', () => disconnected());

bind();
fetch('./assets/default-wallpaper.png').then(response => { if (!response.ok) throw new Error('默认图片加载失败'); return response.blob(); }).then(file => restoreProjectPromise.then(() => { if (!editor.objects.length && !uploading) return loadFiles([file],{defaultImage:true}); })).catch(error => { if (!editor.objects.length) status(error.message); });

/* 预览调试：?demo=1 时自动载入一张渐变测试图，不写设备。 */
async function loadDemo() {
  ++loadSequence;
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 800, 600);
  gradient.addColorStop(0, '#1d4e89');
  gradient.addColorStop(0.5, '#e8d8b0');
  gradient.addColorStop(1, '#8c2f39');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 800, 600);
  context.fillStyle = 'rgba(255,255,255,.9)';
  context.font = 'bold 72px "Microsoft YaHei", sans-serif';
  context.textAlign = 'center';
  context.fillText('TH-Plot', 400, 300);
  context.font = '28px "Microsoft YaHei", sans-serif';
  context.fillText('400 × 300 自定义壁纸预览', 400, 360);
  editor.addImage(canvas);
  const rotate = Number(new URLSearchParams(location.search).get('rotate'));
  if (Number.isFinite(rotate)) editor.updateSelected({angle:rotate});
  renderPreview();
  status('示例图片已载入（?demo=1），可直接拖动、缩放和旋转。');
}
if (new URLSearchParams(location.search).get('demo') === '1') loadDemo();
