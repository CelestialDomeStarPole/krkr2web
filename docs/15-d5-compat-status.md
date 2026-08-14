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

当前阻断点：游戏写压缩存档时，zlib 的 deflateResetKeep 触发 Wasm
“null function”崩溃（详见下文“已知问题”）。这是当前首个必须解决的硬阻断。

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
| motionplayer.dll | bootstrap-only | 立绘动画（.mtn）；当前只打点不实现 |
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

### 1. zlib deflate 写存档时 “null function” 崩溃（硬阻断）

写压缩存档时调用链为 tTVPTextWriteStream → deflateInit_ → deflateInit2_ →
deflateReset → deflateResetKeep，其中 deflateResetKeep 对 adler32 的调用生成
了指向空函数的 call 0，触发：

    RuntimeError: null function
      at dynCall_v
      at invoke_v
      at deflateResetKeep (wasm-function[2082]:0x1a1cfc)
      at deflateReset
      at deflateInit2_
      at deflateInit_
      at tTVPTextWriteStream::tTVPTextWriteStream(...)

已排查并排除：GZIP 路径（-DNO_GZIP 后仍崩）、链接期 --no-heap-copy 与
-fPIC 移除（仍崩）、编译期 -fPIC 完整去除并全量重编（仍崩）、zlib 去掉预编译头
（PCH）单独重编（仍崩）。inflate（解压）路径工作正常，说明同一 zlib 的 adler32
从 inflate 侧可正常调用；问题特异于 deflate 侧对 adler32 的调用被 Asyncify
改写为指向空函数的间接调用（call 0 / invoke_v → dynCall_v → null）。

反汇编显示 deflateResetKeep 中 adler32 的调用被编译成受 Asyncify 状态门控的
分支，其中一路调用空函数 0。当前最可能的根因是 -sASYNCIFY=1 全量插桩对
zlib deflate 链路的误改写。建议按以下优先级修复：

1. 用 -sASYNCIFY_ONLY=[...] 只插桩真实的异步入口（IndexedDB 读取桥的
   emscripten_sleep 链），避免全量插桩 zlib；
2. 或将 zlib deflate 相关函数加入 ASYNCIFY_BLACKLIST；
3. 或绕过方案——让 tTVPTextWriteStream 对 z 压缩模式改为写未压缩存档，避免
   走 deflate 路径（存档仅本地使用，读写同一引擎可自洽）。

### 2. getLangName.dll 缺失（非阻断）

multilang.tjs 调用 System.getCurrentUILangName() 抛“成员不存在”，被游戏
捕获并回落英语。需要时可用 TJS 垫片补齐 System.getCurrentUILangName /
System.getSystemLanguageTag。

## 下一步

1. 修复 zlib deflate 崩溃（上述方向逐一验证），打通存档写入；
2. 补齐 getLangName / csvParser 等低成本 TJS 垫片；
3. 按“标题 → 剧情 → 图层/立绘动画 → 声音 → 存读档 → 性能”顺序推进，端口
   motionplayer、layerExImage/layerex_draw、textrender、psbfile 等参考实现
   （参考 参考资料/开源项目/kirikiroid2-web/cpp/plugins/）；
4. 目标 WebView 89 实机验收（20 FPS、60 分钟稳定性）——需真机人工执行。
