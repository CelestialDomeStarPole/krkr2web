# 模块边界与接口契约

本文在编码前固定模块之间的数据形状和责任边界。字段可以通过版本迁移扩充，但
不能由各模块私自改变含义。

## 推荐目录结构

```text
apps/
  web/                  单页 UI、引擎预载、Canvas 和输入层
  resource-server/      Catalog、Manifest 和静态资源服务
packages/
  catalog/              目录与清单类型、解析和校验
  storage/              IndexedDB schema、迁移和事务
  downloader/           分块下载、校验和恢复状态机
  virtual-fs/           引擎只读文件与本地存档接口
  engine-bridge/        JavaScript、Asyncify 与 Wasm 边界
  diagnostics/          性能、错误和兼容性事件
engine/                 固定上游来源和项目补丁
tools/                  清单生成、资源扫描、构建与发布工具
tests/                  浏览器、实机用例和测试夹具
docs/                   产品与工程决策
```

实际导入上游后可以根据其构建结构调整目录名，但必须保持模块职责不混合。

## Catalog 契约

`catalog.json` 只描述服务端允许用户看到的游戏，不包含完整块哈希。

```json
{
  "schemaVersion": 1,
  "catalogVersion": "2026-08-12.1",
  "games": [
    {
      "gameId": "senren-banka",
      "title": "千恋万花",
      "version": "release-1",
      "manifestUrl": "/games/senren-banka/release-1/manifest.json",
      "requiredBytes": 4044268983,
      "compatibility": "verified",
      "coverUrl": "/assets/senren-banka.png",
      "description": "由服务端维护的游戏说明"
    }
  ]
}
```

约束：

- `schemaVersion` 是数据格式版本；不等于游戏版本。
- `catalogVersion` 变化用于刷新目录，但不能使已安装游戏失效。
- `gameId` 使用稳定的小写 ASCII 标识；发布后不复用给另一款游戏。
- `manifestUrl` 必须是管理员配置的同源 HTTPS 路径，客户端不接受用户输入 URL。
- `coverUrl` 若存在，必须是同源静态资源；不得指向 XP3 或动态下载接口。
- `description` 是可选展示文本，不参与内容版本和完整性校验。
- 未知 `schemaVersion` 必须明确报错，不能猜测字段含义。

## Manifest 契约

```json
{
  "schemaVersion": 1,
  "gameId": "senren-banka",
  "version": "release-1",
  "title": "千恋万花",
  "requiredBytes": 4044268983,
  "engineProfile": "senren-banka-v1",
  "packages": [
    {
      "id": "data.xp3",
      "virtualPath": "data.xp3",
      "url": "/games/senren-banka/release-1/data.xp3",
      "size": 2312777571,
      "chunkSize": 4194304,
      "sha256": "64-lowercase-hex-characters",
      "chunks": ["one-sha256-per-chunk"]
    }
  ],
  "mediaOverrides": []
}
```

- `version` 指向不可变内容；同一 URL 和版本不得静默替换字节。
- `requiredBytes` 至少等于所有包大小之和，发布工具负责校验。
- 包 `id` 和 `virtualPath` 在同一版本内唯一，禁止 `..`、反斜杠和绝对路径。
- `chunkSize` 首个 schema 固定为 `4194304`；最后一块可以更小。
- `chunks.length` 必须等于 `ceil(size / chunkSize)`。
- 所有大小、偏移和长度是非负整数，不得使用 JSON 字符串或 32 位位运算截断。
- 客户端必须先校验清单结构，再发起任何包下载。

## IndexedDB schema

数据库暂定名 `krkr2web`，首版 schema version 为 1：

| Object Store | 主键 | 值与责任 |
| --- | --- | --- |
| `catalog` | `catalogVersion` | 校验后的目录和获取时间 |
| `manifests` | `[gameId, version]` | 校验后的不可变 Manifest |
| `chunks` | `[gameId, version, packageId, chunkIndex]` | 单个 `ArrayBuffer`，最大 4 MiB |
| `chunkState` | 同 `chunks` | 长度、SHA-256、完成时间 |
| `installs` | `gameId` | 当前/待安装版本、状态、进度、完成标记 |
| `saves` | `[gameId, profile, path]` | 存档、全局设置等小文件 |
| `diagnostics` | `id` | 有上限的错误和性能记录 |

数据约束：

- 块数据与 `chunkState` 必须在同一事务提交。
- `installs.complete=true` 必须在所有包复核完成后的最后一笔事务写入。
- 启动只读取 `complete=true` 且 Manifest 版本匹配的安装。
- 删除采用有限批次事务；删除开始时先将安装设为不可启动。
- 应用更新不得清理 `chunks` 或 `saves`。

## 下载器状态机

```text
not-installed
  -> checking-space
  -> downloading <-> paused
  -> verifying
  -> committing
  -> ready

checking-space/downloading/verifying
  -> recoverable-error -> downloading
  -> fatal-error

ready -> deleting -> not-installed
```

- 状态写入必须可重复执行；进程在任一步骤中止后可以根据已提交块恢复。
- `recoverable-error` 包含断网、超时和服务器临时错误。
- `fatal-error` 包含 Manifest 非法、版本内容不一致和反复哈希失败。
- 暂停只停止新请求；已收到的数据仍完成校验和事务提交。
- 下载并发初值为 2，必须由实机测试决定最终值。
- 进度以已校验并提交的字节计算，不能把仅收到但未落库的数据算作完成。

## 虚拟文件读取 API

引擎看到同步式只读文件接口；JavaScript 内部可通过 Asyncify 异步完成：

```text
open(gameId, version, virtualPath) -> handle | error
size(handle) -> uint64 | error
read(handle, offset:uint64, length:uint32, destination) -> bytesRead | error
close(handle) -> void | error
```

约束：

- `open` 只允许访问已完成安装和已校验 Manifest 中列出的路径。
- `size` 与 `offset` 在 C/C++ 中使用 64 位无符号整数；JS 中使用安全整数并显式检查。
- `length` 必须有单次读取上限，初值 8 MiB；不得按文件大小直接分配内存。
- `read` 可以跨多个 4 MiB 块，结果按请求顺序复制到调用方目标区域。
- 读取到文件尾返回实际字节数；`offset > size` 是范围错误。
- 一个 Wasm 实例同一时刻只允许一个 Asyncify unwind；重入必须返回明确错误。
- `close` 后的 handle 不得复用；资源句柄表有固定上限。

存档使用独立的可写 API，不把游戏资源接口变为可写：

```text
saveWrite(gameId, profile, path, bytes) -> revision | error
saveRead(gameId, profile, path) -> bytes | not-found
saveDelete(gameId, profile, path) -> void | error
saveList(gameId, profile, prefix) -> entries | error
```

## 错误码

模块边界使用稳定错误码，并另带给开发者阅读的说明：

| 错误码 | 含义 |
| --- | --- |
| `E_NOT_INSTALLED` | 游戏或版本未完成安装 |
| `E_NOT_FOUND` | 路径、句柄或存档不存在 |
| `E_INVALID_MANIFEST` | 清单结构或字段非法 |
| `E_RANGE` | 偏移、长度或计算结果越界 |
| `E_CHUNK_MISSING` | 本地块缺失 |
| `E_INTEGRITY` | 哈希或内容长度不匹配 |
| `E_STORAGE` | IndexedDB 事务失败 |
| `E_QUOTA` | 空间不足或配额拒绝 |
| `E_NETWORK` | 可恢复的网络失败 |
| `E_VERSION_CHANGED` | 服务端内容与固定版本不一致 |
| `E_ASYNCIFY_STATE` | Asyncify 重入或状态损坏 |
| `E_UNSUPPORTED` | 目标环境或游戏功能不支持 |
| `E_CANCELLED` | 用户或生命周期事件取消操作 |

用户界面将错误码翻译成可操作说明；不得直接显示 C++ 堆栈作为唯一反馈。

## 版本迁移与原子性

- schema 升级只能前向迁移；迁移失败时保留旧数据并显示可恢复错误。
- 大数据迁移按批次执行，并记录游标；禁止一个事务扫描全部游戏资源。
- 新游戏版本写入独立 `[gameId, version]` 命名空间。
- 只有 `committing -> ready` 的最终事务能切换当前激活版本。
- 空间不足时不默认保留两份完整游戏；由用户确认删除旧版本再安装。
- 任何修复操作都不能删除 `saves`，除非用户明确执行“删除存档”。

## 存档命名空间

- 一级隔离使用 `gameId`，二级使用 `profile`；首版默认 `profile=default`。
- `path` 必须规范化为相对路径，拒绝 `..`、空路径和控制字符。
- 存档写入使用临时 revision，再由小事务切换当前 revision，防止中途中断损坏旧档。
- 游戏删除默认保留存档，并让用户单独选择是否删除。
- 模拟器全局设置不得写进任一游戏存档命名空间。

## UI 与引擎事件边界

UI 只能通过命令控制引擎，不能直接修改 Wasm 内存或 IndexedDB 游戏块：

```text
UI -> engine: start, pause, resume, stop, input, setVolume, requestSave, requestLoad
engine -> UI: bootProgress, ready, frameStats, saveListChanged, recoverableError,
              fatalError, mediaRequest, stopped
```

- 每条命令携带递增 `requestId`，结果回传同一 ID，避免页面切换后的旧响应污染状态。
- `fatalError` 后引擎进入停止状态；只有全新 `start` 可以恢复。
- `pause/resume` 与 Android 页面生命周期分离记录，避免重复恢复音频和渲染。
- 性能事件采样且有数量上限，不能每帧写 IndexedDB。
- 视频适配层通过 `mediaRequest` 返回播放完成、跳过或失败结果，保持脚本事件一致。

## 同页断网与资源缓存边界

- 产品页联网打开时预载引擎 Wasm；断网启动期间复用当前内存，不再次请求服务器。
- `/games/`、Catalog、Manifest 和任何 `.xp3` 不写入 Cache Storage；游戏资源唯一真相是
  IndexedDB 中通过哈希校验并提交的块。
- “启动游戏”和“返回游戏库”只修改当前文档的可见 UI，禁止修改 URL、刷新或导航。
- 游戏库联网时刷新并保存校验后的 Catalog；离线时只允许使用最后一次保存的 Catalog。
- 播放器只能启动 `installs.complete=true` 且版本匹配的游戏，禁止从网络按需补资源。
- IDBFS 挂载点为 `/savedata/{gameId}/`，播放器至少每 30 秒及 `visibilitychange`、
  `pagehide` 时执行一次同步。删除游戏资源默认不删除该命名空间。
- 前端版本升级不得清理 IndexedDB 的 `chunks`、`installs` 或存档。
