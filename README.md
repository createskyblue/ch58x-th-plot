# ch58x-th-plot · 温湿度趋势仪 Web 上位机

配套 CH584F 墨水屏温湿度计（TH-Plot）的浏览器上位机：基于 **Web Bluetooth**，不装 App、不接线，
用 Chrome / Edge 打开页面直连设备，看即时温湿度、拉全部历史并画曲线、导出 CSV、改设备设置。

纯静态前端：零后端、零依赖安装（three.js 走 CDN），数据全部在浏览器本地解密处理。

## 功能

| 功能 | 说明 |
|---|---|
| 即时测量 | 连接后自动读一次当前温湿度，之后随时点「立即读取」刷新 |
| 全部历史 | 通过蓝牙拉取设备保存的全部历史点（长期区 + 最近分钟区），带进度、可取消 |
| 曲线交互 | 主图滚轮缩放、悬停读数；缩略图拖动两端改范围、拖动选区平移、滚轮缩放 |
| 导出 CSV | 一键导出带时区的时间 / 温度 / 湿度三列 CSV |
| 导入测试历史 | 选择上位机导出的 CSV 先本地预览（不连设备）；激活后可通过蓝牙替换设备历史，用来验证屏幕绘图 |
| 激活码 | 写入并回读设备激活码；历史数据必须用 32 字节激活码在本地解密 |
| 设备设置 | 激活后读取 / 修改历史颗粒度（30 天 5 分钟 / 7 天 1 分钟）与变化刷新开关 |
| 屏幕范围 | 激活后读取设备当前显示档位，并直接切换 1 小时～30 天共 12 档 |
| 重启设备 | 远程软件复位，用于固件更新后重启或从卡死状态恢复（复位后蓝牙关闭，需长按设备按键重开） |
| 固件版本 | 连接时显示固件编译时间，确认机器上跑的是哪一版 |
| 3D 预览 | 首屏用 three.js 展示设备外观与墨水屏刷新序列动画 |

## 运行

ES module 不能从 `file://` 加载，Web Bluetooth 也要求安全上下文（HTTPS 或 `localhost`），
所以要么起个本地静态服务器，要么用 GitHub Pages 之类的 HTTPS 站点：

```bash
# 在仓库根目录
python -m http.server 8000
# 浏览器打开 http://localhost:8000/
```

要求 Chrome / Edge 桌面版（Web Bluetooth 支持列表见
<https://caniuse.com/web-bluetooth>）。iOS Safari 与 Firefox 不支持 Web Bluetooth，打不开设备连接。

操作流程：长按设备按键 3 秒打开蓝牙窗口 → 页面点「连接温湿度计」→ 选名字为 **TH-Plot** 的设备。

### GitHub Pages 部署

仓库根目录就是站点根目录，`index.html` 直接在根，开启 Pages 后即可用 HTTPS 访问，
手机 / 平板也能连（前提是浏览器支持 Web Bluetooth）。

## 目录结构

```
index.html            页面结构、样式与图表 / 3D 渲染逻辑
app.mjs               主逻辑：连接、读取、曲线、导出、导入、设置
protocol.mjs          TinyFrame 封装、CRC16、ChaCha20 解密、历史接收器
history-import.mjs    CSV 解析、导入分片、CRC32 校验
model-debug.html      3D 模型开发用：逐 mesh 输出包围盒 / 变换
model-inspect.html    3D 模型开发用：着色预览各部件
assets/               ink-display.fbx 模型、epaper-sequence/ 墨水屏刷新帧序列
docs/ble-protocol.md  BLE 协议说明：通道、帧格式、指令表、激活与设置
samples/              历史导出 CSV 示例，可直接用于「导入测试历史」的本地预览
```

## 协议与加密

- 设备蓝牙名 **TH-Plot**，服务 `FFE0`：`FFE1` Write、`FFE4` Notify。
- 帧格式 `01 | ID[2] | LEN[2] | TYPE[1] | HEADER_CRC[2] | PAYLOAD[LEN] | BODY_CRC[2]`，
  字段与指令表见 [docs/ble-protocol.md](docs/ble-protocol.md)。
- 历史只以 ChaCha20 密文从设备导出，每帧一个 12 字节随机 nonce，
  浏览器收到后校验分片偏移、总数与 nonce 重复，再在本地解密绘图；设备不提供明文接口，
  也没有解密指令。
- 页面的 `protocol.mjs` 只包含解密原语，**不含盐和密钥派生算法**，也不使用 localStorage：
  激活码与设备绑定，存在设备里，换手机换电脑都能读回。

## 许可证

MIT License，见 [LICENSE](LICENSE)。Copyright (c) 2026 createskyblue。
