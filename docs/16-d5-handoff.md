# D5《千恋万花》交接文档（转接给下一个 Agent）

> 本文档是 krkr2web 项目 D5 阶段（《千恋万花》兼容与性能）的完整交接记录。
> 新 Agent 请**先通读全文**再动手，尤其是「环境陷阱」一节——那里记录了几个
> 会浪费大量时间的非显而易见问题。
>
> 最近提交：6cdb302（全链路可玩）与其后的触摸手势修复（git log --oneline
> 可看全部历史）。

---

## 0. 2026-08-21 最新状态（优先于旧章节）

`6cdb302`（2026-08-20）达成项目首个“完整可玩”里程碑：真实《千恋万花》
在本地 Chrome 与目标设备上全流程可玩（剧情推进、存读档、场景回想、CG
鉴赏）。该提交的主要内容（细节见 git log 与 docs/17）：

- Dedicated Worker + OffscreenCanvas 变体（engine-worker.js /
  engine-worker-host.js / worker-runtime-contract.json；实机自动回落
  baseline 主线程变体）；
- motionplayer 真移植（补丁 0048-0057 系列 + MotionRenderCompat.cpp
  软件光栅路径）；
- win32dialog TJS 垫片（0071）、native windowEx-web 插件（0059）；
- 视频覆盖桥（0042）、GPU style present 快速转场（0045）、输入帧预算
  （0046）等性能项；
- 存档管理器（save-manager.js）与播放器崩溃恢复/强制重启链路。

本轮（2026-08-21，补丁 0074-0075）修复触摸手势链——**CG 鉴赏双指点按
无法退出**（原生把双指 tap 映射为右键）：

- 0074（引擎层）：SDL 触摸事件按 android 契约投递——归一化坐标换算
  draw-area 像素、TouchPointList 多点跟踪支撑 Window.touchPointCount /
  getTouchPoint 查询族、scaling/rotate/multiTouch 由其派生；web 下丢弃
  SDL_MULTIGESTURE 重复源；0044 的旧“丢弃 FINGER”改法移除；
- 0075（TJS 层）：Window.TouchMouse 垫片类（原生机制住在 k2compat 插件
  本体）。实例回调把引擎 onTouchDown/Move/Up 桥接进游戏 action 事件链，
  并自跟踪手指：双指点按（≤900ms、位移 ≤80px）→
  win.onPrimaryRightClick()；
- apps/web/styles.css：canvas `touch-action:none`，浏览器不再抢双指手势。

实机用户已确认双指退出与单击推进均正常。同日第二轮修复 Logo 蓝色
（补丁 0076：PSB 纹理字节序本就是 krkr 序，删除上游多余的
TVPReverseRGB；repro 与真游戏双验证，详见 15 号文档文末）。

2026-08-22 修复**游戏正常退出不回游戏库**（补丁 0078 + player 对话框
钩子）：win32dialog shim 的 messageBox 恒答 IDNO，游戏 PanicAskYesNo
（退出/回想退出/场景跳转确认）全部被静默否决，shutdown 链走不到
krkr2webEngineQuit。现在 TJS 全局 `krkr2webAskMessageBox` 经 Asyncify
轮询页面模态对话框（krkr2webDialogAsk/Poll/Dismiss，MB_YESNO 渲染
是/否），无钩子（worker 变体）/超时回落旧默认答案。本地三层验证
（repro 桥全对、真游戏页对话框渲染/应答、engine-quit 回库）已过，
已部署 443，**待实机确认**：游戏内退出 → 弹"終了しますか？"→ 点
"是" → 自动回游戏库。详见 15 号文档文末章节。

同日第二轮：0078 部署后**实机引擎零输出死亡**——旧缓存页面/旧 js
胶水 + 服务端新 wasm 混搭（服务器无视 ?v= 参数；0078 的 EM_ASM 改了
js/wasm 接口 → 实例化即败）。修复（提交 9f3f2d2）：engine-manifest
完整性清单 + preload bytes/sha256 校验（不匹配 bust 重拉）+ 页面
meta build 比对自动 reload 自愈（sessionStorage 防循环）。此后引擎
更新页面自动检测自愈。**实机需完全关闭游戏页面重开一次**（当前
缓存的旧页面无自检代码）。stamp 陷阱：URL 形态字典键也会被加 ?v=，
manifest 查找必须按后缀匹配。详见 15 号文档文末章节。

同日第三轮：**实机确认退出修复与自检全部通过**（诊断
20260822-030207：verifiedBuild 校验通过、游戏完整启动、
stopReason=engine-quit 回库）。顺手修掉退出时"存档同步失败：超时"
（player 的 krkr2webEngineQuit 改 sync:false——引擎关闭自带
FS.syncfs，页面再强同步必撞车超时）。**重要发现：退出是靠异常级联
驱动的**——游戏正常关闭链在 showdate.tjs 析构异常处断掉，靠 menu
垫片 finalize 的析构异常触发致命异常退出路径才完成退出；把 finalize
改成空实现会导致退出永久卡死（本地实证三轮），0007 已加注释封存，
**勿改**。详见 15 号文档"退出路径复盘"章节。

同日第四轮（2026-08-22）两件事：

1. **实机复验退出仍不自动回库，用户决定暂缓**（"实在修不好就算了"）。
   030207 诊断与本地复刻里 player 层都已 hide（stopReason=engine-quit、
   samePageOffline.visible=false），实机却不回；且本轮复验的诊断没有
   上传到 diagnostic-reports（最新仍是 030207），缺实机侧新证据。后续
   若重启此问题，先拿实机诊断看 alerts/engineLog 尾部（怀疑方向：TBS X5
   的 native alert 阻塞恢复行为与桌面 Chrome 不同）。
2. **修复"下载途中刷新网页无法断点续传"并加强下载器**。根因：产品版
   app.js 的 boot 只 `d2Storage.getInstall()` 直接读 IndexedDB 记录，
   从不调用 `Downloader.load()`——刷新后 install 停留在 "downloading"，
   详情页只渲染"暂停下载"按钮，而点击走 `downloaders[gameId]`（此时
   不存在）直接 no-op，UI 死锁且无"继续下载"入口（恢复逻辑住在
   Downloader.load() 里，D2 探针页在 boot 时调用它所以探针一直正常）。
   修复（probes/d2-downloader/web/downloader.js + apps/web/app.js）：
   - boot 时对每个游戏 `resumeInstalls()` 跑恢复清单（downloading →
     paused、committedBytes 按已存块重算）；
   - 刷新前正在下载（非用户主动暂停）→ 刷新后**自动续传**；
     用户主动 paused 的刷新后保持 paused 不自动续传；
   - 网络错误（E_NETWORK/408/429/5xx/连接断开）任务级指数退避重试
     （2s 起、封顶 30s、每块最多 6 次），不再一次抖动就停整个下载；
     hash 重试与网络重试计数分离（原共用计数会把内容校验误判成
     E_VERSION_CHANGED 致命错）；
   - 并发 2 → 4（服务器是 ThreadingHTTPServer，多线程可扛）。
   本地验证（.tmp/resume-probe.js，persistent profile 绕开临时
   headless 3GiB 配额限制）：下载 68MiB → 刷新 → 块数只增不重置 +
   自动续传推进到 204MiB → 手动暂停+刷新保持 paused → 手动继续到
   296MiB，全过；期间服务器断连两次（ERR_TOO_MANY_RETRIES）均由退避
   重试自动恢复。已部署 443（app.js?v=b69dda52、downloader.js
   ?v=c6a4913f，引擎 manifest 未变无需自愈）。**实机复验方法**：完整
   关闭游戏库页面重开（旧缓存页面无新代码），开始下载 → 刷新页面 →
   应自动继续且进度不回退。

根因链与 TJS 语言陷阱
（无词法闭包、TouchMouse 的 owner 即 kag）详见
[15-d5-compat-status.md](15-d5-compat-status.md) 文末触摸章节。

剩余已知问题（按优先级）：

1. 长期卡顿优化：新游戏开场约 25s 的 scenestart 同步加载停顿
   （场景预热/分帧物化为候选方案；ED 增量转码远期）。诊断补丁 0077
   已就位（KRKR2WEB_D5_LOAD 计时日志），且已实测 8MB WebP 解码仅
   70-100ms、25 张图约 2.5s——大头不在 WebP，疑在 PSB 物化/XP3 解压
   突发，下轮取真实窗口构成清单后定方案；
2. worker 变体桌面黑屏 bug：本地 headless 必现、headed 正常；实机走
   baseline 变体不受影响（低优先）。另 worker 变体的 messageBox
   无 window，自动回落默认答案（桌面调试路径可接受）。

Logo 蓝色问题已于 2026-08-21 修复（补丁 0076，PSB 纹理 R/B 交换，
详见 [15-d5-compat-status.md](15-d5-compat-status.md) 文末章节）。

旧章节 2、5、6 是历史快照，排障细节仍有价值，但其中的当前状态和优先级均已
被本节取代。

## 1. 目标与验收标准

把 krkr2 引擎的 NCB 框架与游戏插件移植到 krkrsdl2（WebAssembly 引擎基座），
让真实《千恋万花》在 **Android Chromium 89 WebView（TBS，无
SharedArrayBuffer/Service Worker/JSPI/pthreads）** 上跑通：

- 标题画面可显示、可交互；
- 剧情能推进（点击/键盘输入工作）；
- 存读档可用；
- 20 FPS 稳定、60 分钟不崩；
- 产出实机验收报告。

用户是非技术产品设计师，全部技术决策已授权给 agent。硬性要求只有
"在目标设备上能跑"。

## 2. 当前进度快照

### 2.1 已达成（真实游戏实测）

- 三个 XP3（合计 4 GB）索引读取 + 文件树重建：39946 files / 39854 activated。
- 真实 startup.tjs → boot.tjs 全链跑通，"(info) Startup script ended." 已出现。
- 游戏系统脚本全部加载（AfterInit.tjs 完成），KAG 场景流：
  first.ks → version.ks → title.ks 全部加载（引擎诊断
  KRKR2WEB_SCENARIO xxx 可证）。
- 图片格式：游戏几乎所有光栅图是 **WebP**（.png/.jpg/.tlg 伪装），已接入
  libwebp + magic 探测路由；PSB（.pimg）走 psbfile 插件；.sli 分层图待
  layerEx 系。
- 插件注册：fstat / csvParser / getSample / scriptsEx / psbfile / saveStruct /
  textrender / layerExImage / layerExRaster / layerExBtoA / PackinOne 真注册；
  motionplayer / menu / addFont / getLangName / windowEx 垫片；
  AlphaMovie / win32dialog / proxyfs / k2compat / wuvorbis / wuopus / extrans /
  extNagano 为 NOOP；layerExDraw 是最小 stub。
- 输入链路（浏览器→引擎→TJS）**已全通**（见 2.2）。
- 引擎补丁 0001–0035 全部可干净应用（python 应用器，见 4.1）。

### 2.2 输入链路的逐级验证结论（本轮最重要成果）

用引擎内 fprintf(stderr) 诊断逐级验证（输出进 d5CompatState().log）：

浏览器 click → SDL_MOUSEBUTTONDOWN(1025) → window_receive_event
→ window_receive_event_input → button=1 → TVPPostInputEvent(OnMouseDown)
→ TVPPostEvent("onMouseDown", IMMEDIATE) → tTVPEvent::Deliver
→ Target->IsValid()=1 → FuncCall("onMouseDown") 返回 0（成功）

**结论：事件确实到达了游戏窗口的 TJS 回调并执行成功。**
但游戏停在 title.ks 的 [s]（等待输入）不推进——**问题在 TJS/游戏逻辑层**。

关键线索：FuncCall 返回值中**个别事件是 -1001（TJS_E_NOTIMPL，成员不存在）**，
最大嫌疑是 **onHitTest（图层命中测试）未实现**——游戏可能因为点击"命中测试
失败/无结果"而忽略这次点击。下一步首要任务就是确认 -1001 对应哪个事件名。

### 2.3 画面状态

canvas（950x950）基本全黑：约 16 种颜色、3725 个非暗像素（多为零星白点）。
游戏逻辑在跑（title.ks 走到 [s]），但标题背景图（title_bg.png，实为 WebP）
没有显示出来。渲染/图层合成是另一个待攻方向。

## 3. 环境与命令

### 3.1 目录结构

- engine/ ：**项目自有资产**（git 跟踪）。engine/patches/*.patch（已到
  0075；权威清单以 engine/upstream.json 为准）、
  engine/plugins/（项目自有插件源码，构建时复制进 build 树）、
  engine/web/（web shim）、engine/webp/LoadWEBP.cpp（WebP 加载器）、
  engine/upstream.json（锁：仓库 commit + sourceImports + patches 列表）。
- build/d3-engine-work/ ：**构建工作树**（gitignored）。source/ = 导出源码 +
  34 补丁 + 项目插件拷贝；cmake/ = CMake+Ninja 构建目录。
- build/d5-product/ ：部署给诊断 server 的静态站（compat 页面 + engine）。
- build/d2-metadata/resource-map.json ：把游戏 XP3（在
  参考资料/千恋万花/）映射给 server 按需供给。
- 参考资料/开源项目/ ：krkrsdl2（3f384a6）、krkr2（dca7264）、
  kirikiroid2-web、csvParser（7c757cf）、libwebp。
- tools/ ：build_d3.ps1、apply_patch.py（新）、scan_xp3_compat.py、
  https_diagnostics_server.py、check_d3_artifacts.py。
- probes/d5-compat/web/ ：诊断页（app.js/index.html）。
  window.d5CompatState() 返回 {log(滚动 cap 2000), networkBytes, readCalls,
  completedReads, lastRead, ...}。
- .tmp/ ：测试驱动脚本（d5_*.js）与临时诊断产物（gitignored）。

### 3.2 常用命令

全量重建引擎（重导出 + 34 补丁 + CMake + ninja，约 2-4 分钟）：
powershell: & .	oolsuild_d3.ps1 -Clean

增量编译（改过 build 树源文件后）：
powershell: & '.toolchains/d3-build-tools/Scripts/cmake.exe' --build 'build/d3-engine-work/cmake' --target krkrsdl2 --parallel

部署到诊断站（server 通常已在后台 job pwsh-73 运行）：
powershell: Copy-Item 'build/d3-engine-work/cmake/krkrsdl2.js' 'build/d5-product/engine/krkrsdl2.js' -Force
powershell: Copy-Item 'build/d3-engine-work/cmake/krkrsdl2.wasm' 'build/d5-product/engine/krkrsdl2.wasm' -Force
powershell: python tools/https_diagnostics_server.py --bind 127.0.0.1 --port 8768 --directory build/d5-product --resource-map build/d2-metadata/resource-map.json --http

跑游戏诊断（playwright-core + 系统 Chrome）：
powershell: node .tmp/d5_boot_driver.js http://127.0.0.1:8768
powershell: node .tmp/d5_fprintf2.js

抽取游戏脚本（XP3 不落盘，按需读）：
powershell: python .tmp/extract_ks.py   （例：抽取 sysscn/title.ks 到 .tmp/title_ks.txt）

## 4. 环境陷阱（必读！不看会重蹈覆辙）

1. **DSH 沙箱中 git.exe 的文件视图与其他进程隔离**。git hash-object 会把
   11 字节文件算成 12 字节内容的哈希；git apply 对逐字节一致的上下文报
   "patch does not apply"，且写入不落真实磁盘（"假成功"）。**结论：构建流程
   中禁止用 git apply/git 读写工作树文件**，已全部改为 tools/apply_patch.py
   （Python，与 pwsh/编译器同视图）。同理，**在 build 树里改文件请用
   python/pwsh 写**（read/write/edit 工具对 build 树可能是旧快照——验证内容
   一律以 pwsh/python 视图为准）。
2. **build 树每次重导出会清空**（指纹 = upstream.json 的 commit + 每个补丁
   哈希 + sourceImport 文件哈希）。对引擎源码的任何修改必须固化为
   engine/patches/NNNN-*.patch 并加进 engine/upstream.json，或放进
   engine/plugins/（构建时自动拷贝）。当前 build 树里有一堆 fprintf 诊断，
   **下次 -Clean 会自动消失**（好事）。
3. **浏览器/Service Worker 缓存曾让新 wasm 不生效数小时**。部署新引擎后：
   给 wasm 用**唯一文件名**（改 d5-product/engine/krkrsdl2.js 里
   var f="krkrsdl2.wasm"; 为新名，如 krkrsdl2-f241.wasm），driver 里
   --disable-http-cache + CDP Network.setCacheDisabled + 清
   serviceWorker registrations + caches.keys()。参考 .tmp/d5_fprintf2.js
   的完整写法。
4. **诊断日志计数上限陷阱**：之前给日志加了 if (count++ < 60) 限制，游戏
   启动 35 秒内就耗尽，导致"日志不出现"误判为"代码没执行"。诊断日志要么
   无上限，要么只在目标事件类型时输出。
5. **补丁文件是 LF**；上游 krkrsdl2 部分文件是 **CRLF**（如
   ScriptMgnIntf.cpp、EventIntf.cpp）、部分是 LF（如 SDLApplication.cpp）。
   用 python 改文件时先探测 b'
' in src[:2000]。写 patch 时上下文行号
   必须以"按顺序应用补丁后"的文件为准（apply_patch.py 有偏移搜索兜底）。
6. **emcmake 的 stderr 输出**：后台跑 build_d3.ps1 不要加 2>&1 管道
   （$ErrorActionPreference='Stop' 会把 stderr 当错误抛）；直接
   & .	oolsuild_d3.ps1 即可。
7. **TJS 字符串在 wasm 里是 UTF-16 存储**，ASCII 搜不到（如搜
   "KRKR2WEB_..." 要用 UTF-16 编码搜索）。
8. **FuncCall 返回值**：0 = TJS_S_OK；-1001 = TJS_E_NOTIMPL（成员不存在）。

## 5. 下一步任务（按优先级）

### 5.1 确认 -1001 是哪个事件（最高优先，直接关系 [s] 能否响应）

在 build 树 external/krkrz/base/EventIntf.cpp 的 tTVPEvent::Deliver
（FuncCall 处，现有 fprintf(stderr, "KRKR2WEB_TJSCALL_RET %d
", ...)）把
EventName 一起打出来（ttstr 是 UTF-16，需要转窄或用 TVPUtf16ToUtf8；偷懒
办法是只打 EventName 长度 + 前两个 wchar 码点）。预期看到 onHitTest 返回
-1001。然后：

- 若确认是 onHitTest：查 krkr2 官方引擎如何实现窗口命中测试
  （external/krkrz/visual/win32/WindowFormUnit.cpp 与 sdl2 的
  src/core/visual/sdl2/WindowImpl.cpp，grep OnHitTest），把 sdl2 版补齐
  （图层树 LayerTreeOwner 命中 → 返回图层对象）；或在游戏脚本层垫
  （看游戏 mainwindow.tjs 对 onHitTest 返回 void 时的行为）。
- 若 -1001 是别的事件：按事件名决定实现或垫片。

### 5.2 让 title.ks 的 [s] 响应点击 → 标题画面出现

[s] 通过后游戏会走到 custom.ks 的 *title（标题背景 title_bg.png + UI）。
届时观察：图片是否开始加载（d5CompatState().readCalls 变化）、画面是否渲染。
画面仍然黑的话，查渲染链：

- 图片加载：TVPInternalLoadGraphic → WebP 路由（已工作，loadImages 无异常）。
- 图层合成：krkrsdl2 的 Layer::OperateRect / DrawDevice 链（无 RenderManager）。
  可在 Layer 绘制入口加日志确认图层是否被 draw。

### 5.3 剩余插件（按游戏实际触及顺序）

- **KAGParserEx**（kag.setMessageHook，keybinder.tjs 报错但被捕获）：
  参考 wtnbgo/KAGParserEx，需先克隆（未在本地仓库）。
- **extrans / extNagano**：转场（mosaic/ripple/rotate ~3200 行），
  kirikiroid2-web 参考在 cpp/plugins/extrans，依赖 RenderManager，需适配到
  krkrsdl2 的绘制模型。
  2026-08-15 起已用补丁 0039 临时降级：7 个 extrans 转场名回落到内置
  crossfade（日志 KRKR2WEB_D5_TRANS_FALLBACK），option.ks/load.ks 的
  "Cannot find transition handler wave" 致命错误已解除；真移植后自动失效。
- **真实 layerExDraw**：参考 kirikiroid2-web（libgdiplus+Cocos2D 后端），
  krkrsdl2 无此栈；当前 stub 已让游戏跑过 custom.tjs（注意 stub 不能注册
  clear——游戏会向 Layer 实例赋值 .clear，见 plugin 内注释）。
- **motionplayer 真实动画**（.mtn）：约 60 源文件，重。
- **extNagano**：游戏特有，源未定位。

### 5.4 存读档

存档写入已绕过 zlib（补丁 0009）。剧情推进后实测存读档全流程。

### 5.5 真机验收（最后一步，需人工/真机）

20 FPS / 60 分钟稳定性。目标 WebView 89 无 SW/SAB——诊断页的 SW 只是测试
便利，正式产品路径不能依赖。

## 6. 本轮（转接前）未收尾事项

- build 树里残留 fprintf 诊断（KAGParser/SDLApplication/WindowImpl/
  WindowIntf/EventIntf）——下次 -Clean 自动消失，无需手动清理。
- d5-product/engine/ 下堆了 krkrsdl2-f238/f239/f240/f241.wasm 等临时文件，
  可清理（保留 krkrsdl2.js + 一个 wasm 并把 js 里的 var f= 指回正确名）。
- patch 0035 的注释已在 build_d3.ps1 与提交信息中说明。
- goal 系统：本会话曾建 goal-ec29bc3a-7114-41f5-b76c-a962d51383d4
  （目标 = D5 完成），转接时若 goal 仍 active 可继续用；当前 get_goal 返回
  null，新 agent 可按需自行 create_goal。

## 7. 关键文件速查

| 文件 | 作用 |
| --- | --- |
| engine/upstream.json | 构建锁：补丁列表 + sourceImports |
| engine/patches/0034-kag-diagnostics.patch | KRKR2WEB_SCENARIO/LABEL 日志 |
| engine/patches/0035-emscripten-input-path.patch | 鼠标/键盘输入断点修复（历史核心） |
| engine/patches/0074-web-touch-multi-finger.patch | 触摸多点投递（touchPointCount 查询族） |
| engine/patches/0075-k2compat-touchmouse-shim.patch | TouchMouse 垫片（双指点按=右键） |
| engine/patches/0078-win32dialog-messagebox-page-ask.patch | messageBox 页面对话框桥（退出确认真应答） |
| engine/plugins/layerExDraw.cpp | stub（勿注册 clear） |
| tools/apply_patch.py | Python 补丁应用器 |
| tools/build_d3.ps1 | 构建流水线 |
| probes/d5-compat/web/app.js | 诊断页逻辑（log 收集、start） |
| .tmp/d5_fprintf2.js | 清缓存+点击+关键日志的 driver |
| .tmp/title_ks.txt | 已抽取的 title.ks（游戏脚本） |
| docs/15-d5-compat-status.md | 中期状态文档（与本文件互补） |
