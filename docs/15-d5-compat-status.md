# D5《千恋万花》兼容与性能：现状与缺口

> 本文是 D5 阶段的中期工程记录，随开发进展持续更新。D5 门禁定义见
> [开发路线图](10-development-roadmap.md#d5千恋万花兼容与性能)，
> 首版通过条件见 [测试与验收](07-test-acceptance.md#千恋万花首版通过条件)。

## 2026-08-15 剧情首屏与崩溃恢复里程碑

真实《千恋万花》已经从完整简体中文标题页进入 `CHAPTER 1-1`，底部剧情文字
可正确渲染。最终本机 Chrome 验证为：XP3 读取无错误、`firstError=null`、无
致命弹窗，标题页配色与用户提供的基准一致。4.04 GB 已缓存游戏资源的内容版本
和 IndexedDB 身份保持不变，用户无需重新下载。

标题页之后新增或完成的关键兼容修复如下：

1. 补丁 0035 调整 SDL 输入路径，事件观察器只负责排队，游戏逻辑回到主循环
   执行，避免 DOM 回调嵌套进入 Asyncify；
2. `TextRender.cpp` 中 21 处真假值读取改为显式 `tTJSVariant::operator bool()`，
   修复 `start.ks:43` 的“Cannot convert the variable type ((int)0 to Object)”；
3. 《千恋万花》配置增加 `-deffont=Source Han Sans SC`，WebAssembly 不再依赖
   Android 系统中并不存在的 `Noto Sans CJK JP`，剧情字体加载成功；
4. OGG 改为流式 Vorbis 解码，避免把长音频一次性完整展开到内存；
5. 用户点击“启动游戏”时预先创建处于 `running` 状态的 AudioContext，OpenAL
   复用该上下文，标题页随机角色语音不再因脱离用户手势而静音。

产品壳同时增加了两项崩溃恢复能力：

- “存档”页可以按剧情、快速、系统和其他类别查看本机文件，显示修改时间和
  大小，并支持删除选中或删除全部；删除前会先停止引擎并解除 IDBFS 占用。
- 播放器和游戏库均提供“强制重启”。重启会在同一 HTML 和同一 URL 内同步
  存档、终止旧 Wasm、释放 IDBFS/XP3/音频资源、替换 Canvas，再创建全新引擎
  实例。播放器会捕获致命弹窗，崩溃后再次启动自动执行这条恢复流程。

`tests.test_d3_tools`、`tests.test_d5_profiles`、`tests.test_d5_tools` 共 20 项测试
通过；D4 浏览器回归覆盖断网零请求启动、存档管理、主动重启和模拟崩溃恢复。
下文较早的“黑屏/标题未渲染/输入阻断”内容仅保留为历史排障依据，不再代表
当前状态。

当前下一验收点是真机复核标题语音、新游戏剧情首屏、存档列表和强制重启；随后
继续推进真实存读档、长剧情兼容和稳定性。motionplayer 动画与 WMV/AlphaMovie
视频仍未实现，其中视频是后续版本的硬性范围，不得从路线图移除。

## 当前结论

真实《千恋万花》三个 XP3（合计 4,044,268,983 字节）已能通过 D5 兼容探针
在本机 Chrome 无头启动，引擎成功走完：

1. XP3 索引读取与文件树重建：Total 39946 file(s) found, 39854 activated；
2. 真实 startup.tjs / boot.tjs 与全部游戏系统脚本（约 14 秒）加载执行；
3. 字体加载（内嵌开源字体 + 思源黑体 B / 繁体）；
4. 真实 .ks/.tjs 字节码与 KAG 系统脚本闭环。

引擎启动阶段累计读取约 848 MiB、211 次 XP3 读取、零读取错误；索引段 adler32
校验值 665521678 与预期一致。这说明 D0-D4 的 XP3 分块读取、TJS、KAG 和
Asyncify 桥对真实游戏资源是成立的。

首个硬阻断（写压缩存档时 zlib deflate 的“null function”崩溃）已通过
引擎补丁 0009 绕过：Web 构建下把 z 压缩模式降级为简单加密（mode 1），
读写两端都从 0xfe 0xfe 头自动识别模式，本地存档自洽。随后 motion.tjs 的
阻断通过补丁 0010 的最小 Motion.ResourceManager 垫片跨过。游戏现在推进到
csvParser（配置 CSV 解析）与 kagenvironment（KAG 命令初始化）两个新的
可捕获异常，详见“已知问题”。整体说明 D0-D4 的读取/脚本/渲染管线对真实
游戏资源持续成立，剩余工作集中在逐插件垫片与真实立绘/图层实现。

### 图像格式重大发现（2026-08 更新）

对 XP3 内图像采样发现：《千恋万花》几乎所有光栅图像都用 **WebP** 存储，
只是保留了 .png/.jpg/.tlg 扩展名（76/80 .png、40/40 .jpg、40/40 .tlg 采样均为
WebP，magic = RIFF...WEBPVP8）。另有：

- `.pimg`（155 个）→ PSB（Photoshop Big，magic "PSB\0"），需 psbfile 插件；
- `.sli`（9758 个）→ 自研分层图（magic "#2.0"），需 layerEx 系插件。

因此 krkrsdl2 原生的 PNG/JPEG/TLG 加载器无法解码这些文件。已接入 **libwebp**
（源码 `参考资料/开源项目/libwebp`，decode 子集 29 个 .c）+ 适配版 WebP 加载器
（`engine/webp/LoadWEBP.cpp`）+ `TVPInternalLoadGraphic` 的 WebP magic 探测路由
（补丁 0025-0026），.png/.jpg/.tlg 现已能按 magic 自动路由到 WebP 解码。

## 静态扫描结果

tools/scan_xp3_compat.py 对三个 XP3 的扫描结果（39,951 个条目、7.34 MiB
脚本字节）：

| 档案 | 大小 | 条目 | 保护条目 | 索引 |
| --- | --- | --- | --- | --- |
| data.xp3 | 2,312,777,571 | 39,045 | 0 | 2 段 / 展开 5,648,096 字节 |
| adult.xp3 | 306,995,899 | 878 | 0 | 2 段 / 展开 123,176 字节 |
| video.xp3 | 1,424,495,513 | 28 | 0 | 2 段 / 展开 3,838 字节 |

脚本统计：扫描 297、可解码 103、字节码 193；唯一解码错误是
uipsd/langselect.ini（二进制 ini，非阻断）。

主要媒体类型：.ogg 26,261、.sli 10,003、.tlg 1,716、.png 689、.jpg 236、
.pimg 229、.opus 55、.mtn 33、.wmv 28、.tft/.ttf/.otf 37。视频 28 个 WMV
按 D6 延后。

## 插件清单与缺口

游戏实际在启动期 Plugins.link 的插件（来自真实启动日志，优先级高于静态
扫描的“提及”统计）：

| 插件 | 当前处理 | 说明 |
| --- | --- | --- |
| motionplayer.dll | 最小垫片（补丁 0010） | 立绘动画（.mtn）；仅 ResourceManager 桩，真实动画未实现 |
| menu.dll | TJS 垫片（补丁 0007） | 菜单类；游戏 fallback menubarhack 已走通 |
| addfont.dll | TJS 垫片（补丁 0008） | 字体注册映射到 Font.addFont |
| fstat.dll | ✅ NCB 真注册（补丁 0011-0017） | 文件 stat/改名/删除；deleteFile 空路径异常已修（补丁 0023） |
| getSample.dll | ✅ NCB 真注册 | WaveSoundBuffer.setDefaultAheads/enableGetSample（voice.tjs 异常解除） |
| scriptsEx.dll | ✅ NCB 真注册 | Scripts.foreach/equalStruct 等（kagenvironment 异常解除） |
| csvParser.dll | ✅ OLD tp_stub 真注册（补丁 0018-0019） | CSVParser 全局类（配置 CSV 解析异常解除） |
| getLangName.dll | ✅ TJS 垫片（补丁 0021） | System.getCurrentUILangName 回落 ja/日本語 |
| windowEx.dll | ✅ TJS 垫片（补丁 0022） | Window.getNotificationNum/setDispMode（getNotificationNum 异常解除） |
| k2compat.dll | ✅ TJS 垫片（补丁 0075） | Window.TouchMouse 触摸手势（双指点按=右键），见文末触摸章节 |
| KAGParserEx.dll | no-op | KAG 解析扩展；缺 kag.setMessageHook（keybinder.tjs 当前阻断） |
| layerExImage/Raster/Draw/BtoA.dll | no-op | 图层扩展；缺 Layer.loadImages（sqscr.tjs 当前阻断） |
| textrender.dll | no-op | 文本渲染（kirikiroid2-web 有参考实现） |
| PackinOne.dll | no-op | 打包档案 |
| proxyfs.dll | no-op | 代理文件系统 |
| win32dialog.dll | no-op | 桌面对话框，Web 无对应 |
| wuvorbis.dll / wuopus.dll | no-op | 音频解码；引擎原生声轨应覆盖 .ogg/.opus |
| AlphaMovie.dll | no-op | 带 alpha 视频（D6 范畴） |
| yuzuex/psbfile/psd/extnagano 等 | 尚未 link 或触及 | 柚子社/PSB 图像，随剧情推进用 |

除上述已打点的插件外，静态扫描还列出若干仅打包未主动链接的 DLL
（krkrsteam.dll、krmovie.dll、lzfs.dll、steamdrawdevice.dll、win32ole.dll、
kagexopt.dll 等），以及大量仅字节码提及的 DLL。这些暂不阻断启动，等剧情走到
相应功能再逐个评估。

## 已知问题

### 1. zlib deflate 写存档时 “null function” 崩溃（已绕过）

写压缩存档时调用链为 tTVPTextWriteStream → deflateInit_ → deflateInit2_ →
deflateReset → deflateResetKeep，其中 deflateResetKeep 对 adler32 的调用生成
了指向空函数的 call 0，触发 RuntimeError: null function（栈：
dynCall_v → invoke_v → deflateResetKeep → deflateReset → deflateInit2_ →
deflateInit_ → tTVPTextWriteStream）。

已排查并排除：GZIP 路径（-DNO_GZIP）、链接期 --no-heap-copy 与 -fPIC、
编译期 -fPIC 完整去除、zlib 去掉预编译头（PCH）、以及 -sASYNCIFY_REMOVE
排除 zlib 插桩——均仍崩。inflate（解压）路径工作正常，说明同一 zlib 的 adler32
从 inflate 侧可正常调用；问题特异于 deflate 侧对 adler32 的调用被改写为指向
空函数的间接调用（call 0 → invoke_v → dynCall_v → null）。

已采用的绕过方案（引擎补丁 0009）：Web 构建下把 tTVPTextWriteStream 的
z 压缩模式降级为简单加密（mode 1），避免进入 deflate 路径。读写两端都从
0xfe 0xfe 头自动识别模式，本地存档自洽。该方案已在本机无头 Chrome 验证
跨过存档写入，游戏继续推进到 motionplayer 初始化。

根因仍未定位（疑似 Asyncify 全量插桩对 zlib deflate 链路的误改写，但
ASYNCIFY_REMOVE 未消除）。若后续发现其他必须走 zlib deflate 的路径，仍需
回到根因：用 -sASYNCIFY_ONLY 只插桩真实的 IndexedDB 读取异步入口，避免
全量插桩 zlib。

### 2. motionplayer 缺失（部分垫片，仍缺真实动画）

motion.tjs 执行 new Motion.ResourceManager(this, 20971520) 时
Motion.ResourceManager 为 void。已通过补丁 0010 提供最小
KRKR2WebMotionResourceManager 类（isExistMotion 恒 false、findMotion/
getMotion/loadMotion 返回 void、unload/clear 空实现），motion.tjs 初始化
不再抛异常。但这只是垫片：真实立绘动画（.mtn 33 个）尚未实现，游戏后续
调用 Motion.Player 播放动画时会走空路径。完整实现需端口
参考资料/开源项目/kirikiroid2-web/cpp/plugins/motionplayer/（约 60 个源文件、
含 EmoteEngine/Player 等完整动画引擎，工作量大）。

### 3. csvParser 缺失（已解决）

已按 OLD tp_stub 系统从 wtnbgo/csvParser 真移植（补丁 0018-0019）：剥掉
DLL 导出/导入桩机（V2Link/V2Unlink，因 krkrsdl2 无 import-stub 运行时），
改用 KAGParser 同款 classid 适配（TJS_NATIVE_SET_ClassID 重定义 + TJS_NCM_REG_THIS
= classobj），并从 Plugins.link("csvParser.dll") 直接调 csvparser_init()。
启动日志输出 KRKR2WEB_D5_PLUGIN_TJS csvParser.dll，CSVParser 全局类注册成功。

### 4. kagenvironment.tjs initCommand 异常（已解决）

根因是 Scripts.foreach 缺失（scriptsEx 插件）。已从 krkr2 真移植 scriptsEx.cpp
（NCB，补丁 0020），Scripts.foreach/equalStruct 等注册成功，kagenvironment
异常解除。

### 5. getLangName / windowEx（已垫片）

getLangName（System.getCurrentUILangName，补丁 0021）与 windowEx
（Window.getNotificationNum/setDispMode，补丁 0022）已用最小 TJS 垫片补齐，
voice/multilang/keybinder 的 Window 消息计数路径不再抛异常。

### 6. kag.setMessageHook 缺失（当前阻断，KAGParserEx）

keybinder.tjs 调用 kag.setMessageHook(true, num) 抛“成员不存在”，该方法是
KAGParserEx（wtnbgo）给 kag 对象加的 KAG 扩展，krkr2/kirikiroid2-web 参考仓库
均无实现，需从 wtnbgo/KAGParserEx 克隆移植。

### 7. sqscr.tjs loadImages（已解决 → WebP）

loadImages("sqscrmask") 的异常实为 **PNG Read Error /Not a PNG file**：
sqscrmask.png 实为 WebP。已接入 libwebp + WebP 加载器 + magic 探测路由
（补丁 0024-0026），序列屏图像加载通过。

### 8. psdlayer.tjs loadPIMG（已解决 → psbfile）

已从 kirikiroid2-web 移植 psbfile 插件（PSBFile/PSBRawFile/PSBMedia，NCB），
配套补丁：tTJSString 增加 IndexOf/SubString（补丁 0028）、iTVPStorageMedia
补虚析构。PSBFile 类注册成功，loadPIMG 阻断解除。

### 9. 启动脚本完整跑通 ✅（2026-08 里程碑）

**“(info) Startup script ended.” 首次出现**——真实 startup.tjs → boot.tjs 全链
跑通，游戏进入主循环。插件注册现状：fstat/csvParser/getSample/scriptsEx/psbfile
真注册，motionplayer/menu/addFont/getLangName/windowEx 垫片，其余
（textrender/layerEx*/KAGParserEx/savestruct/extrans/extNagano/PackinOne）仍 NOOP。

画布目前仍基本空白（950x950 画布 54 种颜色、109 个非暗像素，90 秒无变化，
点击/键盘无响应）。已真注册 textrender + layerExImage（补丁 0030），但画面未出现：
标题画面可能依赖 layerExDraw（krkr2 版需 blend2d + OpenCV，重型）/layerExRaster/
layerExBtoA（wtnbgo，未克隆），且游戏在主循环中停止推进（XP3 读取无挂起，
274/274 完成），疑似等待未达成的资源/渲染同步。

### 10. Scripts.clone/PSB 名称异常（已解决）

根因是 PSB 名称解码产生无效 CP932 字节，`tTJSString` 窄→宽转换
（`SetString` 的 `SJISToUnicodeString`）返回 -1 并抛“Cannot convert given narrow
string to wide string”。已通过补丁 0031 把窄→宽转换宽容化（无效字节回退为
逐字节 wide char），loadPIMG 异常解除。

### 11. 主循环在跑但标题画面不渲染（已定位到输入链路，部分解决）

帧计数诊断确认主循环存活（约 8 FPS，90 秒 720 帧），XP3 读取全部完成、
画布基本空白。游戏已推进到 title.ks 的 `[s]`（等待输入）——KAG 流程
first.ks → version.ks → title.ks 全部加载（KRKR2WEB_SCENARIO 诊断确认）。

输入链路逐级诊断结论（2026-08-14）：

1. 浏览器事件 → SDL：✅（KRKR2WEB_SDL_EV 1024/1025/1026 即
   MOUSEMOTION/DOWN/UP 均到达）。
2. **emscripten 输入断点（已修复）**：krkrsdl2 上游在 emscripten（非 pthreads）
   下 `window_receive_event` 的 default 分支用 #if 排除了
   `window_receive_event_input` 调用（依赖 SDL_AddEventWatch 的 watch 回调，
   而该回调在本环境从不触发）→ 鼠标/键盘事件被静默丢弃。已通过补丁 0035
   在 emscripten 下也走 input 路径。
3. SDL → 窗口 → TVPPostEvent → TJS FuncCall：✅ 全链验证（ISVALID res=1、
   TJSCALL_RET 0 即回调执行成功）。
4. **当前残余**：游戏的 onMouseDown/onClick TJS 回调执行成功但 KAG 的 [s]
   未推进（tag 日志停在 s）。FuncCall 存在个别 -1001（E_NOTIMPL，疑似
   onHitTest 命中测试未实现）——游戏可能因点击命中测试失败而忽略输入。
   下一轮验证 onHitTest 并决定是否实现 Layer 命中测试。

### 12. 剩余插件源已定位（kirikiroid2-web 全量）

kirikiroid2-web/cpp/plugins 含全部剩余插件。已移植 layerExRaster + layerExBTOA +
PackinOne（补丁 0032，PackinOne 批量加载 8 子插件含这俩）。extrans（mosaic/
ripple/rotate/turn/wave）依赖 kirikiroid2-web 的 RenderManager（iTVPRenderManager/
iTVPTexture2D），krkrsdl2 无此层（只有 Layer::OperateRect/tTVPBaseBitmap），需适配。
layerex_draw/general 后端为 libgdiplus。extNagano 不在其中（游戏特有，待查）。

## 构建流水线修复（2026-08-14）

DSH 沙箱内发现 git.exe 的文件视图与其他进程隔离（git hash-object 对 11 字节
文件算出 12 字节内容的哈希、git apply 对逐字节一致的上下文报不适用、写入
不落真实磁盘）——git apply 全部“假成功”。已改为 **Python 补丁应用器**
（`tools/apply_patch.py`，支持多文件/hunk 偏移搜索/空白容忍/CRLF/无
diff --git 头的补丁），build_d3.ps1 打补丁阶段不再 git init。补丁 0034
（KAG SCENARIO/LABEL 诊断）与 0035（emscripten 输入路径）已入列，全量
重建（34 补丁）验证通过。

## 下一步

按 ADR-008 从 krkr2 真移植 NCB 框架与插件（不再手写 TJS 桩）：

1. ✅ NCB 框架 + fstat 已正式接入（补丁 0011-0017）。
2. ✅ 纯逻辑插件批量推进：csvParser（OLD tp_stub 系统，补丁 0018-0019）、
   getSample + scriptsEx（NCB，补丁 0020）、getLangName/windowEx 垫片
   （补丁 0021-0022）、fstat deleteFile 空路径修复（补丁 0023）。
   启动日志确认 6 个插件已真注册/垫片，voice/multilang/kagenvironment/mainwindow
   4 处启动异常解除。
3. ⏳ 视觉层插件（KAGParserEx 的 kag.setMessageHook、layerEx 的 loadImages、
   layerex_draw、layerExImage、textrender）——当前 2 处残留阻断；需克隆
   wtnbgo/KAGParserEx 与 wtnbgo/layerExImage。
4. ⏳ 重型逆向插件（motionplayer/Emote、psbfile、PackinOne，参考
   参考资料/开源项目/kirikiroid2-web/cpp/plugins/）。
5. ⏳ 目标 WebView 89 实机验收（20 FPS、60 分钟稳定性）——需真机人工执行。

## 插件移植摸底（ADR-008 验证）

用 emcc 直接编译 krkr2 的 NCB 框架与 fstat 插件、对照 krkrsdl2 的 krkrz 引擎，
实测得到可移植性结论：

1. NCB 框架（ncbind.hpp / ncb_invoke.hpp / ncb_foreach.inc / ncbind.cpp）能直接
   对 krkrsdl2 的 krkrz 编译，只需补一个缺失的 include <set>（libc++ 与 libstdc++
   差异）。说明 TJS2 核心、ScriptMgnIntf、MsgIntf、DebugIntf、CharacterSet 等
   引擎接口在两边基本同构，ADR-008 的“从 krkr2 移植”方向成立。
2. 插件额外依赖 spdlog：krkr2 插件只用 spdlog::get + logger->warn/info 打诊断，
   已用一个约 30 行的无 fmt 依赖 spdlog 桩满足（kirikiroid2-web 的 cmake/spdlog_stub
   可作为参考）。
3. fstat 实测编译暴露 9 处错误，可归类为三块适配：
   - 缺失 include（<sstream> 等）——机械补；
   - UTF-8 std::string 与 UTF-16 ttstr 互转（ttstr+std::string、ttstr(std::string)、
     返回 std::string 到 ttstr）——krkr2 的 TJS2 字符串层支持、krkrsdl2 不支持，
     需引入 detail::narrow / detail::widen 这类转换层（kirikiroid2-web 已有同款）；
   - Storage API 差异（TVPNormalizeStorageName 等）——krkr2 的 StorageImpl.h 与
     krkrsdl2 的 StorageImpl.h 不同，需按函数逐个适配或垫片。

结论：NCB 框架近乎零成本可搬；每个插件仍需一层“字符串转换 + Storage API 适配”，
这层适配是分摊成本，第一个插件（fstat）打通后即可复用。

### fstat 编译验证（2026-08-14 更新）

实测 fstat/main.cpp 已能对 krkrsdl2 编译通过，全部适配收敛为 4 项：

1. ncbind.hpp 补 include <set>；
2. fstat/main.cpp 补 include <sstream>；
3. 约 30 行的无 fmt spdlog 桩；
4. tTJSString 增加 tTJSString(const std::string&) 单行构造（走现有 tjs_nchar 窄串
   构造，即 UTF-8 → UTF-16）。

此前担心的 TVPNormalizeStorageName 差异实际是字符串构造失败引发的级联错误，
补上第 4 项后自动消解。

### 链接分析（2026-08-14 更新）

用 llvm-nm 对照 fstat.o / ncbind.o 的未定义符号与 krkrsdl2 引擎（.a 与 .wasm），
得到精确缺口：TJS2 核心符号全部命中；引擎 TVP 符号大部分命中
（TVPNormalizeStorageName、TVPGetLocalName、TVPGetPlacedPath、
TVPGetTemporaryName、TVPExecuteExpression、TVPAddLog、TVPThrowExceptionMessage、
TVPClearStorageCaches 等）；仅以下约 7 组文件/存储函数缺失，需写“存储兼容垫片”：

- TVPGetAppStoragePath、TVP_stat、TVP_utime
- TVPCopyFile、TVPDeleteFile、TVPCreateIStream
- TVP_md5_init / TVP_md5_append / TVP_md5_finish

这些在 Web 目标上都可垫（stat/复制/删除映射到现有 Storage，MD5 自实现，
AppStoragePath 返回固定路径）。至此 fstat 移植的完整成本已收敛并量化：
NCB 框架 + 字符串构造 + 日志桩 + 少量缺失 include + 上述存储垫片。

## extrans 转场降级 + 主循环强制终止（2026-08-15）

真机报告（20260815-091615）确认：系统设置 option.ks:22 与剧情树 load.ks:23
请求 `[trans type=wave]`，extrans 未注册导致致命错误
"Cannot find transition handler wave"，两个页面全部卡死。

**决策**：extrans 完整移植依赖 kirikiroid2-web 的 RenderManager（见 §12），
成本高；先保功能、舍特效。补丁 0039 在 `TVPFindTransHandlerProvider` 的
Emscripten 分支里，对 extrans 的 7 个转场名（wave/mosaic/turn/rotatezoom/
rotatevanish/rotateswap/ripple）找不到 provider 时打印
`KRKR2WEB_D5_TRANS_FALLBACK <name>` 并回落到内置 crossfade。页面内容与
交互完整保留，仅不复刻波浪/旋转等视觉特效。若后续真移植 extrans，
provider 注册后该回落自动失效（只在 Find 失败时介入）。

同补丁为 kremscripten.cpp 增加 `forceTerminate` JS 绑定
（`emscripten_cancel_main_loop`），播放器重启链路随之改造：

- 普通重启（restart）：显示状态 → syncSaves(force) → forceTerminate →
  重建实例。不再等待引擎自行退出（此前崩溃后重启无响应的根因——
  停止流程会 await 已死的 TJS 协程）。
- 强制终止（forceStop）：跳过存档同步，直接 forceTerminate。

### Windows 构建流水线修复（本机原生构建）

此前构建在 DSH 沙箱（Linux）执行；本机（Git Bash/PowerShell）首次构建
暴露两个问题，均已修复：

1. GNU tar 把 `D:\...` 当 host:path 远程地址（"Cannot connect to D:"）。
2. 源码库 7 个 symlink（全部在 android-project/ 脚手架）无法在无特权
   Windows 上创建。

修复：新增 `tools/extract_tar.py`（Python tarfile 提取，symlink 物化为
含目标路径的纯文本——与 git core.symlinks=false 检出一致），build_d3.ps1
的 tar 调用全部换成该工具；git archive --output 保持绝对路径（相对路径
会落进 -C 目录污染上游检出）。单测
`test_source_export_extractor_materializes_symlinks` 覆盖。

### 真机验证（2026-08-15 18:03 报告 20260815-100305）

补丁 0039 后首次真机回归：系统设置（option.ks）与剧情树（load.ks）均可
正常进入，全报告无 "Cannot find transition handler"、无致命 alert、无崩溃。
标题流程完整（title.ks → *wait，VORBIS_STREAMING_READY 即 BGM 流式播放正常），
工具栏强制终止正常（stopReason=player-toolbar，报告于停止后成功上传）。
注意 engineLog 为 96 行环形缓冲，仅覆盖最后一个会话——本轮报告的日志段
不含设置/剧情树访问痕迹属预期，以用户确认 + 零 wave 报错为准。

剩余 NOOP：extrans.dll（转场已由 crossfade 降级承接）、extNagano.dll
（游戏特有，仍未定位源）；motion.tjs load 启动异常仍存在（motionplayer
bootstrap-only，非致命）。

## 转场卡顿优化第一轮（2026-08-15 晚）

真机反馈：进标题、进设置、回标题等页面转场时画面与音频同时卡顿。
根因分析（无线程构建，一切都在主线程上）：

1. **图形缓存被禁用（主因）**：缓存上限 = 物理内存/10，但 Emscripten libc
   无 _SC_PHYS_PAGES 数据 → SDL_GetSystemRAM()=0 → SystemLimit=0 →
   TVPGraphicCacheLimit=0。游戏 1920x1050 全屏图（解码后 8MB/张）每次进
   页面都重新 XP3 解压 + WebP 解码，一次 0.5-2s 的主线程停顿。
2. **音频队列恢复过慢**：OpenAL 队列上限 16×125ms=2s，但补给速率只有
   125ms/60ms（每 tick 一单元），一次停顿后队列需数秒才能补满，期间
   任何再次停顿都会爆音。BGM 刚起播时队列很浅，最易爆音。
3. **转场逐帧全屏混合**：crossfade 每 tick 对 8MB×2 层做逐像素混合，
   弱设备上单帧 50-200ms（此为固有成本，本轮先不动，等 PERF 数据）。

补丁 0040 三项：
- SysInit：emscripten 下 SystemLimit 默认 128MB（-gclim 可覆盖），启动时
  若无人设置缓存则启用到上限，日志 KRKR2WEB_D5_GRAPHIC_CACHE <MB>。
- WaveImpl InternalTrigger：预算 8ms 循环补填直到队列满（FillBuffer 返回
  true 表示满/暂停/结束）。
- process_events：每 5s 输出 KRKR2WEB_D5_PERF ticks/avg_ms/max_ms/slow50
  逐帧耗时直方图（含 Asyncify 挂起等待），用于验证与定位下一瓶颈。

预期：回访页面（缓存命中）不再解码 → 卡顿大幅缩短；音频队列保持满
→ 停顿期间不再爆音。首次进页面仍有解码突发（无线程无法分片），由
PERF 数据决定是否做转场 30Hz 节流等第二轮优化。

### 补丁应用器加固（2026-08-15 晚，随补丁 0040 一轮）

首次构建 0040 时暴露 apply_patch.py 的一个静默截断缺陷：把"空上下文行"
写成真正的空行时，解析器将其视为 hunk 结束，后续 +/- 行被丢弃，而
check/apply 仍报成功（实际是原样换原样的 no-op）。导致 0040 只有
WaveImpl/SDLApplication 两个 hunk 落地，SysInit 缓存修复与 PERF 直方图
被静默丢弃。已修复并加单测：

- 空行后紧跟补丁内容行（+/-/空格开头）→ 按 git 宽容语义视为空上下文行；
- hunk 终止后出现孤儿 +/- 内容行 → 立即抛错（不再静默丢内容）。

教训：wasm 内只能验证字符串常量（GRAPHIC_CACHE/PERF 为 UTF-16 字面量
可查），局部变量名（fill_deadline）在 MinSizeRel 下会被剥离，不可作
验证依据；验证以源码树 + 构建管线严格检查为准。

### 真机缓存导致的"缺少引擎配置"（2026-08-15 晚）

重新部署优化构建后，真机报"无法启动游戏 缺少引擎配置：senren-banka-v1"。
服务端注册表完好（顶层 schemaVersion=1、含 senren-banka-v1），index.html
引用齐全——结论：Android WebView（Chrome 89）在服务器重启/重新部署后
对 no-cache 子资源使用了陈旧的 HTTP 缓存（旧版 engine-profiles.js 没有
顶层 schemaVersion，恰好触发 player.js 的注册表校验失败）。

修复（tools/stamp_build_versions.py，接入 prepare_d5_product.ps1）：
- 所有静态资源引用加内容哈希版本参数（?v=sha256[:8]），index.html 重新
  验证后只能拉到与哈希匹配的脚本，缓存自愈；
- player.js 内的 wasm URL 同样版本化（注意：必须先改 player.js 再算其
  哈希，否则 index.html 引用过期版本）；
- 诊断报告新增 engineProfiles 快照（schemaVersion + profileIds），
  下次报告可直接证明注册表加载状态。

## 性能第二轮 + 卡死取证（2026-08-15 深夜，补丁 0041）

报告 20260815-110112 的 PERF 数据（新增直方图首次真机数据）：

- 静止（标题 *loop）：ticks=437/5s avg 4ms max 34ms——60fps 完美；
- 转场窗口：ticks=94/5s（19fps）avg 45ms **max 1630ms**、另一窗 max 849ms
  ——卡顿全部集中在转场：每帧全屏混合（1920x1050，8MB/层×2）+ 首次
  进页解码突发（缓存只救回访）。

真机还报告新问题：对话页闲置一段时间后引擎整个卡死（只能强制终止）。
嫌疑：Asyncify 挂起的 DecompressionStream 读取承诺永不结算（0006 的
await 无超时），引擎静默挂起；但卡死会话日志被 96 行环形缓冲覆盖，
缺少直接证据。

补丁 0041 四项：
1. InvokeTransition 30Hz 节流（转场相位按墙钟推进，跳帧不延迟转场，
   只减半混合+合成成本）；
2. KRKR2WEB_D5_TRANS_STATS（time/process/blend/updates/fps，每次转场
   中点输出一行，复用 TVP_TRANS_SHOW_FPS 累计器，仅 emscripten 定义）；
3. 引擎 ~1Hz JS 心跳（64 tick 一次 EM_ASM 回调 krkr2webEngineHeartbeat）
   + player.js 看门狗：页面可见且主循环停跳 >5s → 状态栏报"引擎疑似
   卡死"+ errors 记录 KRKR2WEB_D5_STALL——下次报告可区分"挂起等待"
   与"正常闲置"，并保留卡死时刻；
4. 0006 解压读取加 30s 超时（Promise.race，超时走 catch 返回 -3 →
   引擎抛可见的存储错误，不再静默挂死）。

## 通用性原则与视频桥（2026-08-15 深夜，补丁 0042）

用户提出关键方向要求：不能针对千恋万花特调，需对所有 KRKR 游戏通用。
审计结论：

- **引擎层零游戏特调**：engine/patches、engine/plugins、engine/web 全文
  grep 无任何游戏名/厂商名。per-game 内容只存在于 engine/profiles/
  （这正是配置层的正确位置）。
- 观察到的两处行为差异（缺 logo/厂商页、标题语音时机）根因是**未实现的
  通用子系统**，不是特调：
  1. VideoOverlay 在非 Win32 下 Play() 是空操作 → 游戏 28 个 WMV
     （1.4GB，含 OP/ED/logo/厂商视频）全部静默跳过；
  2. motionplayer（.mtn Emote 动画）bootstrap-only 垫片 → 动画缺失/
     时机漂移（语音常与动画同步）。KAGParserEx 缺失也可能参与。

**通用视频桥**（补丁 0042，对任何 KRKR 游戏生效）：
- 引擎：VideoOverlay Open/Play/Stop/Pause 桥接到页面
  （krkr2webVideoOpen/Play/Stop/Pause，EM_JS）；播放结束时页面调
  krkr2webVideoEnded（embind）→ SetStatus(Stop) 走原生
  onStatusChanged 事件队列——游戏脚本观察到与 win32 krmovie 一致的
  播放语义。页面未定义钩子或无转码文件时保持原"跳过"行为。
- 页面：player.js 以 <video> DOM 覆盖层播放（对齐画布矩形，
  object-fit:contain），按存储名 basename 映射
  /videos/<gameId>/<stem>.webm；error/ended→回调引擎。
- 服务器：--video-directory 把 build/video-transcode/ 挂到 /videos/
  （resolve + is_relative_to 防穿越）。
- 转码工具 tools/transcode_game_videos.py：从游戏 XP3 提取视频扩展名
  文件 → ffmpeg 转 webm（VP8+Vorbis，Chrome 89 兼容），幂等可重跑。
  profile videoStrategy 更新为 webm-bridge。

已知限制（后续工作）：vomLayer 模式（视频进图层）暂以覆盖层呈现；
循环视频（loop=true）由引擎显式 Stop 结束；motionplayer/KAGParserEx
真移植仍是保真度差距的主要来源。

## 看门狗误报修复 + 卡死现场保存（2026-08-15 深夜二轮）

报告 20260815-114928 证实误报机制：PERF 显示标题加载窗口
avg_ms=35 max_ms=2117（单帧最长 2.1s），心跳按 64-tick 计数 → 墙钟
间隔轻松超 5s 阈值，而主循环存活（随后"已恢复"）。真实卡死现场再次
被后续会话的 96 行环形缓冲覆盖。

修复：
- 心跳改为每 4 tick（补丁 0041 更新），阈值 15s、恢复线 3s；
- 警报文案区分卡死类型：看门狗定时器本身能触发 → JS 事件循环存活
  → 引擎挂起在 Asyncify 等待（而非主线程同步阻塞）；
- terminateInstance 把 {stopReason, crashed, stalledAt, stallSilentMs,
  lastLog(40 行)} 存入 localStorage，报告新增 lastSession 字段——
  卡死后的重启不再销毁证据。

### 事故记录：player.js 语法损坏导致"无法读取游戏目录"（2026-08-15 深夜三轮）

上轮删除旧看门狗定时器时行号偏移多删了 krkr2webVideoPause 的闭合
"};"，player.js 整体解析失败 → window.krkr2Player 未定义 → 游戏库
报 "Cannot read properties of undefined (reading 'snapshot')"。
已修复并验证。防御：check_d4_artifacts.py 新增 --node 参数，prepare
自动用 emsdk 的 node 对全部 web 脚本做 --check 语法门禁（已做注入
损坏的反向验证，可拦截此类问题上线）。

## 闲置卡死根因定位与存储桥加固（2026-08-15 深夜四轮）

报告 20260815-121205 的 lastSession 现场给出决定性证据：

- stalledAt 12:11:57.870 / stallSilentMs 15271，看门狗定时器自身触发
  → JS 事件循环存活 → **引擎挂在 Asyncify 等待**（非主线程阻塞）；
- 冻结前最后一行日志是健康的标题循环（PERF ticks=426 avg 5ms）——
  无任何报错，引擎在两次正常帧之间静默；
- 每次冻结前均为 *loop + clickglyph.asd 重读周期。

根因定位（存储桥 probes/d3-engine/web/storage.js）：
1. loadChunk **每读一个块都 openDatabase()+close()**——标题闪烁图标
   每周期 2 次读取 = 高频开合连接，WebView 下 open 请求可能永不回调；
2. requestResult 不处理 **transaction.onabort**——中止的事务既不
   onsuccess 也不 onerror，承诺永不结算 → 引擎挂起。
两者都能造成"正常帧之间突然静默"的冻结形态。

修复（通用，所有游戏受益）：
- 持久连接（getDatabase 共享，onversionchange 自愈，releaseAll 关闭）；
- requestResult 增加 transaction.onabort 拒绝路径；
- 全部 IDB 操作 20s 超时（withTimeout）——即使再挂也转为可见的
  存储错误而非死等；
- 挂起操作追踪（window.krkr2webStorageTrace）+ 看门狗警报附带
  "挂起操作: op detail 已 N 秒"——若仍冻结，下一份报告直接点名
  挂起的操作与数据块。

## 流畅度/音频垫/退出误判三项（2026-08-15 深夜五轮，补丁 0043）

用户反馈：不再卡死，但不流畅、音频偶发断续、音频进度条常不动、
正常退出被判为卡死。

1. **正常退出误判**：引擎自杀路径（TVPSystemUninit → cancel_main_loop）
   从不通知页面，看门狗 15s 后误报。补丁 0043 在 cancel 前发
   EM_ASM(krkr2webEngineQuit)；player 响应 → 干净 stop（同步存档）
   → 自动回游戏库。
2. **音频偶发断续**：解码突发实测最长 ~2.1s，16×125ms=2s 队列刚好被
   打穿。队列上限提至 32×125ms=4s（OpenALWaveMixer.h）。
3. **渲染分辨率**：此前引擎按画布全分辨率合成（1920x1050），而游戏
   原生 1280x720——每帧多算 2.25 倍像素。profile display 改 720p，
   player 启动前把 canvas 内部分辨率设为 1280x720，CSS 拉伸铺满。
   这是最大的单项流畅度杠杆（合成/混合/上传全链路减 44% 像素量）。

待验证：音频进度条（GetCurrentPlaySamples→AL_SAMPLE_OFFSET，
emscripten sourceTell 依赖 bufQueue[0]，实现存在；若 720p 后仍不动，
下一轮用 PlaySoundPosition 诊断区分引擎侧/游戏 UI 侧）。

## 触摸手势链：CG 鉴赏双指退出（2026-08-21，补丁 0074-0075）

实机反馈：CG 鉴赏打开一张 CG 后无法退出——原生版以双指点按（映射为
右键）退出查看。事件链逐层排查结论：

1. **引擎层（补丁 0074）**：sdl2 端口此前只把 SDL FINGER 事件按归一化
   坐标投递（甚至一度在 web 上直接丢弃，见 0044 旧改法）。0074 对齐
   android environ 契约：FINGER 坐标从 [0,1] 归一化换算成 draw-area
   像素（用 SetPaintBoxSize 的游戏逻辑尺寸，而非跟随 canvas 元素的
   SDL 窗口尺寸）；每根手指 down/move/up 进入 TouchPointList，窗口
   实现了 touchPointCount / getTouchPoint(X/Y/ID/StartX/StartY) 查询族
   （TVPWindow 侧虚化）；OnTouchScaling/OnTouchRotate/OnMultiTouch 由
   TouchPointList 按阈值派生；web 下丢弃 SDL_MULTIGESTURE 避免冲突
   副本。SDL 仍自动把主指合成左键——单击推进文本依赖此路径，保持不变。
   0044 里旧的“web 丢弃 FINGER 事件”临时改法随之移除。
2. **游戏手势层是死路（根因）**：gesture.tjs 的 onTouchUp → endGesture
   对触摸 tap 走 invokeLeftClickOnIgnoreTouchMouse，但 yuzu_system.tjs
   的 resetTouchMouseEnabled 计算被官方注释，touchMouseEnabled 恒真 →
   该函数恒直接 return，手势层零输出。原生“双指点按=右键”的机制在
   k2compat 插件的 TouchMouse 本体（OS 触摸→鼠标转换），web 端
   k2compat 此前是 no-op。
3. **TJS 垫片（补丁 0075）**：Plugins.link("k2compat.dll") 时注入
   Window.TouchMouse 类——构造器覆盖 MainWindow 实例的
   onTouchDown/Move/Up/onTouchScaling/onTouchRotate 回调，把每个事件
   重发为游戏动作事件（win.action / callHook('onEventActionHook')）；
   同时自行跟踪手指，双指点按（时长 ≤900ms、总位移 ≤80px）→
   win.onPrimaryRightClick()（失败回落 rightClickHook）。

页面配套：`.player-stage canvas { touch-action: none }`——浏览器不再把
双指手势抢走当页面缩放/滚动。

本轮实证的两个 TJS 语言事实（记录防重蹈）：

- **TJS2 没有词法闭包**：匿名函数不捕获外层局部变量（调用时抛
  "Member xxx does not exist"）。垫片的实例回调必须自包含，经
  `global.KRKR2WebTouchMouseActive` 全局引用取回实例。
- TouchMouse 的 owner 形参就是 kag 对象本身（勿读 `owner.owner`）；
  判存在须写 `typeof global.Window.TouchMouse == 'undefined'`（typeof
  对不存在的成员也恒返回字符串而不抛错，等值左边必须显式 global 域）。

验证：本地真游戏 CG 旅程（CDP 双指 tap）日志出现
`KRKR2WEB_SHIM 2finger tap rightclick dur=430 moved=0`，画面 diff 确认
回到缩略图网格；单击推进回归正常。随后实机用户确认双指退出与单击
推进均符合预期。

排查工具沉淀（gitignored，重算丢失可按本文档重建）：.tmp/tjs_disasm2.py
（TJS2 字节码反汇编器）、.tmp/cg-act.js（CG 旅程 harness；须 headed 模式
+ route 屏蔽 engine-worker-host.js 强制 baseline 变体，否则命中桌面
worker 黑屏 bug）。

## Logo 蓝色问题修复（2026-08-21，补丁 0076）

标题前厂商 Logo 动画整体偏蓝/灰。离屏复现 + PSB 二进制实证
（.tmp/psb_extract.py 直接解析 m2logo.mtn）定位根因：

**PSB 纹理载荷（pixel chunk / 调色板 / win 源 RGBA8）本身就是 krkr 序
BGRA**（uint32 0xAARRGGBB；icon35 调色板原始字节 `28 28 d2 ff`，红 C 的
R=0xD2 在高位）。上游 kirikiroid2 链在像素进纹理前调 TVPReverseRGB 转
RGBA 字节序——那是因为它的 `TVPTextureFormat::RGBA` 纹理是 GL
RGBA/UNSIGNED_BYTE（R 在低地址）；而 web 软件 WebMotionTexture 按 uint32
原样存取（krkr 语义），这次反转成了多余的错转 → 所有 PSB 来源 Emote
纹理红蓝互换（红 C 0xFFD22828 被翻成 0xFF2828D2）。

修复（补丁 0076）：删 ObjSource::ensureTexture / decodeKrkrAtlasRecord /
winsrc RGBA8 共 7 处 TVPReverseRGB，PSB 字节原样进纹理。

验证：logo repro 从"canvas 全域 0 彩色像素"变为 9048（红/绿/蓝字母
齐全）；真游戏（本地 8766）m2logo 帧红 C 以 (210,40,40) 正确出现，标题
立绘肤色正常无回归。前轮 FINDINGS 记录的"ltAlpha 合成去色"（Bug B）
症状随本修复消失——它是错色叠加观察的衍生现象，非独立缺陷。

排查方法论沉淀：像素生产者用运行时插桩定位（CreateTexture2D 两个重载
打首像素，stderr 经 probe 页 printErr 进 report.json 的 logs 数组，不在
console）；PSB 字节序用 python 直接解容器验证（.tmp/psb_extract.py，
names trie/字典二分/chunk 表的解码契约照搬 psbfile 参考实现）。

## 新游戏 25s 停顿：数据采集进行中（2026-08-21）

已知（上一轮实机 + 本轮补充）：单 tick 24.7s、堆 +200MB 至 556MB 平台，
非死锁。本轮补丁 0077 给 TVPLoadGraphic 缓存 miss 加了
KRKR2WEB_D5_LOAD ms/bytes/name 计时日志（>=50ms），并实测：8MB WebP
全屏图解码 70-100ms、11MB PSB 子层 ~100ms——**25 张图仅约 2.5s，无法
解释 24.7s**，大头疑在 PSB（.pimg）整体物化或 XP3 解压/IDB 读取突发，
待下一轮在真实新游戏窗口用该日志取构成清单再定方案（候选：场景预热、
分帧物化、学习式预载清单）。

标题 UI 导航坐标（client 坐标，画布上方有 52px 顶栏，截图坐标需 -52）：
新游戏菜单列在左侧 x≈150；本轮实证 (150,645) = 场景回想（flowchart）；
(150,770) = 鉴赏（历史实证）；"新游戏/最初から"具体 y 未命中
（试过 575/338 均点空），下轮可从 flowchart 页面的场景节点直接进入
场景加载窗口取数。

## 游戏正常退出不回游戏库修复（2026-08-22，补丁 0078）

实机症状：游戏内正常退出后引擎空转，页面停在游戏视图，需手动工具栏
停止（诊断 stopReason=player-toolbar；引擎日志走到 end.ks *end_hook 后
无下文）。

根因（反汇编 + 源码双证）：退出链 close → onCloseQuery → PanicAskYesNo
（.tmp/yuzu_system.tjs:541）调 `WIN32Dialog.messageBox(...) == IDYES`
决定是否执行 onCloseYes；web shim 的 messageBox 恒返回 IDNO → 退出
确认（終了しますか？）、回想退出（AskQuitReplay）、场景跳转确认
（AskBackOne/NextScn/PrevScn）全部被静默答"否"，shutdown 链从未走到
krkr2webEngineQuit。

修复三件套：
- **补丁 0078**（PluginImpl.cpp win32dialog 分支）：注册 TJS 全局
  `krkr2webAskMessageBox(text, caption, flags)`——C++ tTJSNativeFunction，
  EM_ASM 调 `window.krkr2webDialogAsk(...)` 取 token，Asyncify 循环
  `emscripten_sleep(100)` + `krkr2webDialogPoll(token)`（1800 次上限 =
  180s）；拿到答案后 dismiss 并返回 IDYES/IDNO/IDOK。无页面钩子
  （如 worker 变体）或超时返回 -1，TJS 垫片 messageBox 回落原默认答案
  （MB_YESNO → IDNO），与旧行为完全兼容。
- **player.js**：页面模态对话框三钩子（`.player-stage` 下
  `.engine-dialog`，MB_YESNO 渲染 是/否，否则单个 确定；点击写结果，
  poll 未答返回 -1、对话框已删返回 -2）；styles.css 配套样式。
- 全局函数注册用引擎自带 `TVPRegisterGlobalObject`（iTJSDispatch2
  无 PropAdd，首轮构建教训）。

验证（本地三层）：
1. logo repro（真引擎 wasm + 自动应答钩子走真实轮询路径）：
   `ASKTEST bridge=Object yes=6 no=7 ok=1`、`shimYes=6`（完整 shim 路径）；
   无标记文本回落 IDNO（box=7）不变。
2. 真游戏页面（8766 产品 + Playwright）：对话框渲染（title=確認、
   text=終了しますか？、按钮 是/否）、点击前 poll=-1、点"是"=6、
   点"确定"=1、dismiss 后 DOM 移除。
3. engine-quit 回库复核：页面侧直接触发 krkr2webEngineQuit →
   stopReason=engine-quit、库页面可见。

游戏内 UI 触发段（标题菜单 → 終了 → 确认）本地 headless 无法视觉
定位（canvas 黑屏），由实机验证覆盖——实机诊断已证明该链触发过
（引擎空转即确认被 IDNO 拦截的直接后果），修复后同一操作应弹页面对
话框。部署 443（?v=50dfe944 引擎 / ?v=5411f2a0 player）待实机确认。

## 引擎缓存混搭死亡与完整性自检（2026-08-22，提交 9f3f2d2）

0078 部署后实机**彻底无法进游戏**（诊断 20260822-023006）：引擎零
输出死亡——engineLog 仅 player 侧 VIDEO_STOP、storage openCalls=0、
audio 未激活、assets 却 ready 且字节数等于新 wasm。

根因（本地 baseline 复现 + 请求轨迹实证）：**旧页面/旧 js 胶水 +
新 wasm 混搭**。WebView 会话恢复或缓存复用旧 index.html → 引用链
全是旧 js（缓存命中）；旧 player.js 的 wasmUrl 带旧 ?v=，但**服务器
无视查询参数**，任何 URL 都返回最新文件 → fetch 拿到新 wasm。
0078 的 EM_ASM 改变了 js/wasm import 接口 → 实例化失败零输出。
此前多次部署未炸纯属补丁未改胶水接口（错配但 ABI 兼容）。服务器
虽全局发 Cache-Control: no-cache，但内存中的旧页面复跑根本不发
HTTP 请求，头字段救不了——客户端自检是唯一防线。

修复三件套（stamp_build_versions.py + player.js）：
1. **engine-manifest.json**：prepare 生成 js/wasm 各自 bytes+sha256
   与联合 build id；index.html 注入 meta krkr2-engine-build。
2. **preload 自检**：拉 manifest（no-store）→ 校验 wasm bytes+sha256
   → 不匹配带 krkr2bust 参数 cache:reload 重拉 → 仍不匹配则 assets
   failed 报"引擎文件校验失败"；manifest 缺失自动跳过（旧服务端
   兼容）。crypto.subtle 缺席（非安全上下文）仅校验 bytes。
3. **页面版本自愈**：meta build ≠ manifest build → 自动 reload 一次
   拉新脚本链（sessionStorage 防循环）；这就是"从服务端拉取完整
   引擎"——reload 后 no-cache 保证整链更新。

**stamp 陷阱**（本轮踩坑 30 分钟）：stamp 会把 player.js 内所有
URL 形态字符串加 ?v=，包括 `manifest.files["/engine/krkrsdl2.wasm"]`
这个字典键 → 精确键查找静默失效、校验被跳过。必须按后缀
（`/krkrsdl2\.wasm(\?|$)`）匹配。

本地验证（.tmp/heal-drive.js 三场景 + baseline/worker 无回归）：
旧 meta 一次 → reload 自愈游戏正常；旧 meta 永远 → 仅 reload 一次
游戏正常；伪造期望 → bust 重拉 → failed 报错正确。

**实机恢复指引**：当前实机缓存的是无自检的旧页面，需完全关闭
游戏页面（或重启模拟器 app）重新打开一次；此后每次引擎更新页面
都会自动检测并 reload 自愈，不再需要手动操作。

诊断变化：snapshot().assets 新增 verifiedBuild（校验通过的 build id）；
校验失败时 assets.error 含"引擎文件校验失败"与期望/实际字节数。

## 实机验证通过 + 退出路径复盘（2026-08-22 二轮）

实机诊断 20260822-030207-4a9114f1：**退出修复与自检双双通过**。
游戏完整启动（XP3 39045 文件、全插件链接、标题画面），
`assets.verifiedBuild=f92c650c`（wasm 校验通过）；游戏内退出走完
确认 → shutdown → `stopReason=engine-quit`、`forcedStopCount=0`
（对照上轮死亡诊断 forcedStopCount=2 工具栏强停），页面正常回库。

## 点击下一步性能优化（2026-08-22 三轮，补丁 0079/0080/0081）

实机症状：普通安卓手机点击"下一步"时音频断续 + 立绘切换卡顿，
桌面浏览器无明显卡顿。根因梳理（全部主线程串行）：

1. **WebP 解码在主线程跑 wasm libwebp**：720p 级图像 40-100ms/张；
   OpenAL 调度是主线程 25ms interval + **100ms lookahead**——任何
   超过 lookahead 的停顿都会掐掉正在播放的语音（爆音的直接机制）。
2. **每个 XP3 段解压都新建再销毁一个 Worker**（0006 旧实现）：
   每段 5-15ms 启动开销，一次点击多次触发。
3. **段缓存只有 1MiB**：脚本/语音段几乎每次都未命中。
4. **语音打开走完整冷路径**：IDB 块读取（Asyncify 挂起）→ Worker
   解压 → Vorbis 头解析 → 首批 125ms 单元解码，全部串在点击帧里。

### 方案：预取流水线 + 原生解码搬离主线程

约束回顾：目标 WebView 89 无 SharedArrayBuffer/跨源隔离/wasm SIMD
（见 worker-runtime-contract.json），引擎必须单线程——并行只能来自
**浏览器原生多线程**（专用 Worker + createImageBitmap 内部解码线程池）
与**时间转移**（用户读字时预取）。

- **0079（XP3 通知/预测/段公园/段缓存）**：每次档案流创建通知页面
  （规范化名 + 段表）；引擎对尾号数字的存储做 **+1/+2 数字后继预测**
  （语音库与编号 CG 的通用命名规律），预测打开只走流构造（零 IO），
  页面据此提前拉取；EnsureSegment 先查页面**段公园**（已解压字节）
  命中即一次 memcpy；段缓存 1MiB→16MiB（单段 4MiB）。
- **0080（图形公园快路径）**：TVPInternalLoadGraphic 在打开档案流
  **之前**先问页面有没有该存储的已解码 BGRA（公园命中 = 一次探测 +
  一次 memcpy，零 IO 零解码）；必须在 16 字节 WebP 魔数嗅探之前，
  否则嗅探本身就会强制首段读取+解压。
- **LoadWEBP.cpp（项目自有）**：未命中公园的 WebP 走**异步原生解码**——
  两阶段（请求→等待尺寸；同步取回→memcpy），引擎 Asyncify 挂起期间
  主线程空闲（音频调度/输入不受影响），失败回落 wasm libwebp。
- **0006（改写）**：持久化解压 Worker 池（`krkr2webInflatePool`），
  规模 = min(4, max(2, 核数-2))；无池时保留旧的逐次 Worker 兜底。
- **0081**：OpenAL QUEUE_LOOKAHEAD 100ms→250ms（瞬时抖动不再掐音）；
  图形缓存默认 128→160MiB。
- **页面（play/prefetch.js 新增）**：解压池 + 解码 Worker
  （createImageBitmap + OffscreenCanvas，WebGL readPixels 直通 alpha，
  失败回落 2D getImageData）+ 双公园（段 24MiB/图像 48MiB LRU，
  按设备内存分层）+ 预取调度（并发 2、20s 超时、引擎代际取消）。
  storage.js 增加 `readRange/prefetchRange`（与引擎共享块 LRU——
  预取读过的块，引擎后续读取必命中）；块缓存分层 32/64/128 →
  64/128/256MiB。
- player.js 终止时 `cancelAll`（公园按内容寻址跨重启保留）、
  snapshot 增加 prefetch 指标；check_d4_artifacts 纳入 prefetch.js
  存在性与语法门禁。

### 预期与观测

点击路径各层成本变为：语音（预测命中）= 段公园 memcpy + 头解析
（约 2-5ms）；WebP（预测命中）= 公园 memcpy（约 2-3ms）；WebP
（首见）= 挂起式原生解码（主线程仅 ~2ms 拷贝）；音频不再因解码
停顿断续。诊断报告 `snapshot().prefetch.metrics` 提供
notifyOpens/predictedOpens/prefetchedFiles/segmentParkHits/imageParkHits/
nativeDecodes 计数与公园水位，配合 PERF 直方图可验证。

### 本地验证（2026-08-22，本地 8766 + Playwright 剧情点击）

真游戏全流程（标题 → 新游戏 → 序章剧情连点 30-60 行）：

- **语音预取全命中**：predictedOpens=30 → prefetchedFiles=30 →
  segmentParkHits=30（14.5MB 语音段零 IDB 读取零解压直达引擎）；
  标题待机语音 murasame_senren1 → senren1_2 → senren1_3 预测链
  逐条提前命中，序章 EV CG ev001_01..05 / ev002_01→02 同样命中。
- **原生解码取代主线程 wasm 解码**：nativeDecodes=128，
  decodeFailures=0，wasmFallbacks=0——全部 WebP 经浏览器原生解码器
  在解码 Worker 内完成，主线程仅剩 memcpy。
- **点击推进帧间隔**（音频断流代理指标，>100ms 即会掐音）：
  60 次点击仅 3 次 >80ms 采样、max=58ms、p90=44ms——全部低于
  100ms 断流线；PERF 直方图 avg 4-7ms、稳态窗口 max ≤ 18ms、
  heap 稳定（294MB 平台）。
- **无回归**：零 errors、零致命弹窗、退出/重启路径未触碰；
  KRKR2WEB_D5_GRAPHIC_CACHE 160 生效。
- 已知边界：430ms 快速连点时 8MB EV CG 的图像公园解码来不及
  完成（预取约需 1s），未命中公园回落挂起式原生解码——依然无
  主线程卡顿；真实读字节奏（2-5s/行）下公园命中率会显著更高。
- 排查工具沉淀（gitignored）：`.tmp/perf-drive.js`（画布分数坐标
  harness）、`.tmp/probe-prefetch.js`（新游戏剧情点击探针）；桌面
  验证须 route 屏蔽 `engine-worker-host.js?*`（含 ?v= 戳）强制
  baseline 变体，否则命中桌面 worker 黑屏 bug（既往结论）。




### 退出全链路本地复刻（关键发现）

本地（baseline 变体 + Playwright）完整复刻实机退出：标题 → 終了
（引擎触摸空间相对 (0.124,0.925)）→ **游戏自绘确认**（custom.ks
*end_hook 的 askYesNo AskExit——不是 win32dialog messageBox！）→
はい → *end_wait 二次确认 → end.ks → window_cn.pimg → teardown →
engine-quit 回库。注意确认点击必须按 engineLog 进度 gating（设备
节奏：确认1 → 290ms → 确认2 → 等 window UI → 475ms 内三连点），
固定间隔盲点会把关闭流程点岔导致卡死。

### 退出路径的真实驱动力：异常级联（重要，勿"修复"）

退出时两个 TJS 异常先后发生，第二个是**退出完成的驱动力**：

1. `showdate.tjs removeLayer` 读 `owner.subLayers` 抛异常——owner
   （message0 消息层）已被游戏先行销毁。这个异常**打断了游戏的正常
   关闭链**（之后引擎 80fps 空转僵尸态）。
2. 我们 menu 垫片 `KRKR2WebMenuItem.finalize()` 的 `owner = void`
   写入在半销毁对象上抛 `Member "owner" does not exist`——该异常
   触发 kirikiri 的致命异常退出路径 → 引擎终止 → engine-quit。

实验证明（本地三轮）：把 finalize 改成空实现（消除异常2）后，退出
**永久卡死**（关闭链已断、无致命异常救场）；删除 finalize 则游戏
menus.tjs 子类的 `super.finalize()` 落空同样抛异常（级联仍在，退出
仍通）。**finalize 必须保留原函数体**（children.clear + parent/owner
写入）——0007 中已加注释封存该结论。彻底干净的退出（无报错弹窗）
需要先解决异常 1（游戏正常关闭链在 web 引擎下断掉的原因，疑与
消息层销毁顺序/字幕层清理有关），留待后续。

### 本轮实际修改

- **player.js**：`krkr2webEngineQuit` 改 `stop({sync:false})`——引擎
  关闭时 Application.cpp 自带 `FS.syncfs`，页面侧再强制同步必然与其
  竞争同一批 IDB 事务 → 8 秒超时报"存档同步失败"（实机诊断 errors
  实录）。修复后 errors 只剩"引擎正常退出"。
- **0007**：finalize 函数体不变，仅加注释说明不可改。

本地验证（run8，build 87b0b27a）：stopReason=engine-quit、回库 ✓、
errors 无同步超时 ✓、alerts 免费声明 + Member owner（预期级联）。
