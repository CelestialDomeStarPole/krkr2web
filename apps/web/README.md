# D4 Web 产品壳

本目录是面向用户的第一轮产品页面，不是独立诊断探针。构建脚本会复制这里的页面，
并加入 D2 下载器、D3 只读文件桥和 KRKR2 Wasm，输出到 `build/d4-product`。

## 当前能力

- 从服务端 `catalog.json` 展示游戏；用户不能输入资源地址。
- 完整下载、暂停、继续、校验和删除游戏资源。
- 只允许启动已经完整校验并原子提交为 `ready` 的版本。
- 联网打开页面时预载引擎；断网后在相同 URL 内启动并读取 IndexedDB 资源。
- 游戏库和 Canvas 位于同一个 HTML 文档，启动和返回都不触发导航。
- 播放器按 `gameId` 隔离 IDBFS 存档，定时并随页面生命周期同步。
- 设置页显示同页离线准备、存储、输入模式和内核状态，并可上传 D4 诊断报告。

## 存储边界

XP3 不复制到 Web 构建目录，也不进入 Cache Storage；它只通过服务端 Range 接口传输，
并以 4 MiB 块写入 IndexedDB。删除游戏资源不会删除本机存档。

## 构建与本地检查

```powershell
.\tools\prepare_d4_product.ps1
python tools\https_diagnostics_server.py --http --bind 127.0.0.1 --port 8768 `
  --directory build\d4-product --reports-directory diagnostic-reports `
  --resource-map build\d4-product\resource-map.json
```

正式实机入口使用 `tools/start_d4_product.ps1`，默认监听 `0.0.0.0:443` 并为
`game.example.com` 生成测试证书。

## D4 验收结果

- 目标 WebView 89 的断网同页启动已通过，报告编号
  `20260813-151518-903d7485`。
- 多游戏真实目录、版本升级策略的实机覆盖。
- 《千恋万花》专用插件、性能和 60 分钟稳定性属于 D5。
- 视频是 D6 必做能力，首轮产品壳未实现，但没有从产品范围移除。
