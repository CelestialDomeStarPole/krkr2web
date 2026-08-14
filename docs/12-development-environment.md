# 开发环境与可复现构建

## 推荐主机环境

本机默认使用 Windows 原生 Emscripten 构建，项目提供 PowerShell 安装与构建入口，
不要求安装或进入 WSL。CI 使用固定的 Linux 环境复核相同工具链和编译参数；未来
导入完整 KRKR2 引擎后，如果某个原生依赖只在 Linux 构建脚本中可复现，再单独启用
WSL2 或容器作为对照环境，而不是把它设为所有开发工作的前置条件。

本机 D0 需要的基础工具：

- Git，支持子模块。
- Python 3，用于构建脚本、Manifest、证书和资源扫描工具。
- Node.js，用于前端构建、静态检查和浏览器测试。
- emsdk/Emscripten，包括匹配版本的 LLVM 和 Binaryen。

完整引擎阶段还需要 CMake、Ninja、Bison、pkg-config、vcpkg 和常见 C/C++ 构建
工具；D0 最小探针不依赖这些组件。

这些名称是开发人员使用的构建工具；设计和验收人员不需要在目标 Android 设备上
安装它们。最终交付物仍是普通 HTTPS Web 应用。Windows 本机执行：

```powershell
.\tools\setup_d0_toolchain.ps1
.\tools\build_d0.ps1
```

## 工具链锁定策略

上游 `kirikiroid2-web` 的构建记录使用过 Emscripten `3.1.64` 和 `4.0.23`。D0 初始
以 `3.1.64` 作为 Chrome 89 兼容候选基线，因为它更接近旧浏览器目标；`4.0.23` 仅
用于对照上游当前行为，不能直接假定产物兼容 Chrome 89。

D0 必须实际编译并在目标 WebView 运行特性检查后，才能把版本写入锁定文件。最终
锁定至少包含：

- Linux/容器基础镜像摘要。
- emsdk、Emscripten、LLVM、Binaryen 版本。
- CMake、Ninja、Python、Node.js 版本。
- vcpkg 提交或 baseline；上游当前可见候选为
  `b1e15efef6758eaa0beb0a8732cfa66f6a68a81d`。
- 引擎、插件和全部 Git 子模块提交。
- npm/Python 依赖锁文件及哈希。

## Chrome 89 构建配置

目标构建必须禁用：

- pthreads 和共享 Wasm 内存。
- JSPI。
- Wasm 原生异常（`-fwasm-exceptions`）。
- Wasm reference types、Memory64 和 Wasm GC。
- 任何要求比 Chromium 89 更新运行时的默认输出。

构建使用 32 位 Wasm 线性内存和 64 位文件偏移。D0 应同时生成一个静态特性检查
报告和一个实机启动报告，避免“编译成功”被误当成“目标设备可运行”。

### Asyncify 原则

- 先使用保守插桩确保读取路径正确，再做尺寸和性能优化。
- 使用 `EM_ASYNC_JS` 或 Emscripten 官方 Asyncify 接口连接 IndexedDB Promise。
- 先观察 `ASYNCIFY_ADVISE` 输出，再决定是否收窄函数列表。
- 没有覆盖间接调用和异常路径的测试时，不启用 `ASYNCIFY_IGNORE_INDIRECT`。
- 不凭人工猜测编写过窄的 `ASYNCIFY_ONLY`；漏掉函数可能产生难以复现的损坏。
- 记录并实测 `ASYNCIFY_STACK_SIZE`，把重入和溢出转为明确错误。

## 上游参考仓库

完整本地镜像位于 `参考资料/开源项目/`，该目录被 Git 忽略，仅用于研究和离线构建
准备。精确提交及用途见 [上游基线与许可证审计](13-upstream-license-audit.md)。

D0 不应直接在参考仓库里形成产品源码。推荐流程是：

1. 以锁定提交导入项目拥有的 `engine/` 基线。
2. 保存可重复应用的项目补丁，避免无法审查的大量手工改动。
3. 完整保留上游 LICENSE 和版权声明。
4. 每次升级先在独立分支重放补丁，再执行 Chrome 89 和实机门禁。

## 可复现构建要求

- 一条命令可从已锁定依赖生成开发构建，另一条命令生成发布构建。
- 构建脚本不能依赖开发者机器上未声明的全局包。
- 构建输出记录源提交、工具版本、编译选项和 UTC 时间。
- CI 至少执行 C/C++ 单元测试、JS 测试、Manifest 校验和 Wasm 特性检查。
- 发布包生成 SHA-256 清单；相同输入应得到功能相同、依赖版本相同的产物。
- 任何更换 Emscripten 或上游提交的改动都必须重跑目标实机门禁。

## 本地 HTTPS 与实机部署

1. 开发电脑监听 `0.0.0.0`，让连接同一热点的设备可访问。
2. 用户通过 DNS 劫持把第三方 WebView 原有域名指向开发电脑。
3. 服务器为任意未知深层路径返回 `302`，导航到检测页或应用入口。
4. 所有页面、Worker、Wasm、Catalog 和游戏资源使用同一个 HTTPS origin。
5. 测试服务器提供 Range、正确 MIME、Cache-Control、COOP 和 COEP 响应头。
6. 每次实机报告记录页面构建号、证书类型、完整 UA 和 App 版本。

目标腾讯 TBS WebView 已确认无法注册 Service Worker，且断网后任何 URL 导航都会进入
网络错误页。D4 实机门禁改为：联网打开产品页，等待设置页“同页离线”显示“已准备”，
保持 WebView 不退出后断网，再在相同 URL 点击“启动游戏”。

## D0 完成记录（2026-08-13）

```text
探针源码：probes/d0-chrome89/src/probe.cpp
构建环境：Windows 原生工具链，不依赖 WSL
emsdk 提交：0b3bcbc3b005cbb811d48e497eabcc6846d43001
Emscripten：3.1.64
禁用特性检查：通过
现代 Chromium 对照：通过（Chromium 151）
目标 WebView 89：通过（Chrome 89.0.4389.72，Android 13，4 GiB 内存）
构建命令：.\tools\build_d0.ps1
Wasm SHA-256：585775ad81b904e351152cf709721b062cf4e863d70fd36dc660ad50fa45f67f
JS SHA-256：847ac41830bef354655097209bfd96483432a44305797222436c680ca0d6bc7d
实机报告：diagnostic-reports/20260813-042500-ed8c1130.json
已知问题：目标 TBS 宿主不可使用 Service Worker；D0 未测试文件读取性能。
```

## D1 当前实现（2026-08-13）

D1 使用同一套 Emscripten 3.1.64 工具链，Windows 原生构建命令为：

```powershell
.\tools\build_d1.ps1
.\tools\start_d1_probe.ps1 -HostName game.example.com -Port 443
```

探针使用独立数据库 `krkr2web-d1-probe`，写入约 40 MiB 稀疏测试块，表示一个超过
5 GiB 的逻辑文件。浏览器端只缓存 4 个 4 MiB 块；C++ 通过 Asyncify 发起同步式
`read`，实际等待 IndexedDB 异步事务。桌面现代 Chromium 已完成 14/14 项快速门禁，
目标 WebView 89 已通过快速门禁，报告编号为 `20260813-050844-4e39fcd2`。报告
`20260813-060205-c2cb3221` 记录了后台 51.36 秒后的成功恢复，以及约 13 分 57 秒
连续读取趋势：7,600 次读取、约 158 MiB 校验、16 MiB 块缓存、64 MiB Wasm 堆，
无内存增长，最长页面间隔约 77.86 ms。D1 已完成。
