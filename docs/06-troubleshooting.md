# 排障手册

本文沉淀项目开发中实证过的环境陷阱、事故模式与已知未解问题。动手前先通读
"环境陷阱"，那里记录了会浪费大量时间的非显而易见问题。诊断入口：实机报告在
`diagnostic-reports/`（设置页"上传诊断"/检测页"上传报告"），产品页 localStorage
存有 `krkr2web-d4-last-player`（播放器快照）与 `krkr2web-d4-last-session`
（停止/冻结现场）。

## 环境陷阱（必读）

1. **构建流程中禁止用 git 读写工作树文件**（git apply 假成功、hash-object 视图
   隔离的历史教训）。补丁一律 `tools/apply_patch.py`；验证文件内容以
   python/pwsh 视图为准。
2. **构建树每次重导出会清空**（指纹变化即重建）。改引擎源码必须固化为
   `engine/patches/NNNN-*.patch` 并登记 `engine/upstream.json`；诊断用的
   fprintf 在下次 `-Clean` 自动消失（这是好事）。
3. **补丁是 LF；上游部分文件是 CRLF**（ScriptMgnIntf.cpp、EventIntf.cpp），
   部分 LF（SDLApplication.cpp）。用 python 改文件先探测 `b'\r\n' in
   src[:2000]`。写 patch 上下文行号以"按序应用补丁后"的文件为准
   （apply_patch.py 有偏移搜索兜底）。
4. **TJS 字符串在 wasm 里是 UTF-16 存储**，ASCII 搜不到（搜 "KRKR2WEB_..." 要
   用 UTF-16 编码）。wasm 内只能验证字符串常量；MinSizeRel/Release 下局部
   变量名被剥离，不可作验证依据。
5. **stamp_build_versions.py 会给一切 URL 形态字符串加 `?v=`**，包括代码里的
   字典键——按 URL 精确键查找会静默失效。按后缀正则匹配（如
   `/krkrsdl2\.wasm(\?|$)`）。
6. **诊断日志计数上限陷阱**：给日志加 `if (count++ < N)` 限制会让启动期就耗尽，
   "日志不出现"被误判为"代码没执行"。要么无上限，要么按事件类型过滤。
7. **emcmake 的 stderr**：后台跑 build_d3.ps1 不要加 `2>&1` 管道
   （$ErrorActionPreference='Stop' 会把 stderr 当错误抛）。
8. **TJS2 没有词法闭包**：匿名函数不捕获外层局部变量（调用时抛 "Member xxx
   does not exist"）。垫片的实例回调必须自包含，经全局引用取回实例；判存在写
   `typeof global.X == 'undefined'`（typeof 对不存在成员恒返回字符串不抛错，
   等值左边须显式 global 域）。
9. **FuncCall 返回值**：0 = TJS_S_OK；-1001 = TJS_E_NOTIMPL（成员不存在）。
10. **桌面 headless 验证 worker 变体会黑屏**（worker 变体桌面 bug）：Playwright
    route 屏蔽 `engine-worker-host.js?*`（含 ?v= 戳）强制 baseline 变体。
11. **浏览器/宿主缓存**：部署新引擎后若不生效，给 URL 加 buster、
    `--disable-http-cache` + CDP `Network.setCacheDisabled`；产品线上靠
    engine-manifest 自愈（见下）。

## 事故模式速查

### 引擎零输出死亡（旧 js 胶水 + 新 wasm 混搭）

症状：实机彻底无法进游戏，engineLog 仅页面侧记录、storage openCalls=0、
assets 却 ready。根因：WebView 会话恢复复用旧 index.html → 引用链全是旧 js
（缓存命中）；旧 player.js 的 wasmUrl 带旧 `?v=`，但服务器无视查询参数返回
最新文件；EM_ASM 接口变化 → 实例化即败零输出。`Cache-Control: no-cache` 救
不了内存中的旧页面（它根本不发请求）。

防御三件套（stamp_build_versions.py + player.js）：`/engine-manifest.json`
（js/wasm 字节数 + SHA-256 + 联合 build id）→ preload 校验、不匹配 bust 重拉
→ 页面 meta build 比对不一致自动 reload 一次（sessionStorage 防循环）。
无自检代码的更旧页面需完全关闭游戏页面重开一次。

### 整页无样式（CSS 偶发丢失）

三层根因、四层防御：prepare 从"清空重建"改为 staging + 两次 rename 原子换入
（重建窗口 404）；服务器从 HTTP/1.0 无 keep-alive 改 HTTP/1.1（每刷新 12 个
子资源各建 TCP+TLS，任一失败丢一个资源）；带内容哈希的资源改
`max-age=31536000, immutable`（刷新时子资源磁盘缓存直出、零网络请求）；页面
stylesheet onerror 一次性重拉兜底。

### 下载刷新后死锁（无法续传）

产品壳 boot 只读 IndexedDB 记录、不跑 `Downloader.load()` → 刷新后 install
停留在 "downloading"，详情页只渲染"暂停下载"且点击 no-op。修复：boot 时对每
游戏 `resumeInstalls()`（downloading → paused、按已存块重算 committedBytes），
刷新前正在下载的自动续传、用户主动暂停的保持；网络错误任务级指数退避（2s 起、
封顶 30s、每块 6 次），hash 重试与网络重试计数分离。

### 闲置卡死（引擎静默冻结）

特征：看门狗定时器本身能触发 → JS 事件循环存活 → 引擎挂在 Asyncify 等待。
两大根因（已修）：存储桥每读一块 openDatabase()+close()（高频开合下 WebView
的 open 可能永不回调）→ 改持久连接 + onversionchange 自愈；事务 `onabort`
既不 onsuccess 也不 onerror → 承诺永不结算 → requestResult 增加 onabort
拒绝路径 + 全部 IDB 操作 20 s 超时 + 挂起操作追踪
（`window.krkr2webStorageTrace`，警报附带"挂起操作: op detail 已 N 秒"）。
卡死现场保存：terminateInstance 把 {stopReason, crashed, stalledAt,
stallSilentMs, lastLog(40 行)} 写 localStorage，重启不销毁证据。

### 看门狗误报

按 tick 计数的心跳在长帧（解码突发实测单帧 ~2.1 s）下墙钟间隔轻松超阈值。
心跳改每 4 tick、阈值 15 s、恢复线 3 s；警报文案区分"挂起等待"（定时器能触发
= 事件循环存活）与主线程阻塞。

### 退出链与"异常级联"（勿"修复"！）

游戏正常退出目前**靠两级 TJS 异常级联驱动**：① showdate.tjs removeLayer 读已
销毁的 owner.subLayers 抛异常（打断了游戏正常关闭链）；② menu 垫片
`KRKR2WebMenuItem.finalize()` 在半销毁对象上写 `owner = void` 抛异常 → 触发
kirikiri 致命异常退出路径 → 引擎终止 → engine-quit 回库。本地实证三轮：把
finalize 改空实现（消除异常②）→ 退出**永久卡死**；删除 finalize → 子类
super.finalize() 落空同样抛异常（级联仍在）。**finalize 必须保留原函数体**
（0007 补丁内已加注释封存）。彻底干净的退出需先解决异常①（游戏关闭链在 web
引擎下断掉的原因，疑与消息层销毁顺序有关），留待后续。

另：游戏内退出确认（終了しますか？）等 win32dialog messageBox 曾恒答 IDNO
导致退出链走不到 shutdown——已改为页面对话框真实应答（补丁 0078 +
krkr2webDialogAsk/Poll/Dismiss，Asyncify 轮询 180 s 上限，无钩子/超时回落旧
默认答案）。

### 存档同步超时（退出时）

引擎自行退出时自带 `FS.syncfs`（Application.cpp）；页面侧若再强制同步必然
竞争同一批 IDB 事务 → 8 s 超时报"存档同步失败"。`krkr2webEngineQuit` 处理器
必须 `stop({sync:false})`。

### PSB 纹理红蓝互换（Logo 偏蓝）

PSB 纹理载荷本就是 krkr 序 BGRA；上游 kirikiroid2 链的 TVPReverseRGB 对其 GL
纹理必要、对本引擎按 uint32 存取的软件纹理是多余错转。删除 ObjSource/
decodeKrkrAtlasRecord/winsrc RGBA8 共 7 处 TVPReverseRGB（补丁 0076）。
排查方法论：像素生产者用运行时插桩（CreateTexture2D 打首像素）；PSB 字节序
用 python 直接解容器验证（names trie/字典二分/chunk 表照搬 psbfile 参考实现）。

### 触摸手势（双指点按=右键）

原生机制住在 k2compat 插件的 TouchMouse（OS 触摸→鼠标转换），不是游戏
gesture.tjs（其 resetTouchMouseEnabled 被官方注释、恒 return，死路）。实现：
引擎层按 android 契约投递 SDL FINGER（归一化坐标换算 draw-area 像素、
TouchPointList 多点跟踪，补丁 0074）+ TJS 垫片 Window.TouchMouse（双指点按
≤900 ms、位移 ≤80 px → win.onPrimaryRightClick()，补丁 0075）+ 页面
`touch-action:none` 防浏览器抢手势。

## 已知未解问题

1. **新游戏开场一次性场景载入停顿**：单 tick 最长 24.7 s（真机 2026-08-25
   样本仍见 20.9 s，堆峰 861 MB），非死锁。**主体已定位并部分修复（补丁 0088，
   2026-08-25）**：37.7 s 大 tick（rate6）的 74% 是剧本 `.scn`（PSB 容器，
   451,769 节点）被 `.root` 属性在同一实例上双重全量物化，另有 psb:// 子图
   交替读取触发的整容器重解析；0088（实例级物化根缓存 + 备忘录 + 六槽容器
   缓存）后 bench stallMax 34582→12250ms（35%）。剩余构成：单次物化本体
   （12.4s rate6，45 万次 TJS 对象创建主导，备忘录仅再省 8%）+ ~4s TJS 剧本
   处理。下一旁路候选：跨实例剧本缓存（需先补 save/load 验证腿）、TJS 分配
   器层面提速。图像解码已排除（WebP 70-100 ms/张、TLG 全异步原生化、
   mainDecodes=0）。`KRKR2WEB_D5_LOAD`/`D5_PERF`/`D5_PSB_LOAD`/`D5_PSB_MAT`
   计时日志持续在位。
2. **Worker 变体桌面黑屏**：headless 必现、headed 正常；实机走 baseline 不受
   影响（低优先）。worker 变体 messageBox 无 window，自动回落默认答案。
3. **实机游戏内退出后不自动回库**：本地复刻与 030207 诊断里 player 层都已
   hide（stopReason=engine-quit），实机不回；用户决定暂缓。重启此问题时先拿
   实机诊断看 alerts/engineLog 尾部（怀疑方向：TBS X5 的 native alert 阻塞
   恢复行为与桌面 Chrome 不同）。

## 排查工具沉淀

`.tmp/` 下（gitignored，丢失可按本文档思路重建）：`tjs_disasm2.py`（TJS2 字节码
反汇编）、`psb_extract.py`（PSB 容器解析）、`perf-drive.js`（画布分数坐标
harness）、`probe-prefetch.js`（剧情点击探针）、`resume-probe.js`（下载续传
探针，persistent profile 绕开临时 headless 3 GiB 配额限制）、`heal-drive.js`
（引擎自愈三场景驱动）。桌面验证一律 route 屏蔽 engine-worker-host 强制
baseline（见环境陷阱 10）。
