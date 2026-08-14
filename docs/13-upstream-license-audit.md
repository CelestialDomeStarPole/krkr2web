# 上游基线与许可证审计

## 固定基线

审计和 D0 开发以 2026-08-12 获取的以下提交为准：

| 仓库 | 分支 | 固定提交 | 主要用途 |
| --- | --- | --- | --- |
| `https://github.com/2468785842/krkr2` | `main` | `dca7264572a63e753c1b07ca7053513d1751ce70` | KRKR2/KRKRZ 衍生引擎与插件实现参考 |
| `https://github.com/fenghengzhi/kirikiroid2-web` | `web` | `338d2029f16969b84becfd163c67f99740e28296` | 当前 Web 移植、插件、图形/SDL 和游戏兼容主参考 |
| `https://github.com/krkrsdl2/krkrsdl2` | `main` | `3f384a6869f6726929c777bdd0e0c871d5d5383d` | SDL2 路线和较轻量 KRKR2 实现对照 |

完整仓库和其声明的子模块已缓存到 `参考资料/开源项目/`。该目录不提交到本项目 Git，
但开发环境应保留上述提交表，使另一台机器能够复现同一审计对象。
完整的递归子模块 URL 与提交记录见 [机器可读锁定清单](upstream-lock.json)。

## 可以复用的内容

`kirikiroid2-web` 是最接近产品目标的功能基线，优先研究：

- KRKR2/TJS/KAG 引擎功能和现有插件实现。
- SDL/WebGL/Web Audio 的浏览器适配。
- 《千恋万花》相关 motionplayer、PSB/PIMG 和图层兼容修复。
- `VirtualLazyFS` 的按需文件数据模型和虚拟路径设计思路。
- 上游构建脚本、依赖列表和自动化测试可迁移的部分。

`krkr2` 用于核对引擎来源和非 Web 行为；`krkrsdl2` 用于比较 SDL2 架构、依赖选择
和实现复杂度。复用必须以代码审查和目标实机测试为准，不等于整仓直接复制。

## 必须替换或回退的内容

`kirikiroid2-web` 当前 `web` 分支面向更现代的浏览器，已发现以下目标环境阻断项：

- JSPI：目标 Chromium 89 不支持，改为 Asyncify。
- `-fwasm-exceptions`：目标版本不支持 Wasm 原生异常，使用兼容的旧式异常模型。
- pthreads 和默认 64 Worker 池：目标 WebView 无共享 Wasm 内存，产品构建必须禁用。
- 本地文件选择和桌面浏览器文件能力：目标第三方 WebView 不允许使用，改为管理员
  配置的服务端游戏库和 IndexedDB 下载。
- 依赖现代浏览器默认特性的构建输出：必须显式以 Chrome 89 实机门禁替代假设。

`VirtualLazyFS` 可以作为结构参考，但其底层等待机制不能原样成为产品文件桥。D1
必须独立验证 Asyncify + IndexedDB 的真实表现。

## 许可证结论

`krkr2` 和 `kirikiroid2-web` 的 README 将项目概括为 MIT，但两个仓库当前 `LICENSE`
文件的 SHA-256 相同，内容是 KRKR/KRKRZ 及多个第三方组件的复合许可证与版权声明，
不能在发布时简单写成“整个项目只有 MIT 许可证”。

因此，凡是导入这两个仓库的代码或资源，必须：

- 保留完整原始 `LICENSE` 内容及相关源码头部声明。
- 追踪具体导入文件来自哪个仓库和提交。
- 核对每个静态或动态链接依赖的许可证与归属要求。
- 在发布包和产品关于页面中提供适用声明。
- 不移除上游版权、作者或第三方组件告知。

`krkrsdl2` 根许可证明确为 MIT，但其 external 子模块仍有各自许可证，不能由根 MIT
替代。所有子模块都需要单独登记。

## D3 实际导入记录

D3 第三轮从 `krkr2` 固定提交 `dca7264572a63e753c1b07ca7053513d1751ce70`
导入 `cpp/core/base/KAGParser.cpp` 和 `cpp/core/base/KAGParser.h`，目标路径、提交和许可证
记录在 `engine/upstream.json`。`tools/build_d3.ps1` 只在忽略的构建目录中复制这些文件，
再应用 `engine/patches/0002-enable-kag-parser.patch`；完整 `krkr2` 源码不会因此进入本
项目版本库。

构建指纹包含两个导入文件及全部补丁的 SHA-256。D3 Web 构建同时附带
`licenses/KAGParser.LICENSE.txt` 和 `licenses/krkrsdl2.LICENSE.txt`。这满足当前开发
构建的来源追踪要求，但不替代公开发布前对实际进入最终产品的所有子模块逐项审计。

## 发布前必做审计

D0 可以开始技术开发，但在任何公开发布前必须完成：

1. 生成机器可读的依赖清单：名称、版本/提交、来源 URL、许可证、导入方式。
2. 对实际进入产物的源码、字体、音视频库、图像库和插件逐项核对。
3. 生成并人工复核 `THIRD_PARTY_NOTICES`。
4. 在源码包和 Web 发布物中放置要求保留的许可证文本。
5. 检查 Emscripten、SDL、FFmpeg（若启用）及编解码库的构建选项是否改变合规义务。
6. 确认《千恋万花》资源只用于本地开发验收，不进入版本库、构建物或公开服务。

本文是工程审计记录，不替代正式法律意见。若产品对公众分发或商业使用，应在发布
前由有资质人员复核最终依赖清单和实际发布物。
