# Fabric.js

Version: 7.4.0 (MIT). Source: https://registry.npmjs.org/fabric/-/fabric-7.4.0.tgz

`fabric.js` is the published `dist/index.min.mjs` ES module, renamed for this site’s JavaScript MIME configuration. Only the unavailable source-map reference is removed. No runtime CDN dependency. Keep `fabric.LICENSE` with the bundle.

# qrcode-generator

Version: 1.4.4 (MIT). Source: https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-1.4.4.tgz

`qrcode.js` is the upstream UMD bundle with an ESM export appended, so `canvas-editor.js` can import it directly. No runtime CDN dependency. Keep `qrcode.LICENSE` with the bundle.

# gl-waveform

Version: 5.3.0 (MIT, (c) 2018 Dmitry Yv). Source: https://github.com/dy/gl-waveform, upstream commit d17e71c.

`gl-waveform.js` is the upstream `index.js` ESM module, copied byte-for-byte. WebGL2, no dependencies. `index.html` imports it from a module script and hands the class to the inline page script through `window.GlWaveform`; the page builds a 60-second sample grid, draws temperature and humidity as two channels on one WebGL2 context, and queries the min/max pyramid through `range` on every pan and zoom. Browsers without WebGL2, or a failed module load, keep the page's original Canvas 2D curves. See the About tab for the attribution link.

# localForage

Version: 1.10.0 (Apache-2.0). Source: https://registry.npmjs.org/localforage/-/localforage-1.10.0/dist/localforage.min.js

`localforage.js` is the upstream minified UMD bundle with `export default window.localforage;` appended, so `image-app.js` can import it directly. 壁纸工程带着图片数据，体积远超 localStorage 的 5 MB 配额，因此工程存到 IndexedDB（localForage 默认驱动），localStorage 只留旧版本工程的迁移读取。No runtime CDN dependency. Keep `localforage.LICENSE` with the bundle.
