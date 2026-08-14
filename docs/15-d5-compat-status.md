# D5《千恋万花》兼容与性能：现状与缺口

> 本文是 D5 阶段的中期工程记录，随开发进展持续更新。D5 门禁定义见
> [开发路线图](10-development-roadmap.md#d5千恋万花兼容与性能)，
> 首版通过条件见 [测试与验收](07-test-acceptance.md#千恋万花首版通过条件)。

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
| fstat.dll | no-op（优雅降级） | 存档改名；游戏 try/catch 后 disableFileRename=true |
| k2compat.dll | no-op（优雅降级） | 游戏自带 Krkr2CompatUtils fallback |
| getLangName.dll | no-op（异常被捕获） | 缺 System.getCurrentUILangName；语言回落 en |
| KAGParserEx.dll | no-op | KAG 解析扩展 |
| layerExImage/Raster/Draw/BtoA.dll | no-op | 图层扩展（kirikiroid2-web 有参考实现） |
| textrender.dll | no-op | 文本渲染（kirikiroid2-web 有参考实现） |
| PackinOne.dll | no-op | 打包档案 |
| proxyfs.dll | no-op | 代理文件系统 |
| csvParser.dll | no-op | CSV 解析 |
| win32dialog.dll / windowEx.dll | no-op | 桌面对话框/窗口，Web 无对应 |
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

### 3. csvParser 缺失（当前阻断）

utils.tjs 的 loadConfigFile 在解析 imagediffmap.csv 时 typeof CSVParser 为
undefined，Plugins.link("csvParser.dll") 为 no-op 后读取全局 CSVParser 失败：
An exception occured at utils.tjs(1)[(function) loadConfigFile]。需要提供
CSVParser 全局（CSV 解析），该插件在 krkr2 / kirikiroid2-web 参考仓库中均无
实现，需按游戏用法反向确定 API。

### 4. kagenvironment.tjs initCommand 异常（当前阻断）

kagenvironment.tjs 的 initCommand 在 Scripts.foreach(objects, ...) 处抛异常
（An exception occured at kagenvironment.tjs(1)[(function) initCommand]），
疑似与 KAGParserEx / scriptsEx 等 KAG 扩展插件缺失导致的命令/对象注册不全
有关，需继续定位。

### 5. getLangName.dll 缺失（非阻断）

multilang.tjs 调用 System.getCurrentUILangName() 抛“成员不存在”，被游戏
捕获并回落英语。需要时可用 TJS 垫片补齐 System.getCurrentUILangName /
System.getSystemLanguageTag。

## 下一步

按 ADR-008 从 krkr2 真移植 NCB 框架与插件（不再手写 TJS 桩）：

1. 打通 NCB 框架导入（补 include <set>、加 plugin 目录、构建集成）；
2. 引入字符串转换层（detail::narrow / widen）与 spdlog 桩、Storage API 适配，
   把 fstat 作为首个插件编译链接进引擎；
3. 批量推进纯逻辑插件（fstat、json、csvParser、addFont、scriptsEx、shrinkCopy），
   再视觉层插件（layerex_draw、layerExImage、textrender）；
4. 最后啃重型逆向插件（motionplayer/Emote、psbfile、PackinOne，参考
   参考资料/开源项目/kirikiroid2-web/cpp/plugins/）；
5. 目标 WebView 89 实机验收（20 FPS、60 分钟稳定性）——需真机人工执行。

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

