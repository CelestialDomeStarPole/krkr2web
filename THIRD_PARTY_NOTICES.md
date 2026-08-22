# 第三方组件与许可证声明（THIRD_PARTY_NOTICES）

本仓库与构建产物中使用的第三方组件及其许可证。完整许可证原文位于各上游仓库
（锁定提交见 `docs/upstream-lock.json` 与 `engine/upstream.json`），并在构建时
复制到产物 `licenses/` 目录。**审计结论（2026-08-22）：全部为宽松许可证
（MIT / BSD / zlib / FTL / IJG / CxImage / KIRIKIRI），未发现任何 GPL、LGPL、
AGPL 或其他传染性（copyleft）组件。** 义务类型均为"保留版权与许可声明"。

## 随源码提交进入本仓库的组件

| 组件 | 本仓库位置 | 许可证 | 要求 |
| --- | --- | --- | --- |
| layerExImage（含 CxImage 派生代码） | `engine/plugins/layerExImage/` | CxImage 7.0.2（Davide Pizzolato，宽松自定义） | 保留版权声明（已内嵌于 `Main.cpp`）；修改版本须标明已改动；不得冒称原始软件 |

## 构建基座（本仓库持有补丁，源码不提交）

| 组件 | 进入方式 | 许可证 |
| --- | --- | --- |
| krkrsdl2 | 构建时导出锁定提交，应用 `engine/patches/` 全部补丁 | MIT（Kirikiri SDL2 Developers） |

补丁文件本身为项目原创（MIT），但针对 krkrsdl2（MIT）源码；分发补丁或构建产物
时须一并保留 krkrsdl2 的版权与许可声明。

## 构建时按 `engine/upstream.json` sourceImports 导入的组件（源码不提交）

| 组件 | 来源仓库 | 导入内容 | 许可证 |
| --- | --- | --- | --- |
| KAGParser | `2468785842/krkr2` | KAG 解析器（2 文件） | KIRIKIRI/KIRIKIRI Z 复合许可证（见下） |
| NCB 框架与 fstat/getSample/scriptsEx/windowEx 等插件 | `2468785842/krkr2` | ncbind 框架与插件源码 | 同上 |
| csvParser | `wtnbgo/csvParser` | CSV 解析插件 | 按 README 遵循吉里吉里本体许可证（KIRIKIRI/KIRIKIRI Z） |
| motionplayer / psbfile 运行时 | `fenghengzhi/kirikiroid2-web` | Emote 动画与 PSB 图像插件、RenderManager ABI、imagepacker 等 | KIRIKIRI/KIRIKIRI Z 复合许可证（krkr2 与 kirikiroid2-web 的 LICENSE 文件逐字节一致） |
| layerExRaster / layerExBTOA / PackinOne | `fenghengzhi/kirikiroid2-web` | 构建时直接拷贝的插件源码 | 同上 |
| libwebp（decode 子集） | `webmproject/libwebp`（本地缓存 `参考资料/开源项目/libwebp`） | WebP 解码 | BSD-3-Clause（Google Inc.） |

## 仅作参考、未进入构建的仓库

| 仓库 | 用途 | 许可证 |
| --- | --- | --- |
| `wtnbgo/KAGParserEx` | kag.setMessageHook 未来移植参考 | 按 README 遵循吉里吉里本体许可证 |
| `wtnbgo/layerExImage` | engine/plugins/layerExImage 的上游 | CxImage（见上表） |

## KIRIKIRI / KIRIKIRI Z 复合许可证要点

krkr2 与 kirikiroid2-web 的 LICENSE（内容一致，共 892 行）由以下部分组成，
全部为宽松条款，无 copyleft：

- KIRIKIRI / KIRIKIRI Z / KRKR2 引擎本体（W.Dee 及贡献者）：以源码或二进制
  再发布时须保留版权表、条件与免责声明；未经书面许可不得以贡献者或组织名义
  宣传派生产品。
- libjpeg-turbo（IJG/BSD 式）、libpng（libpng 许可证）、zlib（zlib 许可证）、
  Oniguruma（BSD）、FreeType（FTL）、picojson（MIT 变体）。

完整原文以上游仓库锁定提交为准；发布构建产物时由 `tools/build_d3.ps1` 自动
复制到 `licenses/`。

## 游戏资源声明

本项目不包含、不分发、不授权任何商业游戏资源（《千恋万花》等仅用于本地开发
验收，位于 Git 忽略的 `参考资料/`）。游戏目录、清单与转码视频由部署者自行
提供并负责授权。

---

本文为工程审计记录，不构成法律意见。`docs/08-upstream-licensing.md` 记录了
审计方法与发布前检查清单。
