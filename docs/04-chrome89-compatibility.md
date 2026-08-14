# Chrome 89 兼容边界

## 已在目标设备确认的能力

目标 WebView 实机已确认：

- WebAssembly 核心、WebGL 1/2、Web Audio、Fetch、Worker、Cache Storage 和
  IndexedDB 可用。
- Service Worker API 存在，但在目标腾讯 TBS 046295 中注册失败，产品不能依赖它。
- `Atomics` 方法存在，但 `SharedArrayBuffer`、`crossOriginIsolated` 和 Wasm 共享
  内存不可用；服务器响应头已经排除为原因。
- H.264、VP8、VP9 和常见 Web Audio 格式由浏览器报告为可播放。

Wasm BigInt 与 i64 互操作、ReadableStream 的具体用法和 HTTP Range 仍需由 D0/D2
自动测试固定，不能只按 Chrome 89 理论能力推断。

## 明确不能依赖的能力

| 能力 | 原因 | 替代方案 |
| --- | --- | --- |
| JSPI | Chromium 137 才支持 | 单线程 Wasm + Asyncify |
| Wasm 原生异常 | Chromium 95 才支持 | Emscripten 旧式 JavaScript 异常模型 |
| Wasm reference types | Chromium 96 才完整支持 | 编译时关闭/降级 |
| OPFS 同步访问句柄 | Chromium 102 才支持 | IndexedDB 分块 |
| Android OPFS | Android Chromium 109 起 | IndexedDB 分块 |
| WebCodecs | 不属于 Chrome 89 基线 | HTML5 硬件视频或 Wasm 解码 |
| File System Access | WebView 不允许用户选文件 | 只使用服务端游戏库 |

## 构建约束

- 固定并记录 Emscripten、LLVM、CMake、vcpkg 和依赖版本。
- 链接时声明 Chrome 89 为最低浏览器目标。
- 禁止 JSPI、Wasm 原生异常、reference types、Memory64 和 Wasm GC。
- 目标构建关闭 pthreads；该 WebView 无共享 Wasm 内存，线程构建无法运行。
- 使用 Asyncify 连接同步 C++ 文件 API 与异步 IndexedDB；先用默认分析确保正确，
  再依据 `ASYNCIFY_ADVISE` 谨慎缩小插桩范围。
- 不得直接启用 `ASYNCIFY_IGNORE_INDIRECT` 或手写 `ASYNCIFY_ONLY`，除非已有覆盖间接
  调用、异常和 TJS 解析路径的自动测试；错误列表会产生难以定位的运行时损坏。
- 使用 32 位 Wasm 线性内存；XP3 本身不进入线性内存，仅按需复制小范围数据。
- 生产环境所有资源同源。COOP/COEP 可以保留用于现代浏览器，但不能将其视为目标
  WebView 开启共享内存的条件保证。

## HTTPS 与证书风险

检测服务会生成自签根证书和指定域名的服务端证书。Android 7 以后，第三方 App
是否信任用户安装的根证书取决于该 App 的网络安全配置。因此“系统中已安装证书”
不保证该 WebView 一定接受证书。

若实机拒绝用户根证书，开发环境必须改用受系统信任的真实证书和自有域名；DNS
仍可把该域名指向热点内的开发电脑。正式部署也应使用公开受信任证书。
