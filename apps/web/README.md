# Web 产品壳

面向用户的单文档应用：游戏库、下载管理、存档管理与设置内嵌于同一 HTML，播放器
以同页覆盖层呈现，"启动游戏"与"返回游戏库"不触发任何导航（目标宿主断网后 URL
变化必进错误页，见 docs/02 同页断网模型）。`prepare_d5_product.ps1` 组装本目录
与 D2 下载器、D3 存储桥和 KRKR2 Wasm，输出到 `build/d5-product`。

## 页面与脚本

| 文件 | 职责 |
| --- | --- |
| `index.html` / `app.js` | 四页面框架、目录/安装状态渲染、下载操作、诊断上传 |
| `player.js` | 同页播放器：引擎预载与完整性自检、启动/重启/强停、看门狗、视频覆盖桥、游戏对话框桥 |
| `engine-worker-host.js` / `engine-worker.js` | Dedicated Worker + OffscreenCanvas 引擎变体（能力探测失败自动回退主线程 baseline） |
| `save-manager.js` | 存档页：IDBFS `/savedata/<gameId>` 读取、分类展示、删除、服务器导入通关存档 |
| `play/` | 独立播放器页（`/play/?gameId=`，无产品壳的直达启动路径） |
| `play/prefetch.js` | 预取流水线：数字后继预测、段/图像双公园、原生解码 Worker、Inflate 池 |

## 能力边界

- 只显示服务端 `catalog.json` 配置的游戏；只允许启动 `complete=true` 且版本
  匹配的安装；启动阶段零网络请求。
- XP3 不进 Cache Storage，只以 4 MiB 块存于 IndexedDB；删除游戏资源不删除存档。
- 存档按 `gameId` 隔离（IDBFS），至少每 30 秒及 `visibilitychange`/`pagehide`
  同步；引擎自行退出时页面不再强制同步（避免与引擎自带 syncfs 竞争超时）。
- 界面文案面向最终用户；内部代号只出现在诊断遥测（`KRKR2WEB_*` 日志标签、
  报告字段）中。

## 本地检查与运行

```powershell
.\tools\prepare_d5_product.ps1          # 组装 + 语法门禁 + 产物校验（staging 原子换入）
.\tools\start_d5_product.ps1 -Http -SkipBuild   # 本机 http 预览
```

浏览器冒烟：`tests/d4_browser_smoke.js`（安装、断网零请求启动、存档管理、
模拟崩溃恢复）。UI 状态全局探针 `window.d4AppState()` / `window.d4PlayerState()`
供冒烟测试与现场诊断使用。
