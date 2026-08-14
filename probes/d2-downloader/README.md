# D2 游戏下载与缓存验证

D2 验证服务端目录、Manifest、HTTP Range、4 MiB 分块下载、SHA-256 校验、
IndexedDB 事务提交、暂停与恢复、坏块修复、原子完成标记和分批删除。

该门禁已于 2026-08-13 在目标 Chrome 89 WebView 通过。实机完成 4.04 GB、966 块
下载与复核，坏块只重下一个块，资源删除后站点用量从 4.46 GiB 降至 707.22 MiB。

## 数据边界

- 正式数据库名为 `krkr2web`，schema version 为 1。
- 游戏资源块按 `[gameId, version, packageId, chunkIndex]` 保存为原始 `ArrayBuffer`。
- 块状态与块字节在同一个 IndexedDB 事务提交。
- 网络最多两个并发请求，单个响应最多 4 MiB，同时处理的响应上限为 8 MiB。
- 页面重新打开时只复用长度、版本和哈希元数据都符合 Manifest 的已提交块。
- 全量逐块重新计算 SHA-256 后，最后一个独立事务才写入 `complete=true`。
- 删除开始时先关闭启动状态，再按每批最多 32 块清理；默认不删除 `saves`。

## Windows 准备与启动

首次准备会顺序读取三个 XP3 并计算完整文件和分块哈希，不复制资源：

```powershell
.\tools\prepare_d2_probe.ps1
```

只要源文件大小和修改时间不变，后续会复用 `build/d2-metadata` 中的哈希结果。
怀疑原文件被原地修改时使用 `-Force` 重新扫描。

本机 HTTP 验证：

```powershell
.\tools\start_d2_probe.ps1 -Http -BindAddress 127.0.0.1 -Port 8767
```

目标设备 HTTPS 验证：

```powershell
.\tools\start_d2_probe.ps1 -HostName game.example.com -BindAddress 192.168.137.1 -Port 443
```

深层页面 URL 不存在时，服务器仍会 `302` 回到 `/`。清单中的 XP3 URL 是例外：
资源不存在、Range 越界或版本不一致会返回明确错误，不会回退到页面。

## 实机顺序

1. 开始完整下载，下载一部分后点击暂停，再继续。
2. 下载中断网、关闭 App 或结束进程，再进入页面继续。
3. 完成后确认页面显示“资源可用”，上传一次报告。
4. 点击“模拟一个坏块”，随后点击“修复坏块”，确认只新增一个网络请求。
5. 再次上传报告。需要检查空间回收时，最后删除游戏数据并上传报告。

实机报告写入 `diagnostic-reports/`，不会上传游戏内容。
