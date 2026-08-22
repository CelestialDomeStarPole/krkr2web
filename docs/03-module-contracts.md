# 模块契约

本文固定模块之间的数据形状与责任边界。字段可以通过版本迁移扩充，但不能由各模块
私自改变含义。目录结构以当前仓库为准：`apps/web`（产品壳）、`probes/*`（探针）、
`engine`（引擎基线与补丁）、`tools`（构建与发布工具）、`tests`（单测与浏览器
冒烟）、`diagnostics`（实机检测页）。

## Catalog 契约

`catalog.json` 只描述服务端允许用户看到的游戏，不包含块哈希：

```json
{
  "schemaVersion": 1,
  "catalogVersion": "catalog-<hash>",
  "games": [
    {
      "gameId": "senren-banka",
      "title": "千恋万花",
      "version": "content-<hash>",
      "manifestUrl": "/games/senren-banka/content-<hash>/manifest.json",
      "requiredBytes": 4044268983,
      "compatibility": "development",
      "coverUrl": "/assets/default-cover.png",
      "description": "由服务端维护的游戏说明"
    }
  ]
}
```

- `schemaVersion` 是数据格式版本，不等于游戏版本；未知值必须明确报错。
- `gameId` 使用稳定小写 ASCII 标识，发布后不复用给另一款游戏。
- `manifestUrl` 必须是同源 HTTPS 路径；客户端不接受用户输入 URL。
- `coverUrl` 若存在必须是同源静态资源；`description` 是可选展示文本，不参与
  完整性校验。
- 客户端（`d2Storage.validateCatalog`）校验结构后才使用；联网时刷新并存本机，
  断网时回退最后一次保存的目录。

## Manifest 契约

```json
{
  "schemaVersion": 1,
  "gameId": "senren-banka",
  "version": "content-<hash>",
  "title": "千恋万花",
  "requiredBytes": 4044268983,
  "engineProfile": "senren-banka-v1",
  "packages": [
    {
      "id": "data.xp3",
      "virtualPath": "data.xp3",
      "url": "/games/senren-banka/content-<hash>/data.xp3",
      "size": 2312777571,
      "chunkSize": 4194304,
      "sha256": "<full-file-sha256>",
      "chunks": ["<chunk-sha256>", "..."]
    }
  ],
  "mediaOverrides": []
}
```

- `version` 指向不可变内容；同一 URL 和版本不得静默替换字节。
- 包 `id` 与 `virtualPath` 在同一版本内唯一，禁止 `..`、反斜杠和绝对路径。
- `chunkSize` 首个 schema 固定 `4194304`，最后一块可以更小；
  `chunks.length == ceil(size / chunkSize)`。
- 所有大小、偏移和长度是非负整数；JS 中使用安全整数，C++ 中 64 位，禁止 32 位
  位运算截断。
- 客户端必须先校验清单结构，再发起任何包下载。

## IndexedDB schema

数据库 `krkr2web`，schema version 1：

| Object Store | 主键 | 值与责任 |
| --- | --- | --- |
| `catalog` | `catalogVersion` | 校验后的目录和获取时间 |
| `manifests` | `[gameId, version]` | 校验后的不可变 Manifest |
| `chunks` | `[gameId, version, packageId, chunkIndex]` | 单个 `ArrayBuffer`，最大 4 MiB |
| `chunkState` | 同 `chunks` | 长度、SHA-256、完成时间 |
| `installs` | `gameId` | 当前/待安装版本、状态、进度、完成标记 |

数据约束：

- 块数据与 `chunkState` 必须在同一事务提交。
- `installs.complete=true` 必须在所有包全量复核完成后的最后一笔事务写入。
- 启动只读取 `complete=true` 且 Manifest 版本匹配的安装。
- 删除采用有限批次事务（每批最多 32 块）；删除开始时先将安装设为不可启动。
- 应用更新不得清理 `chunks` 或存档。

**存档不走上述数据库。** 可变存档由 Emscripten IDBFS 管理：每个游戏一个独立
IndexedDB 库，库名 `/savedata/<gameId>`，对象仓 `FILE_DATA`（save-manager.js 与
引擎 IDBFS 共用）。存档管理页直接读该库展示与删除。

## 下载器状态机

```text
not-installed
  -> checking-space
  -> downloading <-> paused
  -> verifying
  -> committing
  -> ready

checking-space/downloading/verifying
  -> recoverable-error -> downloading（网络错误指数退避：2s 起、封顶 30s、每块最多 6 次）
  -> fatal-error

ready -> deleting -> not-installed
```

- 状态写入必须可重复执行；进程在任一步骤中止后可根据已提交块恢复
  （产品壳 boot 时对每个游戏执行 `Downloader.load()` 重建状态，刷新前正在
  下载的自动续传，用户主动暂停的保持暂停）。
- 网络重试与哈希重试计数分离；`fatal-error` 包含 Manifest 非法、版本内容不一致
  和反复哈希失败（`E_VERSION_CHANGED`/`E_INTEGRITY`）。
- 暂停只停止新请求；已收到的数据仍完成校验和事务提交。
- 下载并发 4（服务器为多线程 ThreadingHTTPServer）；进度以已校验并提交的字节
  计算。

## 虚拟文件读取 API

引擎看到同步式只读文件接口；JavaScript 内部经 Asyncify 异步完成
（`probes/d3-engine/web/storage.js`）：

```text
open(gameId, version, virtualPath) -> handle | error
size(handle) -> uint64 | error
read(handle, offset:uint64, length:uint32, destination) -> bytesRead | error
close(handle) -> void | error
```

- `open` 只允许访问已完成安装的 Manifest 列表路径。
- 单次读取上限 8 MiB；`read` 可跨多个 4 MiB 块。
- 读取到文件尾返回实际字节数；`offset > size` 是范围错误。
- 一个 Wasm 实例同一时刻只允许一个 Asyncify unwind；重入返回明确错误。
- XP3 段解压经持久化 Inflate Worker 池（无池时逐次 Worker 兜底），解压读取有
  30 秒超时，超时转为可见存储错误而非静默挂死。

## 错误码

下载与存储层使用稳定错误码（JS 侧 `error.code`，如 `E_QUOTA`、`E_NETWORK`、
`E_VERSION_CHANGED`、`E_INTEGRITY`、`E_STORAGE`、`E_INVALID_MANIFEST`、
`E_RANGE`、`E_CHUNK_MISSING`、`E_UNSUPPORTED`、`E_CANCELLED`）。用户界面把错误
码翻译成可操作说明；不得直接显示 C++ 堆栈作为唯一反馈。

## 页面与引擎边界

UI 通过 `window.krkr2Player` 命令面控制引擎，不直接修改 Wasm 内存或游戏块：
`preload / start / restart / stop / forceStop / show / hide / syncSaves /
snapshot`。状态变化经 `krkr2-player-state` DOM 事件广播。

引擎→页面钩子（由引擎补丁经 EM_JS/EM_ASM 调用，`player.js` 实现）：

| 钩子 | 职责 |
| --- | --- |
| `krkr2webEngineHeartbeat()` | 主循环存活心跳（约 1 Hz，页面看门狗据此判定停跳） |
| `krkr2webEngineQuit()` | 引擎自行退出（游戏内退出/关机）→ 页面干净停止并回库 |
| `krkr2webVideoOpen/Play/Stop/Pause` | 视频覆盖桥（`/videos/<gameId>/<stem>.mp4`，webm 后备） |
| `krkr2webDialogAsk/Poll/Dismiss` | 游戏确认对话框的页内模态应答（Asyncify 轮询，180 s 上限） |

约束：

- `fatalError`/崩溃后引擎进入停止状态；只有全新 `start`（自动走恢复重建链路）
  可以恢复。
- 存档同步：至少每 30 秒及 `visibilitychange`、`pagehide` 时执行；引擎自行
  退出时页面**不**再强制同步（引擎关闭自带 `FS.syncfs`，重复同步会在同一批
  IDB 事务上竞争直至 8 秒超时）。
- Worker 变体下 `worker.terminate()` 是硬停原语；引擎代码永不允许同步回调页面
  线程。

## 引擎变体选择与完整性自检

- 启动前 `Krkr2EngineWorkerHost.capability()` 探测（Worker/OffscreenCanvas/
  canvas 移交/IndexedDB/Offscreen WebGL）；不支持则使用主线程 baseline 变体。
- `/engine-manifest.json`（prepare 时生成）记录 js/wasm 各自字节数与 SHA-256
  及联合 build id；页面预载时校验 wasm，不匹配带 `krkr2bust` 参数强制重拉，
  仍不匹配则报"引擎文件校验失败"。
- `index.html` 注入 `<meta name="krkr2-engine-build">`；页面 build 与 manifest
  不一致时自动 reload 一次拉新脚本链（sessionStorage 防循环）。这是对抗宿主
  陈旧 HTTP 缓存把旧 js 胶水与新 wasm 混搭的唯一客户端防线。

## 诊断证据

- 产品页 localStorage：`krkr2web-d4-last-player`（最近播放器快照，含
  alerts/errors/engineLog 环形缓冲）与 `krkr2web-d4-last-session`（最近一次
  停止/冻结现场：stopReason、stalledAt、最后 40 行日志）。键名含历史前缀，
  为兼容既有诊断习惯保留。
- 设置页"上传诊断"POST `/api/diagnostics-reports`，报告 `probe` 字段为
  `krkr2web-product`（旧值 `d4-product` 仍被服务器接受）。
- 报告存入服务器 `diagnostic-reports/`（不提交 Git）；结论沉淀回本 docs。
- 冒烟测试依赖的全局探针：`window.d4AppState()` / `window.d4PlayerState()`
  （`tests/d4_browser_smoke.js`、`tools/check_d4_artifacts.py` 用）。

## 版本迁移与原子性

- schema 升级只能前向迁移；迁移失败保留旧数据并显示可恢复错误。
- 大数据迁移按批次执行并记录游标；禁止一个事务扫描全部游戏资源。
- 新游戏版本写入独立 `[gameId, version]` 命名空间；只有 `committing -> ready`
  的最终事务切换当前激活版本。
- 空间不足时不默认保留两份完整游戏；由用户确认删除旧版本再安装。
- 任何修复操作都不能删除存档，除非用户明确执行"删除存档"。
