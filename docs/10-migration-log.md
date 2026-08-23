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
| P0-2 | `TVPGetRoughTickCount32` 软件锁相环 | P0 | 未开始 |
| P0-3 | 文件读取“大读直读、不污染 LRU” | P0 | 未开始 |
| P1-1 | WebGL shader 精度修复 | P1 | 未开始 |
| P1-2 | 跨标签页引擎单例（Web Locks） | P1 | 未开始 |
| P1-3 | 早期日志捕获（`?debugEarlyLogs=1`） | P1 | 未开始 |
| P1-4 | `TVPExitApplication` 退出对齐 | P1 | 未开始 |
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
- 涉及：`engine/patches/0083-web-tick-lockstep.patch`、`engine/upstream.json`
- 状态：未开始

### 阶段 P0-3：大读直读不污染 LRU

- 目标：`storage.js` 对 ≥1 MiB 读直接从 IndexedDB 拼装返回，不放入块 LRU。
- 参考：`kirikiroid2-web/platforms/web/vlfs.js` 的 `DIRECT_READ_THRESHOLD`
- 涉及：`probes/d3-engine/web/storage.js`、`apps/web/play/storage.js`（如已复制）
- 状态：未开始

### 阶段 P1-1：WebGL shader 精度修复

- 目标：`shaderSource` 自动为无精度 `uniform` 补 `highp`。
- 参考：`kirikiroid2-web/platforms/web/shell.html`
- 涉及：`apps/web/player.js` / `apps/web/play/app.js`
- 状态：未开始

### 阶段 P1-2：跨标签页引擎单例

- 目标：`navigator.locks` 防止多实例同时运行。
- 参考：`kirikiroid2-web/platforms/web/shell.html`
- 涉及：`apps/web/player.js`
- 状态：未开始

### 阶段 P1-3：早期日志捕获

- 目标：`?debugEarlyLogs=1` 捕获早期 console 日志到 sessionStorage。
- 参考：`kirikiroid2-web/platforms/web/shell.html`
- 涉及：`apps/web/index.html`、诊断报告
- 状态：未开始

### 阶段 P1-4：TVPExitApplication 对齐

- 目标：非致命 `System.exit()` 不真正退出引擎。
- 参考：`kirikiroid2-web/cpp/core/environ/web/Platform.cpp`
- 涉及：`engine/patches/0084-web-exit-ignore.patch`、`engine/upstream.json`
- 状态：未开始

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
