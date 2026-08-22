# 架构与运行时

## 总体结构

```text
HTTPS 静态资源服务（tools/https_diagnostics_server.py）
  ├─ 模拟器静态文件（HTML/JS/Wasm/Worker，内容哈希版本化）
  ├─ 游戏库 catalog.json 与每游戏 manifest.json
  ├─ XP3 原文件（resource-map 按需供给，支持 Range）
  └─ 预转码视频 /videos/<gameId>/<stem>.mp4
                    │
                    ▼
第三方 Android WebView 89（腾讯 TBS 宿主）
  ├─ 单文档 UI（apps/web）：游戏库 │ 下载 │ 存档 │ 设置 + 内嵌播放器
  ├─ 联网打开时预载引擎 JS/Wasm 到当前文档（同页断网模型）
  ├─ D2 下载器：分块下载、哈希校验、断点续传（无 Worker，主线程）
  ├─ IndexedDB：不可变游戏分块（krkr2web 库）+ 可变存档（IDBFS）
  ├─ 存储桥（storage.js）：Asyncify 分块读取 + 预取流水线
  └─ KRKR2 Wasm 引擎：优先 Dedicated Worker + OffscreenCanvas，
     能力不足自动回退主线程 baseline 变体（目标实机即 baseline）
```

## 目标环境硬约束（实机确认，不可按现代浏览器假设）

**不可用的能力与替代路线：**

| 能力 | 原因 | 本项目替代方案 |
| --- | --- | --- |
| JSPI | Chromium 137 起才支持 | 单线程 Wasm + Asyncify |
| Wasm 原生异常 | Chromium 95 起 | Emscripten 旧式 JS 异常模型 |
| Wasm reference types / GC | Chromium 96 起 | 编译期关闭/降级 |
| Memory64、Wasm SIMD | 高于 89 基线 | 32 位线性内存 + 标量代码 |
| SharedArrayBuffer / 跨源隔离 | 宿主未开放（COOP/COEP 已排除为原因） | 禁用 pthreads |
| Service Worker | 腾讯 TBS 046295 注册失败 | 同页断网模型（见下） |
| OPFS / File System Access | 高于 89 或宿主不允许选文件 | IndexedDB 分块 |
| WebCodecs | 高于 89 基线 | `<video>` 硬解或 Wasm 解码 |

**可用并已实机验证：** WebAssembly（含 i64/BigInt 互操作）、WebGL 1/2、
Web Audio、Fetch、普通 Dedicated Worker、Cache Storage、IndexedDB（配额约
27.19 GiB，5 GB 数据过 App 关闭与整机重启保留）、H.264/VP8/VP9 硬解。

## 运行时形态

引擎始终是**单个单线程 Wasm 实例**（Asyncify 文件桥），但有两种宿放形态
（`engine/worker-runtime-contract.json` 是机器可读契约，
`tools/check_worker_contract.py` 在构建期拒绝违规）：

1. **Worker 变体**（`apps/web/engine-worker-host.js` + `engine-worker.js`）：
   画布 `transferControlToOffscreen` 移交 Worker，页面只保留 DOM 媒体、音频、
   输入捕获与生命周期控制。启动前做能力探测（Worker / OffscreenCanvas /
   canvas 移交 / IndexedDB / Offscreen WebGL），任一不满足即回退。
2. **Baseline 变体**：引擎直接在页面主线程实例化。目标 WebView 89 实机运行
   此变体；桌面 headless 调试也须屏蔽 worker host 强制 baseline（见
   [排障手册](06-troubleshooting.md)）。

两种变体共用同一份 wasm 与同一套页面钩子
（`krkr2webVideo*`、`krkr2webDialog*`、`krkr2webEngineHeartbeat/Quit`）。

## 文件读取桥与存储层

KRKR2 与多数原生库按同步模型工作，IndexedDB 只能异步访问，而宿主无共享内存，
因此采用**单线程 Wasm + Asyncify**：C++ 文件读取挂起 Wasm 调用栈，JavaScript
异步读取 IndexedDB 分块并复制所需范围，完成后恢复执行。XP3 永不整体进入 Wasm
堆。

存储分两层，职责互斥：

- **不可变游戏资源**：`krkr2web` IndexedDB 库，4 MiB 分块（ADR-001），键为
  `[gameId, version, packageId, chunkIndex]`。唯一真相，不进 Cache Storage
  （ADR-004）。
- **可变存档**：Emscripten IDBFS 挂载于 `/savedata/<gameId>/`，独立于游戏资源
  数据库；删除游戏资源默认不删除存档。

存储桥（`probes/d3-engine/web/storage.js`，产品内置于 `/play/storage.js`）要点：
持久 IndexedDB 连接（不再逐块开合）、全部操作 20 秒超时、事务 `onabort` 拒绝
路径、挂起操作追踪（`window.krkr2webStorageTrace`，看门狗警报附带）。

## 预取与解码流水线（补丁 0079/0080/0081 起）

目标设备单线程，"点击下一步"的并行只能来自浏览器原生多线程与时间转移：

- **数字后继预测**：引擎对尾号数字的存储名做 +1/+2 预测打开（语音库与编号 CG
  的通用命名规律），预测打开零 IO，页面据此提前拉取。
- **双公园**：段公园（已解压字节，LRU）+ 图像公园（已解码 BGRA），按内容寻址，
  引擎命中即一次 memcpy；跨重启保留。
- **原生解码**：首见 WebP 经 `createImageBitmap` 在解码 Worker 内解码（主线程
  仅约 2 ms 拷贝），失败回落 wasm libwebp。
- **解压池**：持久化 Inflate Worker 池，规模 `min(4, max(2, 核数-2))`。
- 预取并发 2、20 秒超时、按引擎代际取消；预取读过的块进入与引擎共享的块 LRU。

诊断报告 `snapshot().prefetch.metrics` 提供
`notifyOpens/predictedOpens/prefetchedFiles/segmentParkHits/imageParkHits/nativeDecodes`
计数，配合引擎 PERF 直方图（`KRKR2WEB_D5_PERF`）验证效果。

## 同页断网模型（ADR-006）

目标宿主无法注册 Service Worker，且断网后任何 URL 变化都会被替换为网络错误页。
因此产品是**单文档应用**：

- 联网打开游戏库时在当前文档预载引擎 JS/Wasm（约 7 MiB）。
- "启动游戏"与"返回游戏库"只切换同一 HTML 文档内的 UI 与 Canvas，禁止修改
  `location`、点击站内链接或重新加载。
- 断网启动阶段零网络请求；XP3 只从 IndexedDB 读取。
- Catalog 联网时刷新并保存到本机；断网时只用最后一次保存的目录。

## 内存与性能

原则：4 GB 游戏资源只占磁盘不占常驻内存；禁止整文件 `ArrayBuffer`/Blob 副本、
无上限缓存、下载-哈希-写库同时保留多份完整块。Android 的 4 GB 是整机物理内存，
WebView 进程工作集目标控制在 1.2 GB 以下，最终以"系统不杀进程"为准。

当前实际运行值（引擎 profile + 补丁 0040/0081）：

| 项 | 值 |
| --- | --- |
| Wasm 初始内存 | 64 MiB（profile `initialWasmMemoryBytes`） |
| Wasm 上限 | 512 MiB（profile `maximumWasmMemoryBytes`） |
| 图形缓存 | 160 MiB（`-gclim` 可覆盖） |
| XP3 段缓存 | 16 MiB |
| IndexedDB 块缓存（页面侧） | 按设备内存 64/128/256 MiB 分层 |
| 段公园 / 图像公园 | 24 / 48 MiB LRU（按设备内存分层） |
| 音频队列 | 32 × 125 ms = 4 s，补给 lookahead 250 ms |

性能观测：引擎每 5 s 输出 `KRKR2WEB_D5_PERF` 逐帧耗时直方图；转场中点输出
`KRKR2WEB_D5_TRANS_STATS`；图形加载 ≥50 ms 输出 `KRKR2WEB_D5_LOAD`；引擎
约 1 Hz 心跳（每 4 tick）配合页面看门狗区分"挂起等待"与"主线程阻塞"。

## 构建约束

- 工具链锁定：Emscripten 3.1.64（`.toolchains/emsdk`，emsdk 提交见
  `toolchains/d0-toolchain.lock.json`），Node 18.20.3 随 emsdk。
- 链接时声明 Chrome 89 为最低浏览器目标；构建扫描确认不含 pthreads、共享内存、
  SIMD、JSPI、Wasm 原生异常或 reference types。
- 使用 32 位 Wasm 线性内存与 64 位文件偏移；块键、偏移禁止 32 位位运算。
- Asyncify：先用保守插桩保证正确，收窄范围前必须先看 `ASYNCIFY_ADVISE` 输出，
  且不得在没有覆盖间接调用与异常路径自动测试的情况下启用
  `ASYNCIFY_IGNORE_INDIRECT` 或手写过窄的 `ASYNCIFY_ONLY`。
- 所有资源同源；COOP/COEP 头保留（利在现代浏览器），但不得视为目标宿主开启
  共享内存的条件。
