# 架构决策记录

本文件记录已经影响整体实现的决定。`已接受` 表示开发必须遵循；满足复审条件时，
需用新 ADR 修改，而不是在代码中静默偏离。

## ADR-001：IndexedDB 4 MiB 分块

**状态：** 已接受

**背景：** 游戏资源超过 4 GB，单个 XP3 可超过 2 GB。目标 WebView 不能使用系统文件
选择器或现代 OPFS，同一大 Blob 在旧 WebView 中存在内存和事务风险。

**决策：** 游戏包以固定 4 MiB 块写入 IndexedDB，每块独立校验和提交。读取接口按
偏移组合所需块，不把完整 XP3 载入 JS 或 Wasm 内存。

**后果：** 支持中断恢复、坏块修复和有界内存，但增加记录数量、跨块拼接和清单
体积。所有偏移计算必须保留 64 位语义。

**复审条件：** D1/D2 实机显示 4 MiB 明显影响吞吐或事务稳定性时，对 1、2、8 MiB
重新基准测试；改动需要 Manifest schema 兼容策略。

## ADR-002：单线程 Wasm + Asyncify 文件桥

**状态：** 已接受

**背景：** KRKR2 使用同步文件读取，IndexedDB 只能异步访问。实机在正确 COOP/COEP
响应头下仍没有 `SharedArrayBuffer`、跨源隔离和 Wasm 共享内存。

**决策：** 目标构建禁用 pthreads，以 Asyncify 挂起同步式 C/C++ 文件调用，等待
JavaScript 从 IndexedDB 读取分块后恢复。下载和哈希可使用不共享 Wasm 内存的普通
Worker。

**后果：** 避开目标环境不支持的共享内存和 JSPI，但增加 Wasm 体积、运行开销和
调用栈管理风险；同一实例需严格禁止并发 unwind。

**复审条件：** D1 无法满足正确性、响应性、内存或 20 FPS 性能门槛；届时评估修正
调用边界或 Service Worker + 同步 Range 后备方案，不能回退到已证实不可用的 SAB。

**验证记录：** 2026-08-13 目标 WebView 89 完成 10,000 次随机读取、2/4 GiB 后偏移、
跨块、错误恢复和后台恢复；连续约 13 分 57 秒的趋势中缓存与 Wasm 堆保持固定，
因此从 D1 候选转为产品决定。

## ADR-003：完整下载后才能启动

**状态：** 已接受

**背景：** 用户接受先下载完整游戏，且离线是核心需求。边下边玩会增加脚本时序、
网络错误和未缓存资源导致的不可预测失败。

**决策：** Manifest 的全部包和块完成校验后，最后原子写入 `complete=true`；引擎只
打开该状态的版本。

**后果：** 首次等待较长且需要足够存储空间，但运行期间不依赖网络，错误模型更清楚。

**复审条件：** 产品需求明确改为边下边玩，且有新的完整缓存与失败恢复设计。

## ADR-004：游戏资源不进入 Cache Storage

**状态：** 已接受

**背景：** Cache Storage 适合请求/响应缓存，但不适合管理 4 GB 资源的块级校验、
断点恢复、版本原子切换和按 64 位偏移随机读取。

**决策：** XP3、转码视频和游戏资源统一由 IndexedDB 分块层管理；不依赖
Cache Storage 或 Service Worker 保存产品运行资源。

**后果：** 下载器和虚拟文件层拥有唯一数据真相，避免两套大资源缓存；离线媒体 URL
需要由当前文档中的受控媒体适配层桥接到 IndexedDB。

**复审条件：** 浏览器平台变化或某类小型公开资源明确更适合 HTTP 缓存时，可逐类
评估，但不得复制保存整套游戏包。

## ADR-005：视频优先在服务端预转码

**状态：** 已接受，计划在 D6 完成

**背景：** 《千恋万花》包含 Chrome 89 不能直接播放的 WMV。G88 和 4 GB 设备不适合
把通用 FFmpeg 软件解码作为首选。

**决策：** 发布游戏时提取并转为目标 WebView 可硬件解码的 H.264/AAC MP4，在
Manifest 中映射原游戏路径；客户端完整缓存转码副本并保持脚本播放事件。

**后果：** 需要服务器发布工具、额外存储和媒体版权合规检查，但显著降低客户端 CPU
与内存风险。Wasm FFmpeg 只用于无法预处理内容的受限后备评估。

**复审条件：** 实机硬件解码格式检测变化、预转码不被资源授权允许，或脚本依赖无法
通过映射保持语义。

## ADR-006：目标宿主使用同页断网启动

**状态：** 已接受

**背景：** IndexedDB 游戏数据可持久保留，但目标腾讯 TBS 046295 无法注册 Service
Worker。实机确认断网后任何 URL 变化都会被宿主替换为网络错误页。产品的实际需求是
页面已经打开且不退出时，断网仍能启动和游玩；不要求断网冷启动。

**决策：** 联网打开游戏库时在当前文档预载引擎 JS/Wasm。游戏库与 Canvas 共存于同一
HTML 文档，“启动游戏”和“返回游戏库”只切换 UI，不修改 URL。XP3 始终从 IndexedDB
读取，启动阶段不得发送网络请求。

**后果：** 用户必须在断网前保持产品页打开；退出 WebView 后无法断网重新进入。引擎
预载约增加 7 MiB JS 内存预算，但避免复制 4 GB 资源和宿主导航错误。

**复审条件：** 目标宿主升级并可靠支持 Service Worker，或产品需求扩展为断网冷启动。

## ADR-007：Chrome 89 是不可升级基线

**状态：** 已接受

**背景：** WebView 属于第三方 App，用户不能更新其 Chromium 内核，目标版本长期
固定为 89。

**决策：** 所有运行时代码、依赖和构建产物以实机 Chrome 89 为最低标准。现代浏览器
只用于调试和对照，不能代替目标设备验收。

**后果：** 放弃 JSPI、Wasm 原生异常、reference types、Memory64、WebCodecs 和现代
OPFS 等能力；工具链升级成本更高，但兼容边界明确。

**复审条件：** 目标第三方 App 更换内核或产品正式增加另一条现代浏览器构建线。旧
设备支持仍不能被未声明地移除。
## ADR-008：游戏插件通过移植 krkr2 的 NCB 框架与插件实现

**状态：** 已接受

**背景：** D5 摸底确认《千恋万花》启动依赖约 15–20 个 .dll 插件（fstat、json、
layerex_draw/layerExImage/layerExRaster/layerExBTOA、textrender、motionplayer、
psbfile、PackinOne、csvParser、scriptsEx、addFont、win32dialog/windowEx 等）。这些
插件不是孤立的 TJS 桩，而是统一建立在 ncbind（Native Class Binding）框架之上。
krkr2 与 kirikiroid2-web 的 cpp/core/plugin/ 都包含这套框架（ncbind.hpp 约 1954 行、
ncb_invoke.hpp、ncb_foreach.inc 等）以及全部插件实现；而 krkrsdl2 的 external/krkrz
是更精简的引擎核心，不含 plugin/、storage/、archive/ 目录，也没有 NCB 框架。因此
“补插件”的实际工作量是“移植 NCB 框架 + 插件所依赖的一层引擎基础设施 + 插件本身”，
而不是在 PluginImpl 里逐一手写 TJS 桩。

**决策：** 保持 krkrsdl2 作为 Chrome 89 单线程 Asyncify 运行时底座（D0–D3 已实机验证），
以“导入源码 + engine patch + 构建审计”的方式（与 D3 导入 KAGParser 同一机制）从
krkr2 移植 NCB 框架与插件，kirikiroid2-web 作为 motionplayer/PSBFile/PackinOne/
TextRender 等无公开源码插件的逆向权威参考。按依赖分层推进：纯逻辑插件（fstat、json、
csvParser、addFont）→ 视觉层插件（layerex_draw、layerExImage、textrender）→ 重型
逆向插件（motionplayer/Emote、psbfile、PackinOne）。

**后果：** 放弃“手写 TJS 桩逐个绕过”的低保真路线，改为忠实移植真实插件实现；短期内
需要先打通 NCB 框架与 krkrsdl2 引擎接口的适配，随后每个插件仍是一次可审计的移植。
移植来源、提交与许可证沿用 engine/upstream.json 的 sourceImports 机制登记。

**复审条件：** 若 NCB 框架与 krkrsdl2 的 TJS2/存储接口差异过大、导致移植成本接近
“把 krkr2 重新编译一遍”，则重新评估“以 krkr2 为底座、移植 krkrsdl2 的 Web 层”的
反向方案；该复审必须拿出两者接口差异的量化证据，而不是继续在小范围内打补丁。

