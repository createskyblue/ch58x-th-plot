import {Canvas, FabricImage, Textbox, Point} from './vendor/fabric.js';
import {qrcode} from './vendor/qrcode.js';
qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

export class CanvasEditor {
  static fontFamily = 'Wallpaper Song';

  static loadDefaultFont() {
    let face=[...document.fonts].find(font=>font.family.replace(/^['"]|['"]$/g,'')===CanvasEditor.fontFamily);
    if (!face) {
      face=new FontFace(CanvasEditor.fontFamily,'url("./assets/fonts/simsun.ttf")',
        {style:'normal',weight:'400'});
      document.fonts.add(face);
    }
    return face.load();
  }

  constructor(element, {onChange = () => {}, onSelection = () => {}} = {}) {
    this.onChange = onChange;
    this.onSelection = onSelection;
    this.locked = false;
    this.simpleMode = false;
    this.textZoomSizes = new WeakMap();
    this.canvas = new Canvas(element, {
      width:400, height:300, backgroundColor:'#ffffff',
      preserveObjectStacking:true, selection:true, enablePointerEvents:true,
    });
    for (const event of ['object:modified','object:moving','object:scaling','object:resizing','object:rotating','text:changed'])
      this.canvas.on(event, () => this.changed());
    for (const event of ['selection:created','selection:updated','selection:cleared'])
      this.canvas.on(event, () => { this.configureSelection(); this.snapToPixels(); this.onSelection(this.selected); });
    /* 编辑画布本体也要支持滚轮缩放：滚轮缩放选中对象，Shift+滚轮旋转。 */
    const surface = this.canvas.upperCanvasEl;
    surface.addEventListener('wheel', event => {
      if (this.locked || this.simpleMode || !this.selected) return;
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      const anchor = {x:(event.clientX - rect.left) * 400 / rect.width,
        y:(event.clientY - rect.top) * 300 / rect.height};
      this.transformSelected(event.shiftKey ? 1 : Math.exp(-event.deltaY * 0.0015),
        event.shiftKey ? event.deltaY * 0.1 : 0, anchor);
    }, {passive:false});
  }

  get objects() { return this.canvas.getObjects(); }
  get selected() { return this.canvas.getActiveObject() || null; }
  get canTransformSelected() {
    const object = this.selected;
    return !this.locked && !!object && (!this.simpleMode || (object.type === 'image' && !object.isQr));
  }

  configureSelection() {
    const selected=this.selected;
    if (selected?.type !== 'activeselection') return;
    const hasText=selected.getObjects().some(object=>object.type==='textbox');
    selected.set({lockScalingX:hasText,lockScalingY:hasText,lockSkewingX:hasText,lockSkewingY:hasText});
    selected.setControlsVisibility(Object.fromEntries(['tl','tr','bl','br','mt','mb','ml','mr'].map(key=>[key,!hasText])));
  }

  normalizeText(object) {
    object.set({scaleX:1,scaleY:1,skewX:0,skewY:0,
      lockScalingX:true,lockScalingY:true,lockSkewingX:true,lockSkewingY:true});
    object.setControlsVisibility({tl:false,tr:false,bl:false,br:false,mt:false,mb:false,ml:true,mr:true,mtr:true});
    object.initDimensions();
    object.dirty=true;
    object.setCoords();
  }

  snapToPixels() {
    const active = this.selected;
    if (active && !this.objects.includes(active)) {
      active.set({left:Math.round(active.left), top:Math.round(active.top)});
      active.setCoords();
    }
    for (const object of this.objects) {
      if (object.group?.type === 'activeselection') {
        // Selection members use local coordinates; snap their actual canvas positions.
        const position = object.getXY();
        object.setXY(new Point(Math.round(position.x), Math.round(position.y)));
      } else object.set({left:Math.round(object.left), top:Math.round(object.top)});
      object.setCoords();
    }
  }

  setSimpleMode(enabled) {
    if (this.selected?.isEditing) this.selected.exitEditing();
    this.simpleMode = enabled;
    this.canvas.selection = !enabled;
    this.setLocked(this.locked);
  }

  fitSimpleObject(object) {
    object.set({originX:'left', originY:'top', angle:0, skewX:0, skewY:0,
      flipX:false, flipY:false, strokeWidth:0, selectable:false, evented:false});
    if (object.type === 'textbox') {
      object.set({left:0, top:0, width:400, scaleX:1, scaleY:1,
        fontSize:[12,16,24].includes(object.fontSize) ? object.fontSize : 16,
        fontFamily:CanvasEditor.fontFamily, fontWeight:'normal', fontStyle:'normal', textAlign:'left',
        fill:'#000000', backgroundColor:'#ffffff', textBackground:'#ffffff', styles:{}});
      // Fabric recalculates text height when content changes; keep the full-screen box.
      object.set({height:300, editable:false});
    } else {
      // Fit the complete image or QR inside the screen without stretching or cropping.
      const scale = object.isQr ? Math.max(1,Math.floor(300/(object.width/4)))/4 :
        Math.min(400/object.width, 300/object.height);
      object.set({scaleX:scale, scaleY:scale,
        left:Math.round((400-object.width*scale)/2), top:Math.round((300-object.height*scale)/2)});
    }
    object.setCoords();
  }

  layerCanvas(object) {
    this.snapToPixels();
    const visible=this.objects.map(item=>item.visible);
    const surfaces=[this.canvas.lowerCanvasEl,this.canvas.upperCanvasEl];
    const visibility=surfaces.map(surface=>surface.style.visibility);
    const background=this.canvas.backgroundColor;
    this.objects.forEach(item=>{item.visible=item===object;});
    this.canvas.backgroundColor='rgba(0,0,0,0)';
    surfaces.forEach(surface=>{surface.style.visibility='hidden';});
    this.canvas.renderAll();
    const output=this.canvas.toCanvasElement(1,{enableRetinaScaling:false});
    this.objects.forEach((item,index)=>{item.visible=visible[index];});
    this.canvas.backgroundColor=background;
    surfaces.forEach((surface,index)=>{surface.style.visibility=visibility[index];});
    this.canvas.renderAll();
    return output;
  }

  setBackground(color) { this.canvas.backgroundColor=color; this.canvas.renderAll(); this.changed(); }

  /* 工程存 IndexedDB，图片原样保留，不做任何降采样或重编码：
     压缩会改像素尺寸，刷新后图和选框对不齐，而且画质有损。 */
  async exportProject() {
    this.snapToPixels();
    /* fabric v7 的 toJSON() 不再接受 propertiesToInclude，必须用 toObject(props)，
       否则 monoParams / isQr / qrText 会被静默丢弃（v7.4.0 升级后引入的回归）。 */
    const canvas = this.canvas.toObject(['textBackground','monoParams','isQr','qrText']);
    return {version:1, canvas, monoParams:this.objects.map(object=>object.monoParams||null)};
  }

  async importProject(project) {
    if (!project || project.version !== 1 || !project.canvas) throw new Error('工程文件版本不支持');
    await this.canvas.loadFromJSON(project.canvas);
    if(Array.isArray(project.monoParams)) this.objects.forEach((object,index)=>{if(project.monoParams[index]) object.monoParams={...project.monoParams[index]};});
    for (const object of this.objects) if (object.isQr) {
      const width=object.getScaledWidth();
      object.setElement(CanvasEditor.renderQrCanvas(object.qrText));
      object.set({imageSmoothing:false,scaleX:width/object.width,scaleY:width/object.width});
      object.monoParams={...object.monoParams,brightness:0,sharpness:0};
    }
    if (this.simpleMode) {
      if (this.objects.length > 1) this.canvas.remove(...this.objects.slice(0,-1));
      if (this.objects[0]) this.select(this.objects[0]);
    }
    this.setLocked(this.locked);
    this.canvas.requestRenderAll(); this.changed();
  }

  changed() {
    this.objects.forEach(object=>{if(object.type==='textbox')this.normalizeText(object);});
    if (this.simpleMode) this.objects.forEach(object => {
      if (object.type === 'textbox' || object.isQr) this.fitSimpleObject(object);
    });
    this.snapToPixels();
    this.canvas.requestRenderAll();
    this.onChange();
    this.onSelection(this.selected);
  }

  select(object) {
    if (this.locked) return;
    if (object) this.canvas.setActiveObject(object);
    else this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    this.onSelection(this.selected);
  }

  addText(text = '双击编辑文字\n支持中文和换行') {
    if (this.locked) return null;
    if (this.simpleMode) this.clear();
    const object = new Textbox(text, {
      left:40, top:40, width:250, fontSize:16, fontFamily:CanvasEditor.fontFamily,
      fill:'#000000', lineHeight:1.2, splitByGrapheme:true,
      originX:'left', originY:'top', padding:4, backgroundColor:'#ffffff', textBackground:'#ffffff',
    });
    // 文本框默认走固定阈值二值化，避免抖动把文字边缘啃出麻点。
    object.monoParams={mode:'binary',threshold:100,contrast:100,brightness:0,gamma:100,sharpness:100,invert:false};
    this.canvas.add(object);this.select(object);this.changed();
    return object;
  }

  addImage(image, {isQr=false, qrText=''} = {}) {
    if (this.locked) return null;
    if (this.simpleMode) this.clear();
    const first = this.objects.length === 0;
    const scale = isQr ? Math.max(1,Math.floor(300/(image.width/4)))/4 : first ? Math.max(400 / image.width, 300 / image.height) :
      Math.min(200 / image.width, 150 / image.height, 1);
    // Keep an owned canvas source so clones retain pixels after blob URLs or bitmaps expire.
    const source=document.createElement('canvas');
    source.width=image.width;source.height=image.height;
    source.getContext('2d').drawImage(image,0,0);
    const object = new FabricImage(source, {
      left:(400-image.width*scale)/2, top:(300-image.height*scale)/2,
      scaleX:scale, scaleY:scale, originX:'left', originY:'top',
    });
    object.monoParams={mode:'color',threshold:50,contrast:100,brightness:0,gamma:100,sharpness:100,invert:false};
    if (isQr) {
      object.isQr = true; object.qrText = qrText;
      object.set({imageSmoothing:false});
      object.monoParams={mode:'binary',threshold:100,contrast:100,brightness:0,gamma:100,sharpness:0,invert:false};
    }
    if (this.simpleMode) this.fitSimpleObject(object);
    this.canvas.add(object);this.select(object);this.changed();
    return object;
  }

  /* 生成二维码画布：白底静区 + 黑色模块，版本按内容自动取最小，纠错级别 M。 */
  static renderQrCanvas(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const modules = qr.getModuleCount(), quiet = 4, moduleSize = 4;
    const size = (modules + quiet * 2) * moduleSize;
    const source = document.createElement('canvas');
    source.width = size; source.height = size;
    const context = source.getContext('2d');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, size, size);
    context.fillStyle = '#000000';
    for (let row = 0; row < modules; row++)
      for (let column = 0; column < modules; column++)
        if (qr.isDark(row, column))
          context.fillRect((quiet + column) * moduleSize, (quiet + row) * moduleSize, moduleSize, moduleSize);
    return source;
  }

  addQr(text) {
    if (this.locked) return null;
    return this.addImage(CanvasEditor.renderQrCanvas(text), {isQr:true, qrText:text});
  }

  /* 重画选中二维码的图案，保留位置、缩放与旋转。 */
  updateQr(object, text) {
    if (this.locked || !object || object.isQr !== true) return false;
    const kept = object.getScaledWidth();
    object.setElement(CanvasEditor.renderQrCanvas(text));
    object.set({scaleX:kept/object.width, scaleY:kept/object.width, qrText:text});
    object.setCoords();this.changed();
    return true;
  }

  updateSelected(properties) {
    if (this.locked || !this.selected) return;
    if (Object.hasOwn(properties,'fontSize')) this.textZoomSizes.delete(this.selected);
    this.selected.set(properties);
    this.selected.setCoords();
    this.changed();
  }

  removeSelected() {
    if (this.locked || !this.selected) return;
    const object=this.selected;
    if (object.isEditing) object.exitEditing();
    this.canvas.remove(object);this.select(null);this.changed();
  }

  async duplicateSelected() {
    if (this.locked || !this.selected) return;
    const source=this.selected;
    const object=await source.clone();
    if (this.locked || !this.objects.includes(source)) return;
    object.set({left:source.left+12,top:source.top+12});
    this.canvas.add(object);this.select(object);this.changed();
  }

  moveSelected(direction) {
    if (this.locked || !this.selected) return;
    const index=this.objects.indexOf(this.selected);
    this.canvas.moveObjectTo(this.selected,Math.max(0,Math.min(this.objects.length-1,index+direction)));
    this.changed();
  }

  clear() {
    if (this.locked) return;
    if (this.selected?.isEditing) this.selected.exitEditing();
    this.canvas.remove(...this.objects);this.select(null);this.changed();
  }

  setLocked(locked) {
    if (this.selected?.isEditing) this.selected.exitEditing();
    this.locked=locked;
    for(const object of this.objects) {
      object.set({selectable:!locked && !this.simpleMode,evented:!locked && !this.simpleMode});
      if(object instanceof Textbox) object.editable=!locked && !this.simpleMode;
    }
    this.canvas.skipTargetFind=locked || this.simpleMode;
    this.canvas.requestRenderAll();
    this.onSelection(this.selected);
  }

  exportCanvas() {
    const active=this.selected;
    if (active?.isEditing) active.exitEditing();
    this.canvas.discardActiveObject();
    this.snapToPixels();
    const output=this.canvas.toCanvasElement(1,{enableRetinaScaling:false});
    if(active) this.canvas.setActiveObject(active);
    this.canvas.requestRenderAll();
    return output;
  }

  transformSelected(factor=1, delta=0, anchor={x:200,y:150}) {
    const object=this.selected;
    if(!this.canTransformSelected || !Number.isFinite(factor) || factor<=0) return;
    if (this.simpleMode) delta = 0;
    const radians=delta*Math.PI/180,center=object.getCenterPoint();
    if (object.type==='textbox') {
      const previous=this.textZoomSizes.get(object);
      const start=previous?.rendered===object.fontSize ? previous.desired : object.fontSize;
      const desired=Math.max(8,Math.min(200,start*factor));
      const fontSize=Math.round(desired);
      this.textZoomSizes.set(object,{desired,rendered:fontSize});
      if(fontSize===object.fontSize && delta===0)return;
      factor=fontSize/object.fontSize;
      object.set({fontSize,angle:object.angle+delta});
    } else {
      if(object.type==='activeselection' && object.getObjects().some(item=>item.type==='textbox'))factor=1;
      object.set({scaleX:Math.max(.01,Math.min(40,object.scaleX*factor)),
        scaleY:Math.max(.01,Math.min(40,object.scaleY*factor)),angle:object.angle+delta});
    }
    const x=(center.x-anchor.x)*factor,y=(center.y-anchor.y)*factor;
    object.setPositionByOrigin(new Point(anchor.x+x*Math.cos(radians)-y*Math.sin(radians),
      anchor.y+x*Math.sin(radians)+y*Math.cos(radians)),'center','center');
    object.setCoords();this.changed();
  }

  bindGestures(element, preview) {
    const pointers=new Map();let gesture=null,drag=null,suppress=false,sessionObject=null;
    const reset=()=>{pointers.clear();gesture=drag=null;suppress=false;sessionObject=null;};
    const point=event=>{
      const rect=element.getBoundingClientRect();
      return {x:(event.clientX-rect.left)*400/rect.width,y:(event.clientY-rect.top)*300/rect.height};
    };
    const shape=()=>{
      const [a,b]=[...pointers.values()];
      return {x:(a.x+b.x)/2,y:(a.y+b.y)/2,distance:Math.max(1,Math.hypot(b.x-a.x,b.y-a.y)),
        angle:Math.atan2(b.y-a.y,b.x-a.x)*180/Math.PI};
    };
    element.addEventListener('pointerdown',event=>{
      if(this.locked || (this.simpleMode && !this.canTransformSelected)) return;
      if(sessionObject && sessionObject!==this.selected) reset();
      const at=point(event);pointers.set(event.pointerId,at);
      if(!this.selected && !preview) {
        const target=this.canvas.findTarget(event, true);
        if(target) this.select(target);
      }
      sessionObject=this.selected;
      if(this.selected && (preview || event.pointerType !== 'touch')) {
        event.preventDefault();element.setPointerCapture(event.pointerId);
        drag={x:at.x,y:at.y,left:this.selected.left,top:this.selected.top};
      }
      if(pointers.size===2 && this.selected) {
        if (this.canvas._currentTransform) this.canvas.endCurrentTransform(event);
        event.preventDefault();event.stopImmediatePropagation();
        gesture=shape();drag=null;suppress=true;
      }
    },true);
    element.addEventListener('pointermove',event=>{
      if(!pointers.has(event.pointerId)) return;
      if(!this.canTransformSelected || sessionObject!==this.selected) { reset();return; }
      const at=point(event);pointers.set(event.pointerId,at);
      if(gesture && pointers.size>=2) {
        event.preventDefault();event.stopImmediatePropagation();
        const next=shape();
        this.transformSelected(next.distance/gesture.distance,next.angle-gesture.angle,gesture);
        this.updateSelected({left:this.selected.left+next.x-gesture.x,top:this.selected.top+next.y-gesture.y});
        gesture=next;
      } else if(drag && this.selected && !suppress) {
        event.preventDefault();
        this.updateSelected({left:drag.left+at.x-drag.x,top:drag.top+at.y-drag.y});
      }
    },true);
    const end=event=>{
      if(!pointers.has(event.pointerId)) return;
      if(!this.canTransformSelected || sessionObject!==this.selected) { reset();return; }
      const wasDragging=!!drag;
      pointers.delete(event.pointerId);gesture=null;drag=null;
      if(pointers.size===1) {
        const at=[...pointers.values()][0];
        drag={x:at.x,y:at.y,left:this.selected.left,top:this.selected.top};
        suppress=false;
      }
      if(wasDragging) this.changed();
      if(!pointers.size)reset();
    };
    for(const type of ['pointerup','pointercancel','lostpointercapture'])element.addEventListener(type,end,true);
    element.addEventListener('wheel',event=>{
      if(!this.canTransformSelected) return;
      event.preventDefault();
      const rotate=event.shiftKey && !this.simpleMode;
      this.transformSelected(rotate?1:Math.exp(-event.deltaY*.0015),rotate?event.deltaY*.1:0,point(event));
    },{passive:false});
  }
}
