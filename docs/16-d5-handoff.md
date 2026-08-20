# D5《千恋万花》交接文档（转接给下一个 Agent）

> 本文档是 krkr2web 项目 D5 阶段（《千恋万花》兼容与性能）的完整交接记录。
> 新 Agent 请**先通读全文**再动手，尤其是「环境陷阱」一节——那里记录了几个
> 会浪费大量时间的非显而易见问题。
>
> 最近提交：3d70046 / 7cdaf73（git log --oneline 可看全部历史）。

---

## 0. 2026-08-15 最新状态（优先于旧章节）

真实《千恋万花》已经从简体中文标题页进入 `CHAPTER 1-1`，剧情文字正确渲染，
不再处于本文件旧版所述的黑屏、`[s]` 输入、`uiloadSetRect` 或 `start.ks:43`
阻断。最终验证无致命弹窗、`firstError=null`，且 4.04 GB 缓存身份未变化。

本轮在标题页里程碑之后完成：

- `0035-emscripten-input-path.patch`：SDL 事件观察器改为排队，避免 DOM 回调
  嵌套执行游戏逻辑而破坏 Asyncify；
- `engine/plugins/textrender/TextRender.cpp`：21 处真假转换显式调用
  `operator bool()`，修复 Integer-to-Object 崩溃；
- `senren-banka-v1.json`：增加 `-deffont=Source Han Sans SC`，剧情字体不再
  依赖 WebAssembly 环境中不存在的 Android 系统字体；
- `0038-ogg-vorbis-streaming.patch` 与 `engine/audio/OggVorbisDecoder.cpp`：
  OGG 流式解码，控制长音频的内存峰值；
- `apps/web/player.js`：在启动点击手势中创建 AudioContext，并让 OpenAL 复用，
  标题随机角色语音已验证产生非静音 PCM；
- `apps/web/save-manager.js`：本机存档查看、分类、选择删除和全部删除；
- 同页强制重启与崩溃恢复：同步存档后销毁旧 Wasm/IDBFS/XP3/AudioContext，
  替换 Canvas 并创建新实例，URL 不变，断网恢复不产生网络请求。

自动化现状：20 项 Python 测试通过；D4 浏览器回归验证断网启动、音频上下文、
存档删除、主动重启和模拟致命弹窗恢复，启动及重启均为 0 网络请求。下一项是
目标 WebView 实机复核上述用户可见行为，再继续推进真实存读档、长剧情和稳定性。
motionplayer 动画及 WMV/AlphaMovie 视频仍未实现；视频仍是后续版本硬性范围。

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

- engine/ ：**项目自有资产**（git 跟踪）。engine/patches/*.patch（34 个）、
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
| engine/patches/0035-emscripten-input-path.patch | **输入断点修复**（本轮核心） |
| engine/plugins/layerExDraw.cpp | stub（勿注册 clear） |
| tools/apply_patch.py | Python 补丁应用器 |
| tools/build_d3.ps1 | 构建流水线 |
| probes/d5-compat/web/app.js | 诊断页逻辑（log 收集、start） |
| .tmp/d5_fprintf2.js | 清缓存+点击+关键日志的 driver |
| .tmp/title_ks.txt | 已抽取的 title.ks（游戏脚本） |
| docs/15-d5-compat-status.md | 中期状态文档（与本文件互补） |
