# 上游基线与许可证

## 固定基线

审计与开发以 2026-08-12 获取的以下提交为准：

| 仓库 | 分支 | 固定提交 | 主要用途 |
| --- | --- | --- | --- |
| `https://github.com/2468785842/krkr2` | `main` | `dca7264572a63e753c1b07ca7053513d1751ce70` | KRKR2/KRKRZ 衍生引擎、NCB 框架与插件实现来源 |
| `https://github.com/fenghengzhi/kirikiroid2-web` | `web` | `338d2029f16969b84becfd163c67f99740e28296` | Web 移植、GPU/RenderManager、motionplayer/psbfile 等插件、游戏兼容参考 |
| `https://github.com/krkrsdl2/krkrsdl2` | `main` | `3f384a6869f6726929c777bdd0e0c871d5d5383d` | 引擎运行时底座（本项目的构建主体） |

完整仓库与其声明的子模块缓存于 `参考资料/开源项目/`（Git 忽略，另含 csvParser
`7c757cf`、libwebp、wtnbgo 等按需克隆）。开发环境应保留上表，使另一台机器能复现
同一审计对象；机器可读的递归子模块 URL 与提交记录见
[upstream-lock.json](upstream-lock.json)。

## 导入机制

`engine/upstream.json` 是构建锁与来源登记的权威：

- `commit`：krkrsdl2 底座提交（导出后应用全部补丁）。
- `sourceImports`：从其他仓库按文件/目录导入的源码（KAGParser、NCBPlugins、
  csvParser、Kirikiroid2WebMotionRuntime 等），逐文件记录来源、目标、提交与
  许可证；构建时拷入并纳入指纹。
- `patches`：项目补丁清单，与 `engine/patches/` 磁盘文件一一对应（单测强制）。

构建产物附带 `licenses/<来源>.LICENSE.txt`，导入文件与补丁的 SHA-256 计入构建
指纹，来源可审计。

## 许可证结论

`krkr2` 与 `kirikiroid2-web` 的 README 将项目概括为 MIT，但两者当前 `LICENSE`
文件 SHA-256 相同，内容是 KRKR/KRKRZ 及多个第三方组件的复合许可证与版权声明，
**不能**在发布时简单写成"整个项目只有 MIT 许可证"。凡导入这两个仓库的代码或
资源，必须：

- 保留完整原始 LICENSE 内容及相关源码头部声明；
- 追踪具体导入文件来自哪个仓库和提交（sourceImports 机制）；
- 核对每个静态/动态链接依赖的许可证与归属要求；
- 在发布包和产品关于页面提供适用声明；
- 不移除上游版权、作者或第三方组件告知。

`krkrsdl2` 根许可证明确为 MIT，但其 external 子模块各有许可证，需单独登记。

## 发布前必做审计

在任何公开发布前必须完成：

1. 生成机器可读依赖清单：名称、版本/提交、来源 URL、许可证、导入方式。
2. 对实际进入产物的源码、字体、音视频库、图像库和插件逐项核对。
3. 生成并人工复核 `THIRD_PARTY_NOTICES`（仓库根已有
   [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)，发布时随发布物更新）。
4. 在源码包和 Web 发布物中放置要求保留的许可证文本。
5. 检查 Emscripten、SDL、FFmpeg（若启用）及编解码库的构建选项是否改变合规义务。
6. 确认《千恋万花》资源只用于本地开发验收，不进入版本库、构建物或公开服务。

本文是工程审计记录，不替代正式法律意见。若产品对公众分发或商业使用，发布前应
由有资质人员复核最终依赖清单和实际发布物。
