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
| P0-1 | 主循环 RAF 帧率限制 | P0 | **已完成**（2026-08-23 桌面验证通过） |
| P0-2 | `TVPGetRoughTickCount32` 软件锁相环 | P0 | **已完成**（2026-08-23，构建+引擎闭环冒烟通过） |
| P0-3 | 文件读取“大读直读、不污染 LRU” | P0 | **已完成**（2026-08-23，直读路径+回归冒烟通过） |
| P1-1 | WebGL shader 精度修复 | P1 | **已完成**（2026-08-23，重写生效下闭环冒烟通过） |
| P1-2 | 跨标签页引擎单例（Web Locks） | P1 | **已完成**（2026-08-23，双标签真会话验证通过） |
| P1-3 | 早期日志捕获（`?debugEarlyLogs=1`） | P1 | **已完成**（2026-08-23） |
| P1-4 | `TVPExitApplication` 退出对齐 | P1 | **已完成**（2026-08-23，补丁 0084） |
| P2-1 | UI 资源是否仍整体 preload（调研） | P2 | 未开始 |
| P2-2 | 构建脚本 ccache / 参数化（可选） | P2 | 未开始 |

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
