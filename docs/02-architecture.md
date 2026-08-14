# 候选架构

## 总体结构

```text
HTTPS 资源服务
  ├─ 模拟器静态文件（HTML/JS/Wasm/Worker）
  ├─ 游戏库 catalog.json
  ├─ 每个游戏的 manifest.json
  └─ XP3 与预处理媒体，支持 HTTP Range
                    │
                    ▼
第三方 Android WebView 89
  ├─ 单页 UI：游戏库、下载管理、设置、Canvas 和错误报告
  ├─ 引擎预载：联网打开页面时把 JS/Wasm 准备到当前文档
  ├─ Download Worker：下载、哈希校验、断点续传
  ├─ IndexedDB：游戏分块、清单、存档、安装状态
  ├─ 异步存储适配层：按需读取 IndexedDB 分块
  └─ 单线程 KRKR2 Wasm：Asyncify 文件等待、渲染、音频、输入
```

## 为什么使用 IndexedDB

Android WebView 89 不提供可用的现代网页文件系统接口，也不能调用系统文件选择器。
IndexedDB 是该环境中唯一现实的浏览器持久化大对象方案。它仍需要通过 5 GB 实写
测试确认配额、持久性和性能，不能仅凭 API 存在就宣布可行。

游戏数据使用固定大小块保存，而不是把一个 2.31 GB XP3 保存为单个 Blob。这样可
以限制内存、恢复中断下载、校验坏块，并规避超大 Blob 在旧 WebView 中的实现风险。

## 文件读取桥

KRKR2 和多数原生库按“调用读取函数后立即拿到结果”的同步模型工作，IndexedDB
只能异步读取。原候选方案如下：

1. KRKR2 运行在 Engine Worker，不阻塞页面 UI。
2. C++ 文件读取进入一个同步 JavaScript 桥，提交文件 ID、64 位偏移、长度和目标
   Wasm 内存地址。
3. I/O Worker 从 IndexedDB 取出所需块，直接复制到共享 Wasm 内存。
4. Engine Worker 在 `Atomics.wait` 中休眠，I/O Worker 完成后唤醒。

实机已确认：即使响应头正确，目标 WebView 也不提供 `SharedArrayBuffer`、
`crossOriginIsolated` 或 Wasm 共享内存，因此上述多 Worker 共享内存方案不能作为
目标设备架构。

当前候选改为单线程 KRKR2 Wasm + Asyncify。C++ 文件读取发生时挂起 Wasm 调用栈，
JavaScript 异步读取 IndexedDB 分块并复制所需范围，完成后恢复执行。XP3 仍不整体
进入 Wasm 堆，只保留当前读取结果和有界块缓存。该路线会增加代码体积和调用开销，
必须通过 FV-2 的随机读取、帧率与内存测试后才能确定可行。

## 目标宿主的同页约束

实机 UA 为 Chrome 89 + 腾讯 TBS 046295。该宿主无法注册 Service Worker；断网后只要
发生从一个 URL 到另一个 URL 的导航，就会由宿主显示网络错误页。因此产品不是多页面
播放器：联网进入游戏库时预载引擎 JS/Wasm，“启动游戏”和“返回游戏库”只切换同一
文档中的 UI 与 Canvas，禁止修改 `location`、点击站内链接或重新加载。游戏启动阶段
只能读取当前内存中的引擎和 IndexedDB 中已完成安装的资源。

## 服务端建议

首阶段不需要账号或复杂业务服务。使用静态 HTTPS 资源服务即可，必须具备：

- HTTP Range 和正确的 `206 Content-Range`。
- 稳定的 `ETag` 或内容版本号。
- 正确的 MIME 类型和缓存头。
- `Cross-Origin-Opener-Policy: same-origin`。
- `Cross-Origin-Embedder-Policy: require-corp`。
- 所有页面、Worker、Wasm 和游戏资源同源。

游戏清单可由离线构建工具生成。需要后台管理界面以前，管理员通过配置文件发布
游戏，减少首版服务端复杂度。

## 前端页面

- 游戏库：只展示服务端配置的游戏。
- 下载管理：总大小、已完成、速度、剩余空间、暂停/继续/删除。
- 我的游戏：已安装游戏、兼容等级、启动、修复和删除。
- 游戏画面：固定横屏画布和低干扰控制层。
- 设置：画质、音量、触摸布局、性能模式、错误报告。

默认输入根据 `pointer: coarse` 和触摸能力选择。触摸是默认移动端输入；鼠标、键盘
和标准 Gamepad API 作为增强能力。
