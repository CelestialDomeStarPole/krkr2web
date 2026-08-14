# 资源缓存协议

## 服务端清单

`catalog.json` 只包含可见游戏和版本。每个游戏的 `manifest.json` 至少包含：

```json
{
  "schemaVersion": 1,
  "gameId": "senren-banka",
  "version": "content-sha256-or-release-id",
  "title": "千恋万花",
  "requiredBytes": 4044268983,
  "packages": [
    {
      "id": "data.xp3",
      "url": "/games/senren-banka/data.xp3",
      "size": 2312777571,
      "chunkSize": 4194304,
      "sha256": "full-file-sha256",
      "chunks": ["chunk-0-sha256", "chunk-1-sha256"]
    }
  ],
  "compatibility": "verified",
  "engineProfile": "senren-banka-v1",
  "mediaOverrides": []
}
```

最终清单需要签名或由 HTTPS 完整性保证。首版无账号，不在客户端保存服务端秘密。

## IndexedDB 数据模型

建议使用一个数据库，按游戏和版本隔离：

| 存储区 | 键 | 内容 |
| --- | --- | --- |
| `catalog` | `catalogVersion` | 游戏库缓存 |
| `manifests` | `[gameId, version]` | 完整清单 |
| `chunks` | `[gameId, version, packageId, chunkIndex]` | 4 MiB 二进制块 |
| `chunkState` | 同上 | 哈希、长度、完成时间 |
| `installs` | `gameId` | 当前激活版本、总进度、完成标记 |
| `saves` | `[gameId, path]` | 存档和设置小文件 |
| `diagnostics` | 名称 | 崩溃前状态和性能摘要 |

首个 schema 的块大小固定为 4 MiB，与已通过的 5 GB 实机测试和 ADR-001 一致。
若 D1/D2 证明该大小存在明显性能或稳定性问题，必须通过新的 schema 和迁移决策
调整，不能让同一版本的 Manifest 混用块大小。块键和偏移不能使用 32 位位运算；
文件大小、偏移在 JS 中使用安全整数，在 Wasm/C++ 中使用 64 位整数。

## 下载状态机

```text
未安装 → 检查空间 → 下载中 ⇄ 已暂停 → 全量校验 → 提交完成 → 可启动
                         │              │
                         └→ 可恢复失败 ←┘
```

- 开始前要求可用配额至少为资源大小的 1.15 倍，并预留应用壳和存档空间。
- 每块单独下载、校验、提交；默认 2 个并发请求，按实机结果调整。
- 服务器变化或哈希不匹配时废弃该块，不混用不同版本。
- 只有所有包完成并复核后才写 `complete=true`。
- 新版本先写入独立命名空间，成功后原子切换；空间不足时不自动双份升级，提示用户
  删除旧版本或重新安装。
- 删除游戏时先禁止启动，再分批删除块，防止长事务卡死页面。

## 断网与更新

XP3 只由 IndexedDB 管理，不写入 Cache Storage。联网打开产品页时，当前文档预载小型
引擎 Wasm；之后断网启动游戏时不导航、不重新请求引擎，只读取已完成安装的本地清单
和资源块。数据库升级不得删除 `chunks` 或 `saves`，且必须可恢复。

Catalog 联网时更新并保存到本机。当前页面断网后继续显示已加载目录和安装状态；网络
失败不能阻塞同页启动。退出 WebView 后的断网重新进入不属于目标设备支持范围。
