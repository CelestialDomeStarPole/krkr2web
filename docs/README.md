# KRKR2 Web 产品与开发文档

本文档集描述一个运行在固定第三方 Android WebView（Chromium 89）中的通用 KRKR2
游戏模拟器：用户从服务端配置的游戏库下载完整资源到浏览器站点存储，页面保持在
WebView 内时断网仍可启动、游玩和读取本地存档。首个完整验收游戏为《千恋万花》。

## 阅读顺序

- 新成员与评审：01 产品范围 → 02 架构与运行时 → 09 验证记录。
- 日常开发：02 架构 → 03 模块契约 → 04 构建与部署；改引擎前先读 07 决策记录。
- 适配新游戏：05 游戏适配指南。
- 排障：06 排障手册，先读其中"环境陷阱"一节。

## 文档索引

- [01-产品范围与当前状态](01-product-scope.md)
- [02-架构与运行时](02-architecture.md)
- [03-模块契约](03-module-contracts.md)
- [04-构建与部署](04-build-and-deploy.md)
- [05-游戏适配指南](05-game-adaptation.md)
- [06-排障手册](06-troubleshooting.md)
- [07-架构决策记录](07-architecture-decisions.md)
- [08-上游基线与许可证](08-upstream-licensing.md)
- [09-验证记录](09-verification-log.md)

另见各子目录 README：[apps/web 产品壳](../apps/web/README.md)、
[engine 引擎基线](../engine/README.md)、
[diagnostics 实机检测工具](../diagnostics/README.md)、
[probes/d2-downloader 下载探针](../probes/d2-downloader/README.md)、
[probes/d3-engine 引擎探针](../probes/d3-engine/README.md)。

## 两条铁律

1. **实机结论不可绕过。** 09 号文档记录的目标设备能力边界（无 SharedArrayBuffer、
   Service Worker 不可注册、断网后任何 URL 变化必进宿主错误页等）全部有实机报告
   为证。任何新方案不得按"现代浏览器应该可以"重新假设这些结论。
2. **引擎改动必须走补丁。** 对上游引擎源码的任何修改都要固化为
   `engine/patches/NNNN-*.patch` 并登记进 `engine/upstream.json`；构建工作树
   （`build/d3-engine-work`）是可丢弃的，直接改它会在下次重建时丢失。

## 组织方式说明

本目录早期按 D0-D6 开发门禁阶段组织（可行性计划、路线图、逐阶段验收过程等）。
项目于 2026-08 达成"完整可玩"里程碑并进入产品化阶段后，上述内容已提炼并入本文
档集：门禁结论与实机报告编号归档于 09 号文档，排障与事故经验归档于 06 号文档，
逐阶段的过程细节请查阅 Git 提交历史。
