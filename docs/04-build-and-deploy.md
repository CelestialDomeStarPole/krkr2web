# 构建与部署

## 主机环境

Windows 原生构建（不要求 WSL）。基础工具：Git、Python 3、Node.js（前端冒烟用
playwright-core）、emsdk/Emscripten。工具链锁定：

- Emscripten **3.1.64**（`.toolchains/emsdk`，emsdk 提交记录在
  `toolchains/d0-toolchain.lock.json`；随 emsdk 附带 Node 18.20.3，构建脚本
  直接使用其 node.exe 做语法门禁）。
- 引擎上游提交、导入文件与补丁清单锁定在 `engine/upstream.json`
  （详见 [08-上游基线](08-upstream-licensing.md)）。
- 完整引擎源码检出位于 `参考资料/开源项目/`（Git 忽略）；缺失时先按 08 号文档
  克隆并 checkout 到锁定提交。

## 引擎构建

```powershell
.\tools\build_d3.ps1 [-Clean]
```

流程：从锁定提交导出 krkrsdl2 源码到 `build/d3-engine-work/source`（Python
`tools/extract_tar.py` 提取，symlink 物化为文本）→ 按序应用
`engine/upstream.json` 列出的全部补丁（`tools/apply_patch.py`，**禁止 git
apply**，见排障手册）→ 拷贝 `engine/plugins/` 项目自有插件与 sourceImports
导入文件 → CMake + Ninja（emsdk 工具链）→ `check_worker_contract.py` 验证
Worker 契约 → 产出 `build/d3-engine/`（探针页 + krkrsdl2.js/.wasm + licenses）。

**构建树语义**：指纹 = upstream.json 的 commit + 每个补丁哈希 + sourceImport
文件哈希；指纹变化即整树重导。对引擎源码的任何修改必须固化为
`engine/patches/NNNN-*.patch` 并登记 `engine/upstream.json`（编号递增，退役
补丁连同文件一起删除——单测强制两侧一致）。`engine/plugins/`、`engine/web/`
下的项目自有源码构建时拷入，可直接编辑。

增量编译（改过构建树源文件后）：

```powershell
& '.toolchains/d3-build-tools/Scripts/cmake.exe' --build 'build/d3-engine-work/cmake' --target krkrsdl2 --parallel
```

## 游戏数据与产品构建

```powershell
.\tools\prepare_d2_probe.ps1      # 首次：扫描 XP3 生成 catalog/manifest/哈希（build/d2-*）
.\tools\prepare_d5_product.ps1    # 组装产品静态站（可 -SkipEngineBuild 复用引擎产物）
```

`prepare_d2_probe.ps1` 顺序读取三个 XP3 计算整文件与分块 SHA-256（不复制资源），
结果缓存在 `build/d2-metadata`，源文件 mtime 不变即复用（怀疑被改用 `-Force`）。
`resource-map.json` 把 `/games/...` URL 映射到 `参考资料/` 下的原文件，由服务器
按需供给 Range 响应。

`prepare_d5_product.ps1` 组装 `build/d5-product`：

1. staging 目录构建，校验（`check_d4_artifacts.py` 含 node 语法门禁、
   `check_d5_artifacts.py`）全部通过后两次 rename 原子换入——避免重建窗口内
   线上服务器 404（曾导致实机"无样式页面"）。
2. 从 `engine/profiles/` 生成 `engine-profiles.js`，为游戏补 catalog 描述与
   封面。
3. `stamp_build_versions.py` 给静态资源引用加内容哈希 `?v=`，并生成
   `/engine-manifest.json`（js/wasm 字节数 + SHA-256 + 联合 build id）与页面
   build meta——旧缓存页面 + 新 wasm 混搭会零输出死亡，这是自愈防线
   （见排障手册）。注意 stamp 会改写一切 URL 形态字符串，代码里按 URL 查找
   manifest 键必须用后缀匹配。

## 部署与服务器

```powershell
.\tools\start_d5_product.ps1 [-SkipBuild] [-Http]
# 默认监听 0.0.0.0:443，测试域名用 -HostName 指定；首次自动生成开发证书
```

服务器 `tools/https_diagnostics_server.py` 要点：

- `--directory` 静态站、`--resource-map` XP3 按需供给、`--video-directory`
  预转码视频挂 `/videos/`、`--savedata-directory` 通关存档导入源、
  `--reports-directory` 诊断报告落盘（`POST /api/diagnostics-reports`）。
- HTTP/1.1 + keep-alive（所有响应带精确 Content-Length），handler 超时 60 s。
- 缓存策略：带内容哈希 `?v=` 的资源 `Cache-Control: public, max-age=31536000,
  immutable`；HTML、catalog、XP3、视频 `no-cache`。
- 深层页面路径 404 时 302 回根页面；静态资源 404 如实返回。
- COOP/COEP 响应头保留（利在现代浏览器对照）。

### 实机访问（DNS 劫持 + 证书）

1. 开发电脑开热点，Android 设备连接。
2. 把自己的测试域名（如 `game.example.com`，经 `-HostName` 传给脚本）解析到
   电脑热点 IP。
3. 安装 `certs/krkr2-dev-ca.crt` 到设备受信任凭据；Android 7+ 第三方 App 可选择
   不信任用户 CA，若报证书错误需改用受系统信任的真实域名证书。私钥绝不提交、
   不外发。
4. 防火墙放行 443，在第三方 App 的 WebView 中打开 `https://<域名>/`。

免 DNS 劫持的快捷方式：直接以热点网关 IP 起服务（Windows 移动热点固定为
`192.168.137.1`），设备访问 `https://192.168.137.1/` 并接受自签证书警告即可；
完整命令与注意事项（含 resource-map 重启要求）见根目录
[AGENTS.md](../AGENTS.md)。本仓库约定的实机验证入口即为此地址。

### 引擎升级纪律

- 任何更换 Emscripten、上游提交或补丁的改动都必须重跑目标实机门禁
  （见 [验证记录](09-verification-log.md)）。
- 引擎更新部署后，实机端旧缓存页面会在下次打开时经 build meta 比对自动
  reload 自愈；**无自检代码的更旧页面需要完全关闭游戏页面重开一次**。

## 测试与 CI

```powershell
python -m unittest discover -s tests -p "test_*.py"   # 34 项单测
node tests\d4_browser_smoke.js ...                     # 产品壳浏览器冒烟（需本地服务）
```

- 单测覆盖补丁锁一致性、构建脚本、catalog/manifest 工具、服务器行为、引擎
  profile 与 Worker 契约。
- GitHub Actions（`.github/workflows/`，windows-latest + Python 3.12 + Node）
  按 path 触发复核 d0/d1/d2 工具与产物检查。
- 浏览器冒烟：D3（引擎闭环/增强输入/稳定性，缩短参数）、D4（产品壳安装、断网
  零请求启动、存档管理、崩溃恢复）。桌面结论只作辅助，目标设备结论以实机为准。
