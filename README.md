# krkr2web

面向固定 Android WebView 89 的通用 KRKR2 Web 模拟器。用户从服务端配置的游戏库
下载完整资源到浏览器站点存储；页面保持在 WebView 内时，断网后仍可启动、游玩和
读取本地存档。首个完整验收游戏为《千恋万花》。

## 当前状态

《千恋万花》已在本地 Chrome 与目标设备（Android 13 / 腾讯 TBS 宿主 /
Chromium 89）上**完整可玩**：剧情推进、存读档、场景回想、CG 鉴赏、视频
（预转码 MP4）、触摸手势（含双指点按=右键）。4 GiB 级分块下载支持断点续传与
页面刷新自动续传；断网同页启动零网络请求、URL 不变；引擎崩溃后可同页恢复。

收尾中：新游戏开场约 25 秒加载停顿的优化、20 FPS 与 60 分钟稳定性的正式实机
测量。完整门禁结论与报告编号见
[验证记录](docs/09-verification-log.md)，已知问题见
[排障手册](docs/06-troubleshooting.md)。

## 近期优化（2026-08）

一轮围绕流畅度与稳定性的集中优化，已全部通过桌面验证，细节见
[迁移开发记录](docs/10-migration-log.md)：

- 更省电：引擎不再跑满浏览器帧率（默认 20 帧，可调），CPU 占用大幅
  下降；语音快播完时自动补帧，不会断音。
- 动画更顺：消除了浏览器帧时钟抖动对游戏计时的影响，渐变与移动
  不再偶发跳顿。
- 点击响应更快：视频等大文件读取不再挤占缓存，常用语音与立绘
  留在缓存里。
- 画面更稳：修复部分设备上着色器精度不足导致的画面异常。
- 更安全：开第二个标签页会提示“引擎已在其他标签页运行”，不再
  互相抢存档；游戏正常退出不再被误判为崩溃。
- 排障更容易：`?debugEarlyLogs=1` 可留存页面刚加载时的全部日志；
  断网启动在 worker 模式下也做到零网络请求。

## 快速开始

```powershell
# 前置：克隆上游参考仓库到 参考资料/开源项目/ 并 checkout 到锁定提交（docs/08）
.\tools\setup_d0_toolchain.ps1        # 首次：安装锁定版 Emscripten 3.1.64
.\tools\prepare_d2_probe.ps1          # 首次：扫描游戏 XP3 生成 catalog/manifest
.\tools\start_d5_product.ps1          # 构建引擎与产品壳并启动 https://0.0.0.0:443/
```

实机访问需热点 + DNS 劫持 + 开发证书，步骤见
[构建与部署](docs/04-build-and-deploy.md)。

## 文档

- [文档总览与阅读顺序](docs/README.md)
- [产品范围与当前状态](docs/01-product-scope.md)
- [架构与运行时](docs/02-architecture.md)
- [模块契约](docs/03-module-contracts.md)
- [构建与部署](docs/04-build-and-deploy.md)
- [游戏适配指南](docs/05-game-adaptation.md)
- [排障手册](docs/06-troubleshooting.md)
- [架构决策记录](docs/07-architecture-decisions.md)
- [上游基线与许可证](docs/08-upstream-licensing.md)
- [验证记录](docs/09-verification-log.md)
- [迁移开发记录](docs/10-migration-log.md)

## 仓库内容

```text
apps/web/             产品壳：游戏库、下载、存档、设置与同页离线播放器
engine/               引擎基线：上游锁、补丁、自有插件与逐游戏 profile
probes/               开发期技术门禁探针（d2 下载、d3 引擎、d5 兼容诊断）
diagnostics/          WebView 实机能力检测页
tools/                构建、清单生成、服务器与证书工具
tests/                单元测试与浏览器冒烟
docs/                 产品与工程文档
toolchains/           构建工具链锁定信息
build/                构建产物（可重建，不提交）
参考资料/            开发用游戏资源与上游仓库缓存（不提交，不属于产品）
diagnostic-reports/   实机报告运行数据（不提交，结论沉淀在 docs/）
```

技术路线一句话：单线程 KRKR2 Wasm + Asyncify + IndexedDB 4 MiB 分块读取，
同页断网模型，服务端预转码视频。上游来源与补丁可审计（`engine/upstream.json`），
项目本身不包含、分发或授权任何商业游戏资源。

## 许可证

项目原创代码采用 MIT（见 [LICENSE](LICENSE)）；随仓库提交或构建时导入的第三方
组件保留各自原始许可（宽松许可，无 copyleft），完整清单见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，审计方法见
[上游基线与许可证](docs/08-upstream-licensing.md)。
