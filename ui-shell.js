const byId=id=>document.getElementById(id);
const pages={
  overview:{title:'设备概览',eyebrow:'我的设备',description:'查看当前环境，管理你的墨水屏。'},
  history:{title:'历史数据',eyebrow:'环境记录',description:'把短暂的变化，放进更长的时间里看。'},
  wallpaper:{title:'自定义壁纸',eyebrow:'屏幕创作',description:'选一个槽位，做一张属于你的设备画面。'},
  settings:{title:'设备设置',eyebrow:'设备偏好',description:'调整屏幕显示、记录方式与日历习惯。'},
  showcase:{title:'复刻作品墙',eyebrow:'',description:''},
  about:{title:'关于与帮助',eyebrow:'4.2 寸墨水屏温湿度计',description:'固件、设备预览，以及你可能需要的信息。'},
};
const navButtons=[...document.querySelectorAll('.tab-btn')];
const scrollPositions=new Map();
let currentPage=null;
const text=(id,value)=>{const el=byId(id);if(el&&el.textContent!==value)el.textContent=value;};
function selectPage(name,{push=false,restore=false}={}) {
  if(!pages[name])name='overview';
  if(currentPage)scrollPositions.set(currentPage,window.scrollY);
  currentPage=name;
  for(const button of navButtons){const active=button.dataset.tab===name;button.classList.toggle('active',active);if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
  for(const page of document.querySelectorAll('.tab-page'))page.hidden=page.dataset.page!==name;
  document.body.dataset.page=name;
  text('page-title',pages[name].title);text('page-breadcrumb',pages[name].title);text('page-eyebrow',pages[name].eyebrow);text('page-description',pages[name].description);
  document.title=pages[name].title+' · 4.2 寸墨水屏温湿度计';
  if(push&&location.hash!=='#'+name)history.pushState({page:name},'','#'+name);
  window.dispatchEvent(new CustomEvent('thplot:tab-changed',{detail:name}));
  window.dispatchEvent(new Event('resize'));
  requestAnimationFrame(()=>window.scrollTo(0,restore?(scrollPositions.get(name)||0):0));
}
for(const button of navButtons)button.addEventListener('click',()=>selectPage(button.dataset.tab,{push:true}));
navButtons.forEach((button,index)=>button.addEventListener('keydown',event=>{
  let next;
  if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%navButtons.length;
  else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index+navButtons.length-1)%navButtons.length;
  else if(event.key==='Home')next=0;else if(event.key==='End')next=navButtons.length-1;else return;
  event.preventDefault();navButtons[next].focus();
}));
for(const action of document.querySelectorAll('[data-go]'))action.addEventListener('click',event=>{event.preventDefault();selectPage(action.dataset.go,{push:true});});
window.addEventListener('popstate',()=>selectPage(location.hash.slice(1),{restore:true}));
window.addEventListener('hashchange',()=>{if(location.hash.slice(1)!==currentPage)selectPage(location.hash.slice(1),{restore:true});});
const initial=location.hash.slice(1);selectPage(initial);
if(!initial)history.replaceState({page:'overview'},'','#overview');

for(const action of document.querySelectorAll('[data-connect]'))action.addEventListener('click',()=>byId('connect').click());
function syncConnection() {
  const connected=byId('connection').textContent.trim()==='已连接';
  document.body.dataset.connected=String(connected);
  text('guide-state',connected?'蓝牙已连接':'等待连接');
  text('guide-title',connected?'设备已连接':'连接设备，开始查看环境数据');
  text('guide-description',connected?'你可以刷新当前读数、查看历史变化，或把新的壁纸发送到设备。':'长按设备按键开启蓝牙窗口，将设备放在附近，再点击连接。');
  for(const button of document.querySelectorAll('[data-connect]')){button.hidden=connected;button.disabled=byId('connect').disabled;}
  const historyAction=document.querySelector('.guide-actions [data-go="history"]');
  if(historyAction)historyAction.textContent=connected?'查看历史数据 →':'先看看示例数据 →';
  const status=byId('status').textContent.trim();
  const scope=byId('status').dataset.scope;
  byId('connection-message').hidden=!status||status==='尚未连接设备'||!!scope&&scope!==currentPage;
}
const connectionObserver=new MutationObserver(syncConnection);
for(const id of ['connection','status','connect'])connectionObserver.observe(byId(id),{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','data-scope']});
window.addEventListener('thplot:tab-changed',syncConnection);
syncConnection();

const mobile=matchMedia('(max-width:720px)');
let desktopCanvasView='editor';
function setCanvasView(view) {
  if(!mobile.matches)desktopCanvasView=view;
  const selected=mobile.matches?'output':desktopCanvasView;
  byId('custom-image').dataset.canvasView=selected;
  for(const button of document.querySelectorAll('button[data-canvas-view]'))button.setAttribute('aria-pressed',String(button.dataset.canvasView===selected));
  window.dispatchEvent(new Event('resize'));
}
for(const button of document.querySelectorAll('button[data-canvas-view]'))button.addEventListener('click',()=>setCanvasView(button.dataset.canvasView));
function syncResponsive() {
  setCanvasView(desktopCanvasView);
  byId('image-mono-panel').open=!mobile.matches;
}
mobile.addEventListener('change',syncResponsive);syncResponsive();

const modeSelect=byId('image-simple-mode');
const modeButtons=[...document.querySelectorAll('[data-wallpaper-mode]')];
for(const button of modeButtons)button.addEventListener('click',()=>{
  if(button.disabled||modeSelect.value===button.dataset.wallpaperMode)return;
  modeSelect.value=button.dataset.wallpaperMode;modeSelect.dispatchEvent(new Event('change',{bubbles:true}));syncMode();
});
function syncMode() {
  for(const button of modeButtons){button.disabled=modeSelect.disabled;button.setAttribute('aria-pressed',String(button.dataset.wallpaperMode===modeSelect.value));}
  for(const card of document.querySelectorAll('.slot-card'))card.setAttribute('aria-pressed',String(card.classList.contains('selected')));
  const imageLoaded=modeSelect.value==='image'&&[...byId('image-layers').options].some(option=>option.textContent.includes('图片'));
  text('image-source-name',imageLoaded?'替换当前图片':'选择一张图片');
}
modeSelect.addEventListener('change',syncMode);
const modeObserver=new MutationObserver(syncMode);
modeObserver.observe(modeSelect,{attributes:true,attributeFilter:['disabled']});
modeObserver.observe(byId('image-layers'),{childList:true});
for(const card of document.querySelectorAll('.slot-card'))modeObserver.observe(card,{attributes:true,attributeFilter:['class']});
syncMode();

function syncUpload() {
  const message=byId('image-upload-state').textContent.trim();
  const busy=!byId('image-progress').hidden;
  const connected=byId('connection').textContent.trim()==='已连接';
  const target=byId('image-upload').textContent.match(/第\s*(\d+)\s*张/);
  const syncing=byId('custom-image').dataset.readingPreviews==='true';
  const available=busy?'正在发送，请保持设备在附近':syncing?'正在同步设备缩略图…':message.startsWith('上传成功')?'上传成功，设备已显示新的画面':!connected?'连接设备后即可上传':byId('image-upload').disabled?'先准备好画面内容':`就绪，将发送到第 ${target?.[1]||1} 张`;
  text('image-upload-availability',available);
  document.querySelector('.tab-btn[data-tab="wallpaper"]').dataset.busy=String(busy);
}
const uploadObserver=new MutationObserver(syncUpload);
for(const id of ['image-upload','image-cancel','image-progress','image-upload-state'])uploadObserver.observe(byId(id),{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','hidden']});
uploadObserver.observe(byId('custom-image'),{attributes:true,attributeFilter:['data-reading-previews']});
syncUpload();

function syncTransfer(){document.querySelector('.history-card').dataset.transferBusy=String(!byId('cancel').disabled);}
new MutationObserver(syncTransfer).observe(byId('cancel'),{attributes:true,attributeFilter:['disabled']});syncTransfer();
for(const label of document.querySelectorAll('.project-tools .button-like')){label.tabIndex=0;label.setAttribute('role','button');label.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();label.querySelector('input').click();}});}
document.addEventListener('click',event=>{
  if(event.target.closest('#image-clear')&&byId('image-layers').options.length&&!confirm('清空当前槽位的草稿？设备上已保存的壁纸不会被删除。')){event.preventDefault();event.stopImmediatePropagation();}
},true);
document.addEventListener('click',event=>{if(!event.target.closest('.project-tools'))for(const details of document.querySelectorAll('.project-tools[open]'))details.open=false;});

let modelPromise=null;
const modelHost=byId('model-preview');
function loadDeviceModel() {
  if(currentPage!=='overview'||modelPromise)return;
  text('model-load-state','正在加载 3D 设备预览…');
  modelPromise=import('./device-model.js?v=ui-redesign2').then(module=>module.mountDeviceModel(modelHost)).catch(()=>{
    text('model-load-state','3D 预览暂时无法加载，请刷新重试。');modelPromise=null;
  });
}
window.addEventListener('thplot:tab-changed',loadDeviceModel);
loadDeviceModel();
new MutationObserver(()=>{
  if(modelHost.dataset.ready==='true')text('model-load-state','拖动旋转 · 双指或滚轮缩放');
  if(modelHost.dataset.error==='true')text('model-load-state','3D 预览加载失败，请刷新重试。');
}).observe(modelHost,{attributes:true,attributeFilter:['data-ready','data-error']});
