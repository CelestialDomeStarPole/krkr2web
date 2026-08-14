# KRKR2 Web 产品与开发文档

本文档集描述一个运行在第三方 Android WebView 89 中的通用 KRKR2 游戏模拟器。
目标 WebView 不可修改、不可升级，也不能使用系统文件下载或文件选择器。因此，
应用程序和游戏资源都必须通过 HTTPS 获取，并保存在浏览器站点存储中。

## 阅读顺序

设计、产品或测试人员先阅读 00、07、10；开发人员按 10 的阶段门禁工作，并以
11、12、14 作为接口与架构约束。旧的可行性问题保留在 01、08 中，不应绕过已经
记录的实机结论重新假设能力。

## 文档索引

- [00-产品范围与验收](00-product-scope.md)
- [01-可行性验证计划](01-feasibility-plan.md)
- [02-候选架构](02-architecture.md)
- [03-资源缓存协议](03-resource-cache-protocol.md)
- [04-Chrome 89 兼容边界](04-chrome89-compatibility.md)
- [05-内存与性能预算](05-memory-performance.md)
- [06-游戏兼容与视频路线](06-game-compatibility-media.md)
- [07-测试与验收](07-test-acceptance.md)
- [08-风险、假设与待确认项](08-risks-and-open-questions.md)
- [09-开发就绪评审](09-development-readiness.md)
- [10-开发路线图与阶段门禁](10-development-roadmap.md)
- [11-模块边界与接口契约](11-module-contracts.md)
- [12-开发环境与可复现构建](12-development-environment.md)
- [13-上游基线与许可证审计](13-upstream-license-audit.md)
- [14-架构决策记录](14-architecture-decisions.md)
- [D2 游戏下载与缓存验证](../probes/d2-downloader/README.md)
- [D3 KRKR2 引擎验证](../probes/d3-engine/README.md)

## 当前结论

2026-08-12 已在目标设备完成第一轮实机验证：

1. **大容量缓存门槛已通过。** 站点配额约 27.19 GiB；5 GB IndexedDB 数据写入
   成功，关闭第三方 App 后仍存在，整台设备重启后也仍存在。
2. **共享内存主方案不通过。** 服务器已返回正确的 COOP/COEP 响应头，但目标
   WebView 仍未开放 `SharedArrayBuffer`、跨源隔离和 Wasm 共享内存。
3. **目标宿主不支持 Service Worker。** 腾讯 TBS 046295 注册失败，且断网导航会进入
   错误页；产品已改为当前文档内预载引擎和切换 Canvas，只验收页面不退出时的断网启动。

项目仍有条件可行。D0、不依赖共享内存的 D1 文件读取 PoC 和 D2 真实 4 GB 下载
存储均已通过，当前进入 D3 完整引擎最小闭环。第一轮实机报告为
`diagnostic-reports/20260812-145616-0060df64.json`，其中 5 GB 测试显示为用户取消，
关闭 App 与设备重启后的保留结果由测试者在报告上传后人工确认。检测工具运行方式
见 [检测工具说明](../diagnostics/README.md)。

## 开发阶段结论

文档详细度已经能够支撑开发，但只授权按门禁推进：

- D0 已通过：Chrome 89 最小构建可加载且不包含禁用特性。
- D1 已通过：Asyncify + IndexedDB 文件读取、后台恢复和内存趋势满足门禁。
- D2 已通过：4.04 GB 下载、恢复、全量校验、坏块修复和空间回收均有实机证据。
- D3 可以开始：接入 KRKR2 最小引擎、XP3/TJS/KAG、图形、音频、输入和存档闭环。
- D3 第一轮桌面门禁已通过：IndexedDB XP3、TJS 与 KRKR2 原生画布出帧已形成闭环；
  目标 WebView 89 实机也已复核通过，当前继续文字、图像、音频、输入和存读档。

这一限制是技术风险控制，不是需求不完整。完整评审见
[开发就绪评审](09-development-readiness.md)。
