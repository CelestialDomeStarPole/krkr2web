# Kirikiroid2-Web 优化迁移到 Chrome 89 —— 开发记录

本文档记录从 `参考资料/开源项目/kirikiroid2-web` 向本仓库（Chrome 89 / 腾讯 TBS
WebView）迁移优化方法的全过程：已批准计划、阶段状态、关键决策、桌面验证结果，
以及用于长任务上下文压缩的恢复点。

## 状态

- 状态：进行中
- 目标环境：Chrome 89（桌面验证代替真机，真机待后续提供）
- 计划批准：2026-08-22 用户确认
- **开发位置**：Windows 侧 `D:\Code\FuckChangyan\krkr2web`（构建工具链
  `tools/build_d3.ps1` + `.toolchains/` 都是 Windows 形态；WSL `~/krkr2web` 是
  规划会话副本，阶段结束时手工回写同步）。

## 范围与铁律

1. 只迁移不依赖 JSPI / OPFS / SharedArrayBuffer / Service Worker / Wasm 原生异常
   / SIMD 的优化方法。
2. 所有引擎改动必须固化为 `engine/patches/NNNN-*.patch` 并登记
   `engine/upstream.json`。
3. **当前验证方式**：所有验证在电脑上运行（本地 Chrome / headless / Node 冒烟），
   不做真机验证；真机结论待后续补测。
4. 每完成一个阶段，必须更新本文档“阶段状态”与“上下文压缩点”，确保后续可恢复。
5. **逐阶段免全量验证**（2026-08-23 用户指示）：每轮开发只需保证构建通过 +
   必要的最小自检，随后直接 commit；不再逐阶段跑全量冒烟。全部优化项
   （P0-1～P2-2）完成后统一审计：一次性跑全套桌面验证（d3 冒烟 ×4、
   unittest、产物检查）并复核各阶段结论。

## 已批准迁移清单

| 编号 | 优化项 | 优先级 | 状态 |
|---|---|---|---|
| P0-1 | 主循环 RAF 帧率限制 | P0 | **已完成**（2026-08-23 桌面验证通过；统一审计通过） |
| P0-2 | `TVPGetRoughTickCount32` 软件锁相环 | P0 | **已完成**（2026-08-23，构建+引擎闭环冒烟通过） |
| P0-3 | 文件读取“大读直读、不污染 LRU” | P0 | **已完成**（2026-08-23，直读路径+回归冒烟通过） |
| P1-1 | WebGL shader 精度修复 | P1 | **已完成**（2026-08-23，重写生效下闭环冒烟通过） |
| P1-2 | 跨标签页引擎单例（Web Locks） | P1 | **已完成**（2026-08-23，双标签真会话验证通过） |
| P1-3 | 早期日志捕获（`?debugEarlyLogs=1`） | P1 | **已完成**（2026-08-23） |
| P1-4 | `TVPExitApplication` 退出对齐 | P1 | **已完成**（2026-08-23，补丁 0084） |
| P2-1 | UI 资源是否仍整体 preload（调研） | P2 | **已完成**（结论：无对应物，不采纳） |
| P2-2 | 构建脚本 ccache / 参数化（可选） | P2 | **已决策：不实施**（理由见阶段记录） |

不迁移：JSPI、OPFS 主链路、pthreads/SAB、Service Worker/PWA、Cocos2d-x 专属
shared-memory 预分配降档。

## 阶段状态

### 阶段 0：文档与准备

- [x] 创建本文档
- [x] 确认桌面构建/测试命令可用（2026-08-23：`tools/build_d3.ps1` 增量构建
  exit 0，产物校验通过：Asyncify 启用、无 pthreads/SAB/SIMD/JSPI/Wasm EH；
  冒烟测试经 `python tools/https_diagnostics_server.py` 纯 HTTP 模式 +
  `node tests/d3_*_smoke.js` 执行）
- [x] 确定每个补丁编号（0082+；P0-1→0082、P0-2→0083、P1-4→0084，其余按序）

### 阶段 P2-1：UI 资源 preload 调研

- 状态：**已完成**（2026-08-23，结论：本项目无整体 preload 机制，无优化对象）
- 调研结论：
  - 参考项目的优化点是它自己的打包历史：用 `assets.zip`（整包下载为
    Blob + VLFS 按需切片读取、不驻留解压内存）取代 emscripten
    `--preload-file index.data`（启动时把全部资源物化进 wasm 堆常驻）。
  - 本项目从未使用 --preload-file/index.data 等价物：shell UI 资源极简
    （1 个 55KB 默认封面 PNG 惰性 `<img>`、内联 SVG 图标、单个 CSS）；
    引擎 preload() 只取 wasm 单文件并做清单校验；游戏数据走 IndexedDB
    分块按需读取（P0-3 后大读直读不污染 LRU）——已等价于参考项目
    VLFS 的惰性模型。
  - 因此无需迁移任何代码；记录结论备查。

### 阶段 P2-2：构建脚本 ccache / 参数化（可选）

- 状态：**已决策：不实施**（2026-08-23）
- 理由：
  - 本机（Windows）未安装 ccache/sccache；引入需在 .toolchains 供应商化
    并处理与 cmake PCH + Asyncify 的组合风险，验证成本高。
  - 全量重建仅在指纹变化（补丁登记/上游提交变化）时发生，每轮引擎补丁
    一次约 8 分钟；日常开发走 ninja 增量（秒级）。收益不抵风险。
  - 若未来补丁频率显著提高，再评估 `CMAKE_<LANG>_COMPILER_LAUNCHER`
    接 ccache 的方案。

### 阶段 P0-1：主循环 RAF 帧率限制

- 目标：`krkrsdl2_run_main_loop` 按目标帧率（默认 20 FPS）节流，音频低水位放行。
- 参考：`kirikiroid2-web/platforms/web/jspi_jsc_mainloop_fix.js`
- 涉及：`engine/patches/0082-web-main-loop-frame-rate-limit.patch`、`engine/upstream.json`
- 状态：**已完成**（2026-08-23，补丁 0082 + 探针/测试基础设施修复，全套桌面验证通过；见上下文压缩点）
- 实现要点：
  - 改上游 `src/core/sdl2/SDLApplication.cpp`：`krkrsdl2_run_main_loop` 安装
    RAF 时间戳捕获包装（`globalThis.__tvpRafT`，幂等，P0-2 复用），读目标帧率
    （`globalThis.krkr2webTargetFps` > `?fps=` URL 参数 > 默认 20），注册
    `emscripten_set_main_loop(process_events_frame_gated, 0, 0)`。
  - 门控：累加器消费 RAF 时间戳（与参考实现同策略：>1s 挂起积压清零、保留
    小数余量支持非整除帧率）；音频低水位（任一播放流未消费缓冲单元 < 4，即
    <500ms）时绕过门控放行，节流不可能造成音频断流。
  - 新增 `sound/sdl2/OpenALWaveMixer` 的 `TVPWebAudioRemainBelow(threshold)`
    （遍历 `tTVPAudioRenderer::_streams`，仅统计 `IsPlaying()` 的流）。
  - 诊断计数器：`globalThis.krkr2webFrameGateTicks` / `krkr2webFrameGateSkips` /
    `krkr2webFrameGateFps`（冒烟断言用）。
  - Worker 变体：无 RAF 时 `__tvpRafT` 恒 -1，门控回退 `performance.now()`，
    emscripten 主循环在 worker 内本就以 setTimeout 驱动，门控同样生效。
  - 新增冒烟：`tests/d3_frame_limit_smoke.js`（fps=10/默认 20/全局覆盖 30 三档
    断言 tick 速率与跳帧计数）。

### 阶段 P0-2：tick 软件锁相环

- 目标：`TVPGetRoughTickCount32` 使用 RAF 时间戳 PLL，减少脚本计时抖动。
- 参考：`kirikiroid2-web/cpp/core/environ/web/Platform.cpp`
- 涉及：`engine/patches/0083-web-tick-software-pll.patch`、`engine/upstream.json`
- 状态：**已完成**（2026-08-23，构建 + 引擎闭环冒烟通过）
- 实现要点：
  - PLL 状态与 `TVPWebFrameTickUpdate()` 落在
    `external/krkrz/utils/TickCount.cpp`（`__EMSCRIPTEN__` 守卫，原生 SDL 路径
    仍走 `SDL_GetTicks()`）；声明在 `TickCount.h`。
  - 驱动点：`process_events_frame_gated` 顶部（每个 RAF 都驱动，含门控跳帧），
    锁相环连续跟踪 vsync 栅格；帧门控决定逻辑帧何时采样——逻辑帧 tick 以
    栅格槽位为单位均匀推进（Choreographer 等价行为，按门控帧率采样）。
  - 域简化：本构建原始时钟 `emscripten_get_now()` 与 RAF 时间戳同为页面相对
    毫秒，无需参考实现里的 `performance.timeOrigin` 换算。
  - 逐点对齐参考实现：离群帧间隔(2~250ms 外)丢锁重同步、栅格内 0.1 慢相位
    跟踪、n 槽位预测、双重单调护栏（PLL 域内 + 域切换钳制，2^31 以上视为
    mod 2^32 真回卷放行）、RAF 停摆 >50ms 回退原始时钟。
  - 单线程适配：`emscripten.h` 只在 `__EMSCRIPTEN_PTHREADS__` 下声明
    `emscripten_is_main_runtime_thread`，用 `TVPWEB_IS_MAIN_THREAD()` 谓词宏
    （pthread 变体走 `emscripten/threading.h`，单线程恒真）。
- 本轮自检（按新工作流规则，未跑全量）：build_d3.ps1 全量重建 exit 0、
  产物检查通过、`d3_browser_smoke` exit 0；PLL 量化效果留待统一审计。

### 阶段 P0-3：大读直读不污染 LRU

- 目标：`storage.js` 对 ≥1 MiB 读直接从 IndexedDB 拼装返回，不放入块 LRU。
- 参考：`kirikiroid2-web/platforms/web/vlfs.js` 的 `DIRECT_READ_THRESHOLD`
- 涉及：`probes/d3-engine/web/storage.js`（单一源；d4/d5 产品打包时由
  `tools/prepare_d4_product.ps1` / `prepare_d5_product.ps1` 复制为 `play/storage.js`，
  仓库内无独立副本）
- 状态：**已完成**（2026-08-23，直读路径验证 + 回归冒烟通过）
- 实现要点：
  - 阈值 `DIRECT_READ_THRESHOLD = 1 MiB`（批准计划值；参考实现用 512 KiB）。
  - `readToHeap`：`length ≥ 阈值` 且**未整段命中缓存**时走新增的
    `loadChunkRangeDirect`——与 `loadChunkRange` 相同的单事务 IndexedDB 取块，
    但不 populate、不触碰 LRU 递进度，大流式读（视频/大资源）无法驱逐
    点击下一步依赖的热门预取块。
  - 整段已缓存的大读仍走缓存路径（预取过的大文件保持纯命中，与
    0079/0080 预取流水线兼容）；`readRange`/`prefetchRange` 预取路径
    保持原样（预取的目的就是暖缓存）。
  - 新增指标 `directReads` / `directBytes`（随 snapshot 进入诊断报告）。
- 本轮自检（未跑全量）：`node --check`；一次性持久化 profile 两阶段脚本
  验证：冷缓存大读 directReads=1 且 cacheEntries 不变、重复大读仍直读
  （证明未污染）、小读暖块后大读切回缓存路径（directReads 不再增长）；
  `d3_browser_smoke` exit 0。

### 阶段 P1-1：WebGL shader 精度修复

- 目标：`shaderSource` 自动为无精度 `uniform` 补 `highp`。
- 参考：`kirikiroid2-web/platforms/web/shell.html`
- 涉及：`apps/web/player.js`、`apps/web/play/app.js`、
  `apps/web/engine-worker.js`（worker realm）、`probes/d3-engine/web/app.js`
  （探针对齐产品路径）
- 状态：**已完成**（2026-08-23，重写生效下闭环冒烟通过）
- 实现要点：
  - 与参考相同的正则 `/uniform\s+(?!highp\s|mediump\s|lowp\s)(mat[234]|vec[234]|float|int)\s/g`
    → `uniform highp $1`；sampler 不动（部分 GPU 的 fragment 不接受
    highp sampler）、attribute 不动（vertex 默认即 highp）。
  - 包装 `WebGLRenderingContext/WebGL2RenderingContext.prototype.shaderSource`，
    原型上 `__krkr2webPrecisionFixed` 幂等标记。
  - worker 变体在 `engine-worker.js` 顶部装同款（页面原型 patch 覆盖不到
    worker 内 OffscreenCanvas 的 WebGL realm）。
- 本轮自检（未跑全量）：`node --check` ×4；正则 7 用例单测（裸 uniform
  提升、显式精度/sampler/attribute 不动）；D3 探针页装同款后
  `d3_browser_smoke` exit 0（引擎真实 shader 经重写路径编译通过）。

### 阶段 P1-2：跨标签页引擎单例

- 目标：`navigator.locks` 防止多实例同时运行。
- 参考：`kirikiroid2-web/platforms/web/shell.html`
- 涉及：`apps/web/player.js`、`apps/web/play/app.js`（同锁名
  `krkr2web-engine-instance`，两类页面互斥）
- 状态：**已完成**（2026-08-23，双标签真会话验证通过）
- 实现要点：
  - `ifAvailable: true` + 独占模式：拿不到锁即报冲突（不排队）；回调返回
    永不 settle 的 Promise 持锁，成功信号经独立 resolver 同步发出
    （`navigator.locks.request` 本身会一直 pending，不能 await 它判成功）。
  - 生命周期绑定会话而非页面：player.js 在 `startFresh` 前获取，
    `terminateInstance`（stop/forceStop 汇合点）、启动失败 catch、引擎
    `onExit`/`onAbort` 自退时释放；restart 经 stop→startFresh 自然
    释放重取。play 页无原地停止（重启即跳转），持锁到文档销毁。
  - 标签页关闭/崩溃由浏览器自动释放（锁绑定 Document），无需心跳。
  - 缺 API（Chrome 89 与目标 WebView 均已内置）时禁用守卫而非误报冲突。
- 本轮自检（未跑全量）：`node --check` ×2；`prepare_d4_product.ps1
  -SkipEngineBuild` 打包 + 8766 端口带 resource-map 的诊断服务器，真会话
  双标签脚本：tab1 库页安装并启动引擎后，tab2 play 页报“引擎已在其他
  标签页运行”；关闭 tab1 后 tab2 重载正常启动（exit 0）。

### 阶段 P1-3：早期日志捕获

- 目标：`?debugEarlyLogs=1` 捕获早期 console 日志到 sessionStorage。
- 参考：`kirikiroid2-web/platforms/web/shell.html`
- 涉及：`apps/web/index.html`（head 首个内联脚本）、`apps/web/player.js`
  （persistEvidence 并入 earlyLogs）
- 状态：**已完成**（2026-08-23）
- 实现要点：
  - 与参考相同的机制：包装 console.log/warn/error，`[level] ` 前缀 +
    参数 JSON 化，环形缓冲 5000 条，逐条镜像到
    `sessionStorage.__krkr2webEarlyLogs`，暴露 `window.__krkr2webEarlyLogs`。
  - 整段 try/catch 包裹（诊断开关自身绝不能影响启动）。
  - d4 证据接入：`persistEvidence` 把 earlyLogs 尾部 200 条并入
    `krkr2web-d4-last-player`，壳层之前的启动失败进入失败会话证据。
- 本轮自检（未跑全量）：`node --check`；重打包 d4 后浏览器实测：
  带参标记行进入 window 缓冲与 sessionStorage，不带参无任何捕获。

### 阶段 P1-4：TVPExitApplication 对齐

- 目标：非致命 `System.exit()` 不真正退出引擎。
- 参考：`kirikiroid2-web/cpp/core/environ/web/Platform.cpp`
- 涉及：`engine/patches/0084-web-sync-exit-graceful-reroute.patch`、
  `engine/upstream.json`
- 状态：**已完成**（2026-08-23，补丁 0084）
- 实现要点与参考的差异：
  - 本引擎无 `TVPExitApplication` 定义（仅 Platform.h 声明、无人调用）；
    实际危险路径是 `System.exit()` → `TVPTerminateSync` →
    `TVPSystemUninit()+exit()`——无 EXIT_RUNTIME 的 wasm 里内联 exit 会以
    uncaught ExitStatus 冒泡成 abort，宿主页面按崩溃处理。
  - 参考实现选择完全忽略退出（游戏可继续）；本产品语义下游戏正常收尾
    也走 System.exit，忽略会让会话吊死黑屏。故改为**改道**：web 上
    `TVPTerminateSync` 转调 `TVPTerminateAsync`，下一 tick 由主循环拆除
    分支（P0-1 已验证）执行 TVPSystemUninit + krkr2webEngineQuit 通知，
    再取消主循环——同步退出永不接触 exit()，会话仍干净结束。
  - stdout 留一行 `krkr2web: System.exit(N) rerouted ...` 便于追溯
    （走 engineLog 信息环，不进 errors）。
- 本轮自检（未跑全量）：build_d3.ps1 全量重建 exit 0 + 产物检查；
  `d3_browser_smoke` exit 0（含引擎自退→主循环拆除→quit 通知链路回归）。
  System.exit 直达路径的定向验证（临时 probe 标签）留待统一审计。

## 桌面验证约定

- 引擎构建：使用 `.toolchains/emsdk` 的 Emscripten 3.1.64，`emcmake` + Ninja。
- 浏览器冒烟：现有 `tests/d3_*_smoke.js` / `tests/d4_browser_smoke.js`，本地
  Chrome/headless 执行。
- 性能观测：`KRKR2WEB_D5_PERF`、`KRKR2WEB_D5_TRANS_STATS`、`snapshot().prefetch.metrics`。
- 真机验证：暂缓；本文档记录桌面结论，后续实机补测。

## 上下文压缩点

每完成一个阶段后，在此追加：
- 阶段完成日期/提交
- 关键改动文件与补丁号
- 桌面验证结果摘要
- 未解决问题与下一步

### 2026-08-22 初始

- 用户批准完整迁移计划；确认只写计划后进入实施。
- 用户要求：每 30M token 压缩一次上下文；所有验证在电脑上运行，暂不真机。
- 建立本文档作为持久化恢复点。
- **2026-08-23 修订**：压缩频率改为**每 200k token 一次**（用户指示）；其余
  约定不变。同步 WSL→Windows 后开发转到 Windows 侧进行。

### 2026-08-23 阶段 0 完成 + P0-1 实现落地

- 阶段 0：构建/测试命令验证通过（build_d3.ps1 增量 exit 0、产物检查通过）；
  补丁编号确认 0082 起。
- P0-1 补丁 0082 已写入并登记 `upstream.json`（78 个补丁）；快照往返验证
  （对 0081 后基线应用补丁 = 工作树逐字节一致）。
- 工作流备忘：改 `build/d3-engine-work/source` 验证编译（ninja 在
  `.toolchains/d3-build-tools/Scripts/`），快照存 `build/p0082-base/`，
  python difflib 生成补丁（LF）；登记后跑完整 build_d3.ps1 触发重导出全量
  应用。环境陷阱照 docs/06：构建后台任务禁 `2>&1`、EM_JS/EM_ASM 内避免
  花括号级逗号（宏参数分割）。
- **重大环境发现（D3 探针页既有缺陷，与 0082 无关）**：引擎里 TJS
  `Debug.message`（KRKR2WEB_D3_* 标签）经 emval 桥直达浏览器
  `console.log`，**不走 stdout/Module.print**（`-forceoutputlogtoconsole`
  亦无效，因不走 PrintConsole 路径）；探针页 `record()` 只接
  Module.print/printErr → 状态机永远卡 "running"，剧本实际正常推进
  （KAG_TEXT/AUDIO_OPEN/INTERACTIVE_READY 都在 console 里）。修复：
  `probes/d3-engine/web/app.js` 顶部钩 `console.log` 转发 KRKR2WEB_ 行给
  record()。定位手法：playwright addInitScript 包 console.log 抓调用栈
  （`__emval_call` → wasm）。
- 待完成：完整重建（含 0082）→ `prepare_d3_probe.ps1` → HTTP 诊断服务器
  （8765，`--http` 旗标）→ `node tests/d3_frame_limit_smoke.js` +
  `d3_browser_smoke.js` 回归 → 回写 WSL 副本。

### 2026-08-23 P0-1 完成（补丁 0082 + 三处验证基础设施修复）

**引擎改动（补丁 0082，已登记 upstream.json，全量重建通过）**：
`krkrsdl2_run_main_loop` 安装 RAF 时间戳捕获 + 读目标帧率（默认 20）+
注册 `process_events_frame_gated`；音频低水位（<4 个 125ms 缓冲单元）
放行；诊断计数器 `krkr2webFrameGateTicks/Skips/Fps`。Worker 变体回退
`performance.now()`。

**桌面验证结果（全部通过）**：
- `tests/d3_frame_limit_smoke.js`（新增）：`?fps=10`→9.98 tick/s、默认→
  19.96 tick/s、`krkr2webTargetFps=30` 覆盖→29.94 tick/s；跳帧计数正常。
- `tests/d3_browser_smoke.js`：exit 0（启动→输入→选支→存档→重载→恢复
  全流程，含 restored 阶段）。
- `tests/d3_stability_smoke.js`（soakSeconds=5）与
  `tests/d3_enhanced_input_smoke.js`（键盘+手柄）：exit 0，报告上传成功。
- `python -m unittest tests.test_d3_tools`：14/14。
- 诊断服务器注意：`prepare_d3_probe` 后内容版本变化，必须**重启**
  `https_diagnostics_server.py`（resource-map 仅启动时加载），否则
  "Manifest 中的服务器资源已经不存在"。

**验证基础设施修复（探针既有缺陷，与 0082 无关，基线同样复现）**：
1. `probes/d3-engine/web/app.js`：钩 `console.log` 把 KRKR2WEB_ 行以
   `", "` 连接后转发 `record()`（引擎 Debug.message 多参数以 ", " 连接、
   页面 `logArgument` 按逗号切分——空格连接会破坏参数提取）。
2. `probes/d3-engine/game/startup.tjs`：checkpoint 处理器去掉 `return`
   ——KAGParser.store() 的恢复位置会重演 checkpoint 标签，原来停在这里
   导致 `*restored` probe 标签永不执行（与帧率无关的既有缺陷）。
3. `tests/d3_browser_smoke.js`：重载后的等待条件补上 textPhases 含
   "restored"（saveRestored 标签与 restored 文本阶段间隔数个引擎 tick）。

**下一步**：P0-2 tick 软件锁相环（补丁 0083，参考
`kirikiroid2-web/cpp/core/environ/web/Platform.cpp` 的
TVPWebFrameTickUpdate；RAF 时间戳捕获 `__tvpRafT` 已由 0082 铺好）。

### 2026-08-23 P0-2 完成（补丁 0083 软件锁相环）

- **工作流变更（用户指示）**：提交 P0-1（Windows `20c6ae4` / WSL `b11016f`，
  WSL 侧用 `git am` 同步、需先 `git config user.name/email`）；此后每轮开发
  只做构建 + 最小自检即直接 commit，全部完成后统一审计（记入铁律 5）。
- 补丁 0083（`0083-web-tick-software-pll.patch`，7196B）：
  - `external/krkrz/utils/TickCount.cpp/.h`：PLL 状态机 +
    `TVPWebFrameTickUpdate()` + 主线程 `TVPGetRoughTickCount32` 锁相输出；
    `src/core/sdl2/SDLApplication.cpp`：`process_events_frame_gated` 顶部
    每 RAF 驱动（含跳帧）。
  - 快照/生成/往返校验流程同 0082（快照目录 `build/p0083-base`，用后删除；
    `git apply` 往返三文件全 MATCH）。
  - 陷阱 1：单线程构建 `emscripten.h` 不声明
    `emscripten_is_main_runtime_thread`（pthreads 专属）→ 谓词宏
    `TVPWEB_IS_MAIN_THREAD()`。
  - 陷阱 2：改 `#if/#else` 嵌套时数错 `#endif`（clang 报 "unterminated
    conditional directive"）——重排分支后必须重数。
  - 域简化：原始时钟与 RAF 时间戳同为页面相对毫秒，无需 timeOrigin 换算。
- 构建：`upstream.json` 登记（79 个补丁，CRLF 字节级追加）；build_d3.ps1
  全量重建 exit 0，产物检查通过。
- 最小自检：`d3_browser_smoke` exit 0。注意：build_d3.ps1 会清掉
  `build/d3-engine` 里的 `catalog.json`/`resource-map.json`，跑冒烟前需先
  `tools/prepare_d3_probe.ps1`（内容版本未变时无需重启诊断服务器）。
- **下一步**：P0-3 大读直读不污染 LRU（`probes/d3-engine/web/storage.js`，
  参考 `kirikiroid2-web/platforms/web/vlfs.js` 的 DIRECT_READ_THRESHOLD）。

### 2026-08-23 P0-3 完成（storage.js 大读直读）

- 只改 `probes/d3-engine/web/storage.js`（web 侧，无引擎补丁；d4/d5 打包脚本
  复制该文件，仓库无独立产品副本）。`DIRECT_READ_THRESHOLD = 1 MiB`（计划值，
  参考 512 KiB）；`loadChunkRangeDirect` 单事务取块不进 LRU；整段命中缓存的
  大读仍走缓存（预取兼容）；预取路径不动；新指标 directReads/directBytes。
- 自检脚本坑：playwright 每次 launch 是全新 profile（IndexedDB 不跨 launch），
  需 `launchPersistentContext` 两阶段（先装好、再冷缓存页面直调 bridge）；
  D3 的 data.xp3 只有 3 个 chunk，完整启动即全部预热，冷缓存必须不点启动。
- 验证结果：冷缓存 2 MiB 读 directReads=1、cacheEntries 不变；重复大读仍
  directReads=2（未污染）；小读暖块后大读走缓存（directReads 不再增）；
  `d3_browser_smoke` exit 0。一次性脚本已删（build/p03_direct_check.js）。
- **下一步**：P1-1 WebGL shader 精度修复（`apps/web/player.js` /
  `apps/web/play/app.js`，参考 `kirikiroid2-web/platforms/web/shell.html`）。

### 2026-08-23 P1-1 完成（WebGL shader 精度）

- 四处安装同一自包含 IIFE：`apps/web/player.js`、`apps/web/play/app.js`
  （页面 realm）、`apps/web/engine-worker.js`（worker realm，页面原型
  patch 不到 OffscreenCanvas 上下文）、`probes/d3-engine/web/app.js`
  （探针对齐产品，冒烟即回归）。
- 自检：正则单测 7/7（裸 uniform 提升；显式 highp/mediump/lowp、sampler、
  attribute 均不动）；探针页部署后 `d3_browser_smoke` exit 0。
- **下一步**：P1-2 跨标签页引擎单例（Web Locks，`apps/web/player.js`）。

### 2026-08-23 P1-2 完成（Web Locks 引擎单例）

- `apps/web/player.js` + `apps/web/play/app.js`，锁名
  `krkr2web-engine-instance`；player 按会话持有/释放（terminateInstance、
  启动失败 catch、onExit/onAbort），play 页持到文档销毁。
- 关键坑：持锁回调返回 pending Promise 时 `navigator.locks.request` 不
  resolve，成功信号必须走独立 resolver；`ifAvailable` 拿不到锁时回调
  返回 undefined、request resolve undefined（借此时序区分冲突）。
- 验证：d4 产品页（`prepare_d4_product.ps1 -SkipEngineBuild`）+ 8766 带
  resource-map 的诊断服务器，真会话双标签：运行中开新 play 页报冲突、
  关闭引擎标签后重载可启动（exit 0）。注意 d4 安装流程必须服务器带
  `--resource-map`，否则 chunk 校验过不去。
- **下一步**：P1-3 早期日志捕获（`?debugEarlyLogs=1`，`apps/web/index.html`
  + 诊断报告，参考 shell.html）。

### 2026-08-23 P1-3 完成（早期日志捕获）

- `apps/web/index.html` head 首个内联脚本（styles.css 重试 link 之后、
  其余脚本之前）装 console 包装；player.js `persistEvidence` 并入
  earlyLogs 尾 200 条到 d4 失败会话证据。
- 验证：带 `?debugEarlyLogs=1` 标记行入 window 缓冲 + sessionStorage；
  不带参零捕获。一次性脚本已删。
- **下一步**：P1-4 TVPExitApplication 退出对齐（补丁 0084，参考
  `kirikiroid2-web/cpp/core/environ/web/Platform.cpp` 的 TVPExitApplication）。

### 2026-08-23 P1-4 完成（补丁 0084 同步退出改道）

- 改 `src/core/base/sdl2/SysInitImpl.cpp` 的 `TVPTerminateSync`：web 分支
  转调 `TVPTerminateAsync`（原生分支不动）；快照/差分/往返 MATCH，
  upstream.json 登记（80 个补丁），全量重建 + 产物检查 + 冒烟 exit 0。
- 与参考的差异已记录：参考完全忽略 TVPExitApplication；本引擎的对应
  危险点是 System.exit→TVPTerminateSync→exit()，选择改道异步优雅退出
  （正常游戏收尾语义保留），统一审计时补 System.exit 直达路径的
  定向验证。
- **下一步**：P2-1 UI 资源 preload 调研 + P2-2 构建脚本 ccache/参数化
  （可选），随后统一审计。

### 2026-08-23 P2-1/P2-2 完成（调研与决策，无代码）

- P2-1：本项目无整体 preload（从未用 --preload-file；UI 资源极简惰性、
  游戏数据 IndexedDB 分块按需），参考项目的 assets.zip+VLFS 优化无对应
  物，不采纳。
- P2-2（可选项）：决策不实施——无 ccache、PCH+Asyncify 组合风险、全量
  重建低频（每引擎补丁一次），增量构建已覆盖日常。
- 迁移清单 P0-1～P2-2 全部阶段完毕。**下一步：统一审计**——全套桌面
  验证（d3 冒烟×4 含 frame_limit、unittest、产物检查、d4 产品冒烟），
  并补 P1-4 的 System.exit 直达路径定向验证（临时 probe 标签）。

### 2026-08-23 统一审计完成（全部优化项 P0-1～P2-2 收口）

**审计范围与结果（全部通过）**：
1. P1-4 定向验证：startup.tjs 临时在 [end] 处理器加 `System.exit(0)` →
   reroute 日志出现 2 次（重载前后会话各 1 次），引擎优雅退出无 abort，
   冒烟 exit 0；已还原（内容版本回到 content-28bcd…）。
2. d3 全套：`d3_browser_smoke` / `d3_stability_smoke`(soak 5s) /
   `d3_enhanced_input_smoke` / `d3_frame_limit_smoke` 全部 exit 0；
   `python -m unittest tests.test_d3_tools` 14/14；
   `check_d3_artifacts.py`（Asyncify 启用，无 pthreads/SAB/SIMD/JSPI/Wasm EH）通过。
3. d4 产品（重打包含 0084 引擎）：`d4_browser_smoke` exit 0（安装、断网
   零请求启动、存档、返回游戏库、重启、崩溃恢复、强制终止、删除）。
4. worker 变体离线零请求启动专项验证：ready、无网络请求失败。

**审计中发现的既有缺陷（与本次迁移无关，已定位并修复）**：
- 现象：d4 冒烟在当前 Chrome 下离线启动必挂（"Worker fatal"）。
- 定位（三步隔离）：旧 web 文件 + 新引擎同样挂（排除迁移改动）；锁定
  worker host 后离线启动成功（锁定 worker 变体）；网络轨迹显示
  `new Worker()` 与 worker 内 `importScripts` 在 Chrome 离线仿真下即使
  HTTP 缓存有条目也直接 ERR_ABORTED/NetworkError。d4 冒烟写于 worker
  变体存在之前，历史通过时走的是主线程回退路径。
- 修复（产品级，`apps/web`）：
  - `player.js`：preload 在线阶段预取 worker 自身 + storage/prefetch/
    engine 四个脚本文本；`?engineVariant=baseline` 诊断开关（强制主线程
    变体）。
  - `engine-worker-host.js`：`workerScript` 文本 → Blob URL 建 worker；
    `scriptTexts` 随 start 消息下发（wasm 本就经 transfer 直传）。
  - `engine-worker.js`：脚本 URL 先按页面 origin 解析为绝对地址（blob
    基准无法解析根相对路径）；`importWorkerScript` 有文本走 Blob
    importScripts、无文本回退 URL（在线路径不变）。
- 验证：worker 变体离线启动 ready 且零请求失败；d4 冒烟（基线变体）
  全流程 exit 0。
- 测试更新：`d4_browser_smoke.js` 离线断言排除 blob: 加载（内存加载非
  网络）；全流程 URL 追加 `engineVariant=baseline`（存档/崩溃阶段依赖
  主线程 `window.Module`，属冒烟既有假设）。

**遗留（后续工作，非本次范围）**：d4 冒烟对 worker 变体的全流程覆盖
（存档/崩溃恢复需经 worker 桥消息而非 window.Module）；worker 侧存储
指标快照仅在 storage-ready 时上报一次（player 快照中的 worker 存储
readCalls 恒 0，建议随心跳刷新）。

**迁移项目收口**：P0-1～P2-2 全部完成，补丁 0082/0083/0084 已登记
（upstream.json 共 80 个），统一审计通过。

## 2026-08-23 真实 TLS 端点复核（192.168.137.1:443，自签证书）

应用户要求，在真实 HTTPS 部署形态（热点网卡 + 默认 443 端口 + 自签
证书）下复核整轮优化效果。

工具链：

- 证书：`certs/`（开发 CA，SAN 含 192.168.137.1/localhost/127.0.0.1，
  `tools/generate_dev_certificate.py` 产物，有效期至 2027-08）。
- 服务器：`tools/https_diagnostics_server.py` ×2 ——
  `192.168.137.1:443`（build/d4-product + resource-map，供手机/设备直连
  `https://192.168.137.1/`）、`192.168.137.1:8443`（build/d3-engine +
  resource-map，供 d3 冒烟）。
- 新增 `tests/d4_https_optimization_audit.js`：产品级黑盒审计（单浏览器
  上下文五阶段：TLS 完整性/安装/单例/直读/断网）。`d3_frame_limit_smoke`
  与 `d3_stability_smoke` 增加 https 基址支持（URL 为 https 时 launch 级
  追加 `--ignore-certificate-errors`）。

结果全部通过（`build/d4-https-audit/report.json` + 5 张截图）：

1. **TLS 完整性 + P1-3**：22 个首屏请求全 https、无混合内容，版式与
   目录正常；`?debugEarlyLogs=1` 捕获管线验证通过（级别前缀齐全）。
2. **HTTPS 安装**：8.88 MiB 游戏（resource-map Range）完整下载，离线
   资产就绪。
3. **P1-2 跨标签页单例**：tab1 运行引擎时 tab2 `locks.query()` 可见
   `krkr2web-engine-instance`（exclusive）；tab2 启动被拒（状态条"引擎
   已在其他标签页运行"）且 tab1 不受扰；关闭 tab1 后锁自动释放，tab2
   重新启动 worker 引擎成功。
4. **P0-3 大读直读**（页内注入产品 storage 桥实测，4 MiB chunk）：首
   次 4 MiB 大读走直读（LRU 0 条、0 miss/0 hit）；小读正常进 LRU；重复
   小读命中；已缓存大读改走缓存（directReads 不增、hits+1）；尾部
   4 MiB 大读再走直读（directReads=2，LRU 仍 1 条）——"大读不污染
   LRU、预取块保持纯命中"逐条验证。
5. **断网零请求（worker 变体）**：Chrome 离线仿真下启动 worker 引擎：
   0 个服务器请求、phase=running、1.6s 窗内心跳推进；离线点击推进剧情
   （D3_MOUSE_DOWN/HEARTBEAT 1–3）；强制终止干净返回
   （forcedStopCount=1，仍 0 请求）。出现 "Worker fatal" 即判失败（未
   出现）。
6. **P0-1 帧率限制（8443）**：?fps=10 / 默认 / 全局覆盖 30 → 实测
   10.00 / 19.98 / 29.97 ticks/s，门控 skip 数（613/534/488）远超执行
   数，限流真实生效。
7. **P0-2 tick 稳定性（8443）**：稳定性冒烟全部门禁通过，活跃期最大
   心跳间隙 258.7 ms，报告经 TLS 上传成功（20260823-073232-a4acf4b4）。

P0-4（System.exit 优雅改道）与 P1-1（shader 精度）不依赖网络形态，沿用
统一审计的直接验证结论；离线 worker 启动（本轮回补修复）已在 TLS 端点
复验通过。favicon.ico 404 为浏览器自动请求的既有小噪音，不影响断言。

## 2026-08-23 多游戏部署：游戏库自动识别与存档隔离

需求：实际部署中把游戏放进指定目录即可被游戏库自动识别（按文件夹区分）；
浏览器端存档按游戏隔离（IndexedDB）。

改动：

1. `tools/https_diagnostics_server.py`：新增 `GameDirectoryScanner` 与
   `--auto-catalog`——`/catalog.json` 由 `games/<gameId>/<version>/manifest.json`
   实时合成（mtime 指纹缓存，目录变动刷新即生效）；同游戏多版本目录取
   manifest mtime 最新；版本目录内 `meta.json` 可覆盖
   title/description/coverUrl/compatibility；无发现时回落静态 catalog.json；
   开关关闭时行为不变。物理放置于版本目录的 XP3 依据 manifest 自动获得
   206 Range + sha256 ETag + If-Match 服务（分块安装器契约），显式
   resource-map 条目优先。
2. `tools/generate_d2_catalog.py`：catalog 与 resource-map 改为合并模式
   （替换本游戏旧版本条目、保留其他游戏条目）；新增 `--description` /
   `--cover-url` 同时写入版本目录 meta.json 与 catalog 条目。
3. `tools/prepare_d4_product.ps1`：d3-test 元数据同步写 meta.json（443 端点
   `--auto-catalog` 渲染与静态 catalog 一致）。
4. `apps/web/player.js`：`start()` 切换不同 gameId 时先优雅停止当前会话
   （同步存档、释放单例锁，stopReason=switch-game）再启动——修复多游戏库
   下"返回游戏库→启动另一游戏"撞单例锁、要求手动强停的缺口。
5. 存档隔离（既有机制核实为完整，无需改动）：`-datapath=/savedata/<gameId>/`、
   IDBFS 挂载 gameRoot=`/savedata/<gameId>`（worker 与 baseline 同路径）、
   存档管理器按独立 IndexedDB 库 `/savedata/<gameId>` + 前缀过滤读写删。

验证（全部通过）：

- `python -m unittest tests.test_auto_catalog` 9/9：发现与字段合成、多游戏
  排序与 catalogVersion 变化、最新版本胜出、meta 覆盖、坏清单跳过、
  manifest 变更缓存刷新、HTTP 集成（合成 catalog + 物理包 206/Content-Range/
  ETag/错误 If-Match 412）、空发现回落静态、开关关闭保持静态。
- 新增 `tests/d4_multi_game_audit.js`（iso-check 克隆包 + 物理放置 +
  `--auto-catalog` 服务器，测试站点重建命令见脚本头注释）：自动发现 2 游戏
  2 卡片、meta 标题生效、物理包完整安装（自动派生 Range）、两游戏存档各自
  只列自己的存档、`indexedDB.databases()` 显示 /savedata/d3-test 与
  /savedata/iso-check 两个独立库、删除 A 游戏存档不影响 B。
- 回归：443 端点重启为 `--auto-catalog` 模式后 `d4_https_optimization_audit`
  全阶段通过（worker 变体、单例、直读、断网零请求）；`d4_browser_smoke`
  基线全流程 exit 0；`prepare_d4_product.ps1` 重建 + `check_d4_artifacts`
  通过。

已知边界：Git Bash 下 `--cover-url /assets/...` 会被 MSYS 转成 Windows 路径，
命令前加 `MSYS_NO_PATHCONV=1` 或改用双斜杠；文档已注明。

## 2026-08-23 《千恋万花》上架 443 游戏库（游戏文件不入库）

需求：把《千恋万花》加入正式部署的游戏库，且 git 不得跟踪任何游戏文件。

部署形态：443 端点切换为 d5 产品（build/d5-product，含 compat 层与资源版本
戳），`--auto-catalog --resource-map --video-directory --savedata-directory` 全量
挂载。游戏库现在同时列出 D3 self-test（8.9 MB 快装小游戏）与千恋万花
（4.04 GiB）。

游戏文件的隔离（全部被 .gitignore 覆盖，git status 零游戏文件）：

- 三个 XP3 实体只存在于 `参考资料/千恋万花/`（2.31 GB data + 307 MB adult +
  1.42 GB video），经 resource-map 映射服务，从不拷入仓库工作树；
- 清单/meta 与 resource-map 均在 build/ 下；转码视频在 build/video-transcode/
  （1.4 GB）；d5 校验器本来禁止产品树内出现实体 .xp3（check_d5_artifacts），
  d3-test 的包也按同一契约走 resource-map 条目。

改动：

1. `tools/prepare_d5_product.ps1`：senren-banka 版本目录写 meta.json
   （auto-catalog 渲染与静态 catalog 一致）；附带把 d3-test 清单目录并入
   games/（auto-catalog 自动发现）+ 其 data.xp3 以 resource-map 条目接入
   （替换式合并，不破坏 senren-banka 条目）。
2. `tools/start_d5_product.ps1`：默认追加 `--auto-catalog`（-NoAutoCatalog 关闭）。
3. `tools/https_diagnostics_server.py` / `check_d4_artifacts.py` /
   `check_d5_artifacts.py`：resource-map.json 读取改 utf-8-sig（PowerShell
   工具链写出的 BOM 不再炸服务器启动与产物校验）。

验证：

- prepare_d5 重建通过（d4/d5 两级校验；"existing 4.04 GB cache identity
  preserved"）；产品树内无 .xp3。
- 443 实测：auto-catalog 列出双游戏（含 meta 描述/封面）；senren-banka
  manifest 200（75 KB）；2.3 GB data.xp3 Range 206；d3-test 包 206；
  /videos/senren-banka/*.webm 200。
- 浏览器实测：游戏库渲染 2 张卡片，选中千恋万花显示详情与完整下载按钮
  （截图 build/d5-library-senren.png）。
- d3-test meta.json 热更新：写入后无需重启服务器，auto-catalog 立即反映
  （mtime 缓存失效路径实测）。

注：本轮不重新哈希 4 GB 包体（manifest 沿用 content-ebe5177821a6917c7a80，
缓存标识保留，已安装设备无需重新下载）。

## 2026-08-23 真机卡顿归因与修复（TB-X802F/TBS 046299 诊断报告驱动）

验收标准变更：**以真机上传的诊断报告为准**，桌面流畅不能外推到 Android
（TBS WebView 无 OffscreenCanvas，worker 引擎变体与全部 worker 内解码优
化在真机上不可用，产品实际运行 baseline 主线程变体）。

真机报告 `diagnostic-reports/20260823-084346-0389f883.json` 关键读数：
baseline 回退（offscreen-canvas）；`predictedOpens 0 / notifyOpens 441`；
`decodeFailures 281 / nativeDecodes 0`；`KRKR2WEB_D5_STALL 主循环停跳 40s`
（无挂起操作 trace）；PERF avg_ms 125–146（约 8 FPS）、max_ms 3809；
heap 208→805MB 单调增长；cacheHits 216 / cacheMisses 232。

### 根因（全部实锤）

- **RC1a 零填充缺陷（patch 0079，从未工作过）**：数字后继只写入 `vlen`
  个数字到 `buf[]`，其余位读**未初始化栈内存**——`0001→2` 的候选名是
  `pfbg` + 垃圾 + `2.png`，IsExistent 必假。任何游戏上预测通道都
  静默失效（PRED_IN 实测 out=pfbg42.png/pfbg13.png/空串）。
- **RC1b 扩展名盲区（patch 0079）**：数字扫描从名字尾部开始，命中的是
  扩展名（`.ogg` 的 `g`），带扩展名的存储名（即全部真实文件）永远算
  不出后继。修复：先剥扩展名、预测完再接回。
- **RC1c 归档名不匹配（play/prefetch.js）**：引擎通知的归档名是
  `file://./data.xp3`，页面存储桥只认 `data.xp3`，readRange 静默返回
  null（prefetchReads=0 佐证），预取从未读过一块。修复：normalizeArchive。
- **RC1d 图片园键不匹配（play/prefetch.js）**：引擎 FillFromPark 用完整
  in-archive 名（`file://./data.xp3>dir/x.png`）探针，园内键是裸名。
  修复：bareName 剥前缀（probe/read/has）。
- **RC2 解码 worker 熔断缺失（play/prefetch.js）**：TBS worker 作用域无
  OffscreenCanvas，解码 job 全部抛错；ensureWorker 的 `worker || workerBroken`
  判断在 worker 对象存在时永不回退，281 次白跑 + 每张 WebP 落回
  主线程 wasm 解码（40–100ms/张）。修复：markWorkerBroken（终结 worker、
  熔断后续投递、失败在途 job 立即拒绝），baseline 回退 decodeOnMain
  （浏览器原生解码 + 页内回读），新增 mainDecodes 指标。
- **RC3 解码 await 无超时无 trace（engine/webp/LoadWEBP.cpp）**：唯一
  没有超时/trace 的 Asyncify 挂起点；createImageBitmap 挂死即引擎挂死
  且看门狗报不出挂起操作（40s 停摆即存档恢复长 tick 的放大表现）。
  修复：8s Promise.race + krkr2webAsyncTrace。
- **RC4 配额前置检查补强（probes/d2-downloader/web/downloader.js）**：
  安装前 best-effort `navigator.storage.persist()`（未持久化源配额只有
  磁盘的一小部分，桌面新 profile 3GiB < 4.65GiB 被 E_QUOTA 秒拒）。

保留设施：`krkr2webPredictionDebug` 页面开关（patch 0079 每次真实打开
打印 candidate/exists，真机现场可开）。

### 复现与验证（tests/d5_device_regression_audit.js）

桌面复现真机条件：`?engineVariant=baseline` + Worker 包装器模拟 TBS
（解码形状的 job `{id,bytes,bgra}` 一律回 "OffscreenCanvas unavailable"，
膨胀 job 走真 worker，与真机 poolInflates 正常一致）。d3 自测游戏新增
`pfbg0001..0006.png`（WebP 字节伪装 .png 扩展名，与真实游戏一致）编号
序列 + startup.tjs image 标签处理器（走真实图形加载器）。

结果（engine build 5f32c76f）：6 阶段全 PASS——
predictedOpens 9、prefetchedFiles 3、segmentParkPuts 5、imageParkPuts 3、
**imageParkHits 3（引擎消费园命中）**、decodeFailures 3（熔断）后
mainDecodes 8（页内回退）、无停摆、perf 持续输出。
段园命中需要压缩段归档（d3 包未压缩，按设计不经过段园；真机游戏为
压缩段，段园命中以真机报告为准）。

审计踩坑记录（供复用）：持久 profile 会保留 KAG 进度存档导致直接恢复
到剧本结尾（审计先经存档管理器删档）；Playwright 无 persistent-storage
权限名，改用 E: 盘持久 profile 提升临时配额；resource-map 服务器启动时
一次性加载，产品热换后必须重启 443。

### 遗留观察（真机复测关注）

- heap 805MB（1GiB 顶）与 cacheMisses 高企：预取管线修复后热点块应
  常驻，观察堆与 miss 变化；
- OpenAL A004（VIDEO_STOP 后 alGetSourcei）：暂按噪声处理；
- profile runtime 参数（maximumWasmMemoryBytes 等）仅在已退役的 worker
  运行时消费，baseline 用构建期默认值——如真机复测仍有内存压力再立项。

## 2026-08-23 第二份真机报告归因：主线程解码饥饿与段园零命中（RC5a/b/c）

真机报告 `diagnostic-reports/20260823-132147-3eaaf1f7.json`（同一台
TB-X802F/TBS 046299，第一轮修复后复测）关键读数：`predictedOpens 32`
（RC1 修复生效，预测通道已工作）但 `segmentParkPuts 31 /
segmentParkHits 0`、`imageParkPuts 24 / imageParkHits 0`（园只进不出）；
`mainDecodes 182`（全部 WebP 解码落在页面主线程）；PERF 出现
`avg_ms=1921 max_ms=23290` 的窗口（23 秒级停顿，BGM 直接被打断），
其余窗口 avg 24–204ms；体感"对话音频卡顿、卡两下后彻底没声音"。

### 根因（全部实锤）

- **RC5a 解码落在主线程（饥饿 OpenAL 调度器）**：TBS worker 无
  OffscreenCanvas，第一轮的 markWorkerBroken 熔断后所有解码走
  decodeOnMain 页内回退——每张 40–100ms 的同步 wasm 解码堆在主线程，
  而 Emscripten OpenAL 只提前 250ms 调度音频缓冲，200–660ms 的
  换装 tick 一来语音就断。修复：**独立 wasm libwebp 解码模块**
  （engine/webp/WebpWorker.c → webp-worker.js/.wasm，157KB，decoder-only
  子集、通用 C 无 SIMD/线程，满足铁律），由页面解码 worker 经
  importScripts 惰性加载，MODULARIZE 工厂 + locateFile 绝对化；主线程
  只做 memcpy。审计以 `krkr2webWebpForceWasm` 强制走该路径（与 TBS
  一致）。PASS = `workerWasmDecodes > 0 且 mainDecodes === 0`。
- **RC5b 段园键永不匹配（本轮桌面上游复现并实锤）**：notifyOpen 传原始
  归档名 `file://./data.xp3`，而 EnsureSegment 探针（patch 0079
  AdoptFromPage）先把归档名过一遍 `NormalizeInArchiveStorageName`——
  该函数会把 `//` 折叠成 `/`，探针到达页面时是 `file:/./data.xp3`；
  页面 normalizeArchive 只剥严格 `file://` 前缀，于是入库键
  `data.xp3|idx|seg` 与探针键 `file:/./data.xp3|idx|seg` 永不相等，
  预取的语音段从未被消费（真机 31 parked / 0 hit；桌面 senren 复现
  97 parked / 0 hit）。修复：normalizeArchive 宽容剥 scheme +
  折叠重复斜杠（纯页面修复，已部署引擎无需重建）。
- **RC5c 音频前瞻不足（patch 0081）**：AL.QUEUE_LOOKAHEAD 250ms →
  750ms，已排程音频可以扛过 750ms 内的主线程突发；图形缓存默认
  128 → 160MiB（标题/菜单等重访场景保持解码态）。
- **预取大文件闸门（play/prefetch.js）**：预测只对 ≤1MiB
  （PREFETCH_MAX_FILE_BYTES）的存储生效，多 MiB 级 CG 跳过并计入
  `skippedLargeFiles`——弱设备上预取不再与音频调度抢带宽/解码。
  真机 CG 编号跳跃（P/R 不相交：预测 2054/2055 而实开 2237/2083）
  证明编号 CG 的数字后继预测天然不可靠，只保留语音类小文件的预测。

### 部署 bug（审计顺带抓出，均已修复）

- `apps/web/player.js`：webp-worker URL 由 wasmUrl 后缀正则替换而来，
  `krkrsdl2\.wasm$` 被 stamp_build_versions 追加的 `?v=hash` 破解，
  worker 会 importScripts 引擎的 .wasm 当脚本。修复：`(\?.*)?` 容忍
  版本参数。
- blob worker 无法解析根相对 URL（blob: base 非层级），importScripts
  `/engine/webp-worker.js` 直接 "invalid"。修复：prefetch.js
  `absolutizeWorkerUrl` 按页面 URL 绝对化后再 postMessage。

### 验证（tests/d5_device_regression_audit.js，engine build 711a706b）

- **d3 自测游戏 PASS**：predictedOpens 9、prefetchedFiles 5、
  segmentParkPuts 5、imageParkPuts 5、**imageParkHits 5**、
  workerWasmDecodes 11、mainDecodes 0、decodeFailures 0。
- **千恋万花（真游戏、真压缩 XP3）PASS**：审计从标题菜单点"新游戏"
  （以 `sysscn/title.ks` 打开为就绪判据，开机厂标序列长于任何固定延时）
  连点推进到数字语音（`voice/uts001_*.ogg`）：notifyOpens 353、
  predictedOpens 6、prefetchedFiles 5、segmentParkPuts 5、
  **segmentParkHits 1（38,315 字节语音段被 EnsureSegment 一次 memcpy
  消费）**、workerWasmDecodes 49、mainDecodes 0、poolInflates 339、
  decodeFailures 0、无停摆。压缩段归档的段园消费链路首次全链路闭环。
- 审计导航备注：千恋万花语音为数字递增命名（`rok504_073.ogg`，25213
  个三位编号条目），数字后继预测适用；精灵为 .tlg 不经 WebP 园（d3 的
  imageParkHits 路径与真游戏互斥，段园命中以真游戏为准）。

### 真机复测验收标准（下一份诊断报告应看到）

- `mainDecodes === 0`、`workerWasmDecodes > 0`（RC5a）；
- `segmentParkHits > 0` 且 `segmentParkBytes > 0`（RC5b）；
- 有声对话期间 PERF 不再出现 avg_ms > 500 的窗口，语音不中断（RC5c）；
- `skippedLargeFiles > 0`（大 CG 被闸门跳过属预期）。

## 2026-08-24 第三份真机报告：音频黑匣子（对话无声 + 回标题卡死的取证）

报告 `diagnostic-reports/20260824-052619-95410916.json`（RC5 修复后的
首次真机复测）：**预取/解码修复全部在真机生效**——`segmentParkHits 1 /
segmentParkBytes 49518`（RC5b 段园消费首次在真机闭环）、`mainDecodes 0 /
workerWasmDecodes 292`（RC5a）、`skippedLargeFiles 2`（闸门）。但用户
报告对话全程无声、回标题后卡死（`*gobacktitle` → 标题启动序列在
`VIDEO_STOP` 处停止，PERF avg 512-625ms 后日志终止，最终用户工具栏强停）。

### 取证结论（本轮分析）

- **报告的 `audio` 块是验尸采样**：`terminateInstance → closeAudioContext`
  先把 `activeAudioContext` 置空再 `persistEvidence`，所以
  `state:null/bridgeArmed:false` 是强停之后的状态，会话中的音频状态
  从未被记录过（上一份报告同样如此，该字段两份报告一模一样）。
- **桌面同构探针**（钩 `AudioBufferSourceNode.start` + AudioContext
  状态采样，同一页面+引擎）：对话语音期间调度持续增长（每 10s 约
  100-280 次）、上下文 48kHz running——引擎调度路径在本轮改动后正常，
  无声不是调度逻辑回归。
- **渐进式音频死亡是既有症状**：上一份报告的体感就是"卡了两下甚至
  彻底没声音"；本轮引擎侧音频唯一改动是 QUEUE_LOOKAHEAD 0.25→0.75
  （桌面验证无害，保留）。
- 混音器 underrun 恢复逻辑（OpenALWaveMixer EnsurePlayState）审查无缺陷；
  `alGetSourcei A004` 在 VIDEO_STOP 后出现为既有噪声（第一份报告已有）。

### 本轮改动：页面侧音频黑匣子 + 挂起自愈

- `apps/web/index.html`：最早内联脚本钩
  `AudioBufferSourceNode.prototype.start`——计数 + 每 25 次采样一次
  所属上下文状态（240 条环形）。**引擎是否在调度音频**从此有据可查：
  starts 增长而无声 → 输出路由/内核问题；starts 为 0 → AL 设备创建
  失败或混音器死亡。
- `apps/web/player.js`：3s 看门狗，发现上下文 `suspended/interrupted`
  即 `resume()` 并记录每次尝试（成功即修复该失效模式；被拒则证据入
  报告）；`snapshot().audio.probe` 携带 starts/startsLog/resumeAttempts
  进每份诊断报告。

### 下一份报告的判读标准

- `audio.probe.starts` 在对话期间持续增长 + `startsLog[].s` 全程
  "running" → 声音在 WebAudio 图内正常调度，无声是 TBS 内核输出路由
  问题（下一步：内核级音频输出方案）；
- `startsLog[].s` 出现 "suspended" → 看门狗是否 resume 成功
  （resumeAttempts）；
- `starts` 长时间为 0 → 引擎 AL 设备创建失败/混音器死亡（引擎侧排查）；
- 回标题卡死：看卡死点前后 PERF 与 engineLog 尾部（本轮卡在标题启动
  序列 `VIDEO_STOP` 后，主循环 avg 512-625ms——与读档期 22.5s 长停顿
  的设备性能状态一致，待音频结论后单独归因）。

## 2026-08-24 读档黑屏与立绘/音频切换卡顿优化（本地限速验证，目标 ≤1/5）

用户目标（验收改为本地浏览器 + CDP CPU 限速模拟安卓）：缩短读档黑屏、对话音频加载、
立绘/音频切换卡顿；每项 CPU 占用与延迟降至原先 1/5。

### 真机卡顿再归因（22.5s 读档黑屏 + 回标题冻结）

- **52 次 autopath 重建 × 200ms**：`TVPAddAutoPath` 对重复 auto path 仍清表、
  `TVPClearStorageCaches`（fstat 存读档/存档、`TVPDeliverCompactEvent` DEACTIVATE/
  SystemControl 4s IDLE）清表，每次 `TVPRebuildAutoPathTable` 重新遍历归档
  （`data.xp3` 39k 条目），报告里 `Rebuilding Auto Path Table` 出现 52 次、
  单次 201–232ms（首次 1587ms），直接构成黑屏与回标题冻结。
- **5.7MB XP3 索引重复解压/解析**：`tTVPXP3Archive` 每次构造都从流取索引、解压
  （`KRKR2WEB_D5_XP3_INDEX_INPUT compressed=5679985 expanded=5683641`，worker 105ms）
  并排序 39k 条目；标题 BGM 探针与每次 autopath 重建都触发。

### 本轮改动

- **补丁 0085 `StorageIntf.cpp` autopath 脏检查 + 快照回放**：重复 `TVPAddAutoPath`/
  不存在路径的 `TVPRemoveAutoPath` 不再清表；软清表（compact/fstat）后若
  `AutoPathList` 未变，`TVPRebuildAutoPathTable` 直接从 `Krkr2WebAutoPathEntries`
  回放哈希表（Copy Add O(1)，~0.3ms vs 200ms），否则走全量重建并刷新快照。
- **补丁 0086 `StorageIntf.cpp` XP3 归档持有缓存**：`tTVPArchiveCache` 外再持 3 份
  已解析归档，`TVPClearStorageCaches` 清掉 LRU 后仍可零解压回填，避免标题/BGM
  与 autopath 重建的重复索引开销。已登记 `engine/upstream.json`（共 82 补丁），
  `build_d3.ps1` 全量重建通过，`prepare_d5_product.ps1 -SkipEngineBuild` 部署到
  8443。
- **本地限速基准**：`tests/d5_throttled_bench.js`（CDP `Emulation.setCPUThrottlingRate`，
  rAF gap/longtask/AudioBufferSourceNode.start 采样，load 的黑屏按 4 连续 rAF <100ms
  判定）。本次验证仅页面自洽（save 隔离导致实际未进对话，voice 计数为 0，属已知
  基准脚本路径缺陷），不作为 1/5 的最终验收口径。
- **基准对比（rate=1 同档）**：smoke `opt-r1` vs 旧 `smoke`（rate=1）整体
  `stallTotal 6236→479ms (7.7%)`、`stallCount 11→1`；load `waitMs 2092→1697ms`；
  读档期的 CPU wall 占比中软清表开销已被快照路径消除，黑屏中不再有 52 次 200ms 重建。

### 验证与部署

- 8443 已部署新引擎（`engine-manifest a6b42c58`），d3 自测游戏与千恋万花在桌面验证
  中正常启动；快照回放与归档持有在本地基准中命中。
- 本轮未完成语音/立绘切换的端到端 1/5 验收（需修复基准脚本的存档加载路径后重测），
  读档黑屏的 52×200ms 主体开销已消除。
- **bench 存档路径缺陷已修**：`tests/d5_throttled_bench.js` 的存档加载此前走空槽（`voiceCount 0`，对话零度量），
  本轮改为“标题 新游戏 直接进场 + 循环点击”路径（`build/tmp-audio-probe.js` 同款），
  `bench-r1` 已可度量（`voiceCount 8`, `spriteSwitchRounds 3`, `voice p50 222ms/p95 651ms`），
  诊断报告侧 3 份最新样本（052619/065137/083908）`segmentParkHits 1→6→3`、`poolInflates 428–475` 已有命中。
- **版本戳补齐**：`tools/stamp_build_versions.py:20` 此前漏 `play/prefetch.js`（无 `?v=`），WebView 缓存曾导致桌面有声无画；
  已补入 `HTML_ASSETS`。

### 验证再测（build fce3a1d5，仍不可直接与旧 smoke 同比）

- 引擎 `fce3a1d5` 已部署到 `8443`（`prefetch.js?v=f3dea460`），增量路径在启动期生效。
  同路径“新游戏进入”脚手架下重建基线：`bench-r1` 为优化前基线（rate=1 有声可度量，`voiceCount 8`），
  `bench-r1f/r6f` 为优化后限速复测（均 `voiceCount 8`，rate=1/6 各 30 轮对话）。
- **增量 autopath（补丁 0085 合并 UpTo + 前缀增量）**：启动期 31 次 `TVPRebuildAutoPathTable` 的 O(n²) 前缀重扫改为
  单批全量 + 后续增量单条（`KRKR2WEB_D5_AUTOPATH_INCR hit=TOTAL active`，`MISS` 日志保留），`Total` 数保持与全量一致。
  本次工作区直接编辑已验证编译通过（`build_d3.ps1` ninja 598 链接成功，`D3 artifacts valid`），补丁文件已同步为单 `0085` 折叠形态（UpTo + 增量）。
- **同档限速对比**：
  - rate=6（模拟安卓）：`boot stallTotal 27903ms→4431ms (15.9%)`、`dialogueWindow stallTotal 48873ms→11812ms (24.2%)`，
    `voice p50` 进入对话后 275ms（旧 bench `n=4` 样本窄）、`p95FrameMs 126.7→78.8ms (62%)`；
  - rate=1（桌面）：`boot 1370→1267ms`、`dialogueWindow 6097→6285ms` 已近地板，限速放大前的桌面 Pipe 不再由 autopath 主导，
    剩余主导为 TLG 主线程解码与单次场景过渡（WebP 已走 worker 旁路，TLG 仍在主线程）。
  - 结论：启动黑屏与回标题冻结的主体（31× 前缀重扫 + 5.7MB XP3 重复解析）已在限速环境下达到 ≤1/5；对话期的 `p95FrameMs` 仍需
    下一轮以 TLG 解码旁路为主攻（不在本段落计入验收）。

### 2026-08-24 TLG 异步档位（0087，默认关闭）与同档四项复测

- 新增补丁 **0087 LoadTLG.cpp + SysInitImpl.cpp TLG 异步档位**：TLG5/6 每 8 行一次 EM_ASYNC_JS krkr2web_tlg_yield（setTimeout 0 的 Asyncify 挂起），由命令行 -tlgasync=1 统一开关；SysInit 新增 KRKR2WEB_D5_TLG_ASYNC on/off 日志，player.js 将 ?tlgasync=1 透传为引擎参数，d5_throttled_bench.js 的 ?engineVariant 拼接已修复（?/& 双问号曾致 on-r1 失败）。默认关闭，行为与 fce3a1d5 一致（b83775bd 已验证同样产物校验 Asyncify、无 SAB/JSPI）。
- **同引擎同路径四项对比（OFF vs ON，30 轮新游戏）**：
  - rate=1：voice p50 197→181ms / p95 258→211ms、dialogueWindow stall 4079→3927ms (96%) / longTask 20421→19864ms (97%)、p95FrameMs 54.51→54.49ms (100%)；
  - rate=6：voice p50 654→577ms / p95 662→629ms、dialogueWindow stall 49750→48509ms (98%) / longTask 69139→66818ms (97%)、p95FrameMs 127.29→126.98ms (100%)；
  - 结论：异步档位在当前对话路径上仅小幅平缓 longTask，p95 与 stall 未达 1/5；已保持默认 OFF，不计入验收。
- **总体四项 1/5 判定**：以同引擎 before/after（fce3a1d5）平台期为准，当前对话管线四项在限速 1/6 下均未达到 1/5；已落地的 1/5 为读档/启动侧 autopath 31 次前缀重扫 + 5.7MB XP3 重复解压（boot stall 27903→4431ms 等）。下一步仍以真机诊断的 KRKR2WEB_D5_AUTOPATH_SNAPSHOT_HIT/INCR/miss 与 segmentParkHits/poolInflates 复核，对话 p95 需新的旁路（非更大预取、非更密让步）后再计入验收。

### 下一步

- 保持 0087 默认关闭（b83775bd），对话侧的下一旁路在新方案验证后再计入 1/5；验收仍以 before/after 同档四项与真机 SNAPSHOT_HIT/segmentParkHits 为准。