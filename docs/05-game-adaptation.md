# 游戏适配指南

本文说明把一款新 KRKR2 游戏加入游戏库的完整流程，以及《千恋万花》适配沉淀的
媒体格式与插件知识。通用原则：**引擎层零游戏特调**（engine/patches、plugins、
web 全文无游戏名/厂商名），逐游戏内容只存在于 `engine/profiles/` 配置层。

## 添加一款新游戏的流程

1. **静态扫描**：`python tools/scan_xp3_compat.py` 扫描游戏的 XP3——条目数、
   脚本可解码性、媒体类型分布、提及的 DLL 插件。据此评估插件缺口。
2. **清单生成并放入站点**：`tools/generate_d2_catalog.py` 生成 manifest
   （4 MiB 分块、逐块 SHA-256）并直接写入站点目录——`catalog.json` 与
   `resource-map.json` 都是**合并式**（替换本游戏旧版本、保留其他游戏）：

   ```
   python tools/generate_d2_catalog.py \
     --game-id <id> --title <标题> --engine-profile <id>-v1 \
     --source-directory <游戏目录> --package data.xp3 \
     --web-output <站点根> \
     --resource-map-output <站点根>/resource-map.json \
     --metadata-output <站点根>/games/<id>-hashes.json \
     --description <面向用户的描述> --cover-url /assets/<封面>.png
   ```

   XP3 实体两种放法：**物理放置**（拷贝到版本目录
   `games/<id>/<版本>/data.xp3`，本仓库服务器会依据 manifest 自动提供
   分块安装所需的 206 Range + sha256 ETag）或 **resource-map 映射**
   （大文件留在站点外，服务器 `--resource-map` 指向）。`--description`
   与 `--cover-url` 同时写入版本目录的 `meta.json` 供自动目录使用。
   注意 Git Bash 会把 `/assets/...` 参数转成 Windows 路径，命令前加
   `MSYS_NO_PATHCONV=1`。
3. **引擎 profile**：在 `engine/profiles/<gameId>-v1.json` 定义（由
   `tools/generate_engine_profiles.py` 生成 `engine-profiles.js` 注入产品）：
   - `entryPackage` / `requiredPackages` / `autoPathPackages`：入口与自动搜索
     路径的 XP3。
   - `engineArguments`：传给引擎的参数（如 `-deffont=` 指定内嵌可用字体、
     `-krkr2web-ui-language=` 界面语言）。
   - `runtime`：Wasm 初始/上限内存、块大小与缓存参数。
   - `display.mode`：`720p` 时画布内部分辨率锁定 1280×720（CSS 拉伸铺满），
     大幅降低合成/混合/上传的像素量。
   - `plugins` / `videoStrategy` / `runtimeCompatibility`：按本游戏插件与视频
     路线配置。
4. **视频转码**（如有视频）：`python tools/transcode_game_videos.py --game-id
   <id> --xp3 <path>` 幂等转码为 H.264/AAC MP4 到 `build/video-transcode/`
   （服务器 `--video-directory` 挂载）。H.264 是有意选择：目标 WebView 可硬解，
   VP8 明显更耗 CPU 且丢失源 BT.709 矩阵。引擎 VideoOverlay 经页面对话框桥
   播放，无钩子/无转码文件时保持"跳过"行为。
5. **实机验证**：完整下载 → 断网启动 → 标题/剧情/存读档 → 场景回想/鉴赏 →
   稳定性；报告归档，结论回填 [验证记录](09-verification-log.md)。

## 部署与游戏库自动识别

- 服务器加 `--auto-catalog` 后，`/catalog.json` 由
  `games/<gameId>/<version>/manifest.json` **实时合成**（按 mtime 指纹缓存，
  目录一变、刷新页面即生效）——把游戏文件夹放进 `games/` 就会出现在游戏库，
  无需手工维护 catalog。同一游戏存在多个版本目录时取 manifest 最新的一个。
- 版本目录内的 `meta.json` 可覆盖 `title` / `description` / `coverUrl` /
  `compatibility`；未提供时使用 manifest 标题与默认封面。
- 物理放置的 XP3 自动获得与 resource-map 完全一致的 Range/ETag/If-Match
  服务（显式 resource-map 条目优先）；换 nginx/caddy 等原生 Range 服务器
  时物理放置同样可行。
- 浏览器端存档隔离（既有机制，已由 `tests/d4_multi_game_audit.js` 实测）：
  引擎以 `-datapath=/savedata/<gameId>/` 运行，IDBFS 挂载在
  `/savedata/<gameId>`——每个游戏一个独立 IndexedDB 数据库；存档管理器按
  `/savedata/<gameId>/` 前缀读写删，互相不可见。在游戏库切换游戏时，
  玩家会先优雅停止当前会话（同步该游戏存档、释放引擎单例锁）再启动新游戏。


## 媒体格式事实（《千恋万花》实测，对同类商业 KRKR2 游戏普遍适用）

- **光栅图像几乎全是 WebP 伪装**：.png/.jpg/.tlg 扩展名的文件实为 WebP
  （RIFF...WEBPVP8 magic）。加载器按 **16 字节 magic 探测路由**，不信任扩展名；
  WebP 经 libwebp（decode 子集）+ `engine/webp/LoadWEBP.cpp` 解码，未命中图像
  公园时走异步原生解码（createImageBitmap），失败回落 wasm libwebp。
- `.pimg` 是 PSB（"PSB\0" magic）分层图，需 psbfile 插件；PSB 纹理载荷的字节序
  本就是 krkr 序 BGRA（uint32 0xAARRGGBB），**不要**调用 TVPReverseRGB（上游
  kirikiroid2 链的翻转对其 GL 纹理必要，对本引擎是多余错转，曾致 Logo 红蓝
  互换）。
- `.sli` 是自研分层图（"#2.0" magic），需 layerEx 系插件。
- `.mtn` 是 Emote 立绘动画，motionplayer 插件（约 60 源文件，已真移植）。
- `.ogg/.opus` 走引擎原生流式 Vorbis 解码（wuvorbis/wuopus 标记
  built-in-streaming，不加载 DLL）。
- 视频 WMV 按 D6 路线预转码，引擎内无 Wasm 解码器。

## 插件体系与移植方法（ADR-008）

KRKR2 游戏的 `.dll` 是 Windows 原生插件，统一建立在 ncbind（NCB）框架之上。
移植路线按保真度分层，优先高保真：

1. **NCB 真移植**（首选）：从 krkr2 / kirikiroid2-web 的 `cpp/core/plugin/`
   移植 NCB 框架与插件源码。已验证的可移植性结论：NCB 框架对 krkrsdl2 近乎
   零成本；每个插件需一层"字符串转换 + Storage API 适配 + 约 30 行无 fmt 的
   spdlog 桩 + 少量缺失 include"，第一个插件打通后即可复用。来源、提交与许可
   证登记进 `engine/upstream.json` 的 sourceImports。
2. **TJS 垫片**：无公开源码或成本过高时，经 `Plugins.link()` 注入最小 TJS 类
   （如 menu、addFont、getLangName、windowEx、k2compat TouchMouse）。垫片必须
   自包含（TJS2 无词法闭包），经 `TVPRegisterGlobalObject` 注册全局。
3. **降级承接**：视觉特效类缺失时保功能舍特效（如 extrans 的 7 个转场名回落
   内置 crossfade，日志 `KRKR2WEB_D5_TRANS_FALLBACK`；真移植后自动失效）。
   Win32 对话框类改为页面对话框桥（`krkr2webDialogAsk/Poll/Dismiss`）。
4. **no-op**：桌面专属或未触及的 DLL 记录在案，等剧情触及再评估。

**《千恋万花》插件现状**（截至 2026-08-22）：

| 处理方式 | 插件 |
| --- | --- |
| NCB 真移植/原生 | fstat、getSample、scriptsEx、csvParser、psbfile、saveStruct、textrender、layerExImage/Raster/BtoA、PackinOne、motionplayer（软件光栅路径）、windowEx（native-web）、k2compat（TouchMouse 垫片） |
| TJS 垫片 | menu、addFont、getLangName |
| 降级/no-op | extrans（crossfade 回落）、win32dialog（页面对话框桥）、proxyfs、wuvorbis/wuopus（built-in）、extNagano（游戏特有，源未定位）、KAGParserEx（kag.setMessageHook 未实现，keybinder 已不阻断） |

引擎按 `Plugins.link()` 实际调用打点（`KRKR2WEB_D5_PLUGIN_LINK/NCB/NCB_FAILED/
NOOP/SHIM`），以真实启动日志为准评估缺口，静态扫描仅作参考。

## 兼容等级与发布

- 扫描未发现明确阻断且可游玩 → `development`（界面徽章"适配优化中"）；通过
  完整验收（功能 + 20 FPS + 60 分钟稳定性实机报告）→ `verified`（"已验证"）。
- catalog 描述与封面由 `prepare_d5_product.ps1`（或后续发布工具）维护，文案面
  向用户，不使用内部阶段代号。
- 逐游戏补丁只作用于对应游戏或明确插件族；引擎层保持通用。
