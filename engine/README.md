# 引擎基线

浏览器引擎从锁定提交的 `krkrsdl2` 构建，项目改动以可审计的方式分层登记；
上游检出位于 `参考资料/开源项目/`（仅作研究输入，构建从不修改它）。

```text
engine/
  upstream.json          构建锁与来源权威：底座提交、sourceImports、补丁清单
  patches/NNNN-*.patch   按序应用的补丁（与 upstream.json 一一对应，单测强制）
  plugins/               项目自有插件源码（NCB 移植/垫片，构建时拷入）
  webp/LoadWEBP.cpp      WebP 加载器（配合 libwebp decode 子集）
  motionplayer-web/      motionplayer 软件光栅兼容层
  profiles/              逐游戏引擎 profile（gameId-v1.json → engine-profiles.js）
  audio/                 音频解码源
  worker-runtime-contract.json   Worker/GPU 运行时机器可读契约
```

## 构建

`tools/build_d3.ps1` 把锁定检出导出到忽略的 `build/d3-engine-work/`，按
`upstream.json` 应用全部补丁（`tools/apply_patch.py`，禁用 git apply），拷入
项目插件与导入源码，CMake + Ninja 编译，`check_worker_contract.py` 校验后产出到
`build/d3-engine/`。完整流程与构建树语义见 [构建与部署](../docs/04-build-and-deploy.md)。

## 运行时要点

- 单个单线程 Wasm 实例：无 pthreads、无共享内存、无 SIMD、无 JSPI、无 Wasm
  原生异常（Chrome 89 边界，见 [架构](../docs/02-architecture.md)）。
- 同步 KRKR2 文件调用经 Asyncify 挂起，等待 IndexedDB 分块 Promise；XP3 段
  解压走持久化 Inflate Worker 池。
- 两种宿放形态共用同一 wasm：Dedicated Worker + OffscreenCanvas 变体，或主线程
  baseline 变体（目标实机形态）。
- 存档经 Emscripten IDBFS 挂载于 `/savedata/<gameId>/`，关闭时引擎自行
  `FS.syncfs`。
- 引擎对页面的钩子（视频桥、对话框桥、心跳、退出通知）与 `KRKR2WEB_*` 遥测
  标签的清单见 [模块契约](../docs/03-module-contracts.md)。

## 修改纪律

对上游源码的任何修改必须固化为 `engine/patches/` 补丁并登记
`upstream.json`；补丁编号只增不复用，退役补丁连同文件删除。导入其他仓库源码
走 sourceImports（记录来源、提交与许可证，见
[上游基线与许可证](../docs/08-upstream-licensing.md)）。补丁写作的环境陷阱
（CRLF/LF、UTF-16 字符串、上下文行号）见
[排障手册](../docs/06-troubleshooting.md)。
