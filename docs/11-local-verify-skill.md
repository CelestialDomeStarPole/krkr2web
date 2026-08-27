# 本机验证流程（桌面 Chrome 遥测回归）

> 本文件是 `~/.zcode/skills/krkr2web-local-verify/SKILL.md` 的仓库侧正本，
> 两者内容同步维护。目的：把本轮反复踩坑得来的验证方法论固化，后续验证
> 直接照单执行，不再试错。

## 适用场景

引擎补丁（engine/patches/NNNN）或 Web 侧（player/engine-worker）改动后的
本机回归；实机（TB-X802F）交付前的最后一道门。

## 环境事实（不要重新发现）

| 事项 | 结论 |
| --- | --- |
| 本地入口 | `https://127.0.0.1:8443`（游戏缓存按 origin 隔离，**禁止换端口**） |
| 实机入口 | `https://192.168.137.1:443`（热点网关 IP，需先开热点） |
| 审计 profile | `E:\krkr2-audit-profile`（Playwright persistent context） |
| 服务端重启时机 | 每次 `prepare_d5_product.ps1` 之后（resource-map 启动时一次性加载） |
| 8443 抢占 | `iphlpsvc` 的 svchost 以通配方式监听 0.0.0.0:8443 且会自动复活；提权 `sc stop iphlpsvc & sc config iphlpsvc start= disabled` + taskkill 后才稳定，收尾记得恢复 |
| 画面截屏 | WebGL 画布在合成器捕获下为黑色，CUA 截图/坐标点击均不可用于该页面 |

## 构建与部署循环

见 AGENTS.md 第一节与 tools/build_d3.ps1 / prepare_d5_product.ps1。
要点：动过 patch 集合后用 `-Clean`（指纹含每个 patch 的哈希），产物经
净导出树 + apply_patch 全量重放生成——这也是“新补丁能在干净树上应用”
的流水线级验证。

## 量化探针

- `tools/probe_local_exit.js`：多轮"启动→标题→BGM→退出→回库"，纯遥测。
  状态驱动：轮询 engineLog 等 `KRKR2WEB_LABEL *wait` + `title_cn.pimg`
  到齐才算到标题；点退出 (155,776) 后等 `dialog_cn.pimg` 出现再点
  是 (573,379)。`ROUNDS=N` 控制轮数。
- `tools/probe_boot_trace.js`：3 秒粒度打印启动日志尾部。

### 判读标记（KRKR2WEB_DIAG_*）

| 标记 | 含义 |
| --- | --- |
| `WAVE_DRAIN_STALL` | 排水看门狗触发：AL 队列计数停滞 >2s 强判自然结束（0094） |
| `WAVE_GHOST_STOP` | Status=play 但 SoundBuffer/Decoder 已空的幽灵态兜底（0094） |
| `BEAT_FLIP_STOP`+`SB_STATUS_ASYNC` | 正常播放结束路径的状态翻转 |
| `TICK_EXCEPTION` | 每 tick wasm 陷阱（实机专属风暴，本地应为 0） |

成功判定：`KRKR2WEB_ENGINE_QUIT` 出现且距点击 < ~1s。
BGM 存活代理：WebAudio start 计数增量（标题闲置 10s ≈150+ 为健康）。

## 已知残留

触点模拟偶发整轮丢失（20fps 帧门控与 tap 合成器交互），呈强交替性；
判读时以 DIAG 标记为准，不以此类超时下引擎结论。
