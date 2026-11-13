# Token Usage（LLMDSHPlugin_token-usage）

DeepSeek Harness (DSH) 插件：在桌面端/Web 端侧边栏左下角增加 **Token 统计**。所有统计只读本机 Session 日志，不访问外部服务、不上传数据；除了历史总量和每日热力图，还能看到输入+输出、缓存读写、轮次/步骤和平均 tok/s，会话归档或删除后历史仍然保留。

> 仅本地 · 只读 · 不上传 · 不挑后端。

## 关于“网络”能力标签

插件市场会把带前端界面的插件扫出 `network` 标签。本插件的 `network` 只来自浏览器端的一次同源请求：

```text
GET /api/llm-token-usage/stats
```

目标是**本机 DSH Host 自己注册的路由**，读取本机 Session 日志；不访问任何外部域名，不上传任何数据，不含遥测、统计或授权检查。Host 端的 `fs-read` 用于读 Session 日志，`fs-write` 只写 `~/.dsh/token-usage-ledger.json` 这一个文件。

## 亮点

- **仅本地，安全**：只读本机 Session 日志，不访问外部服务、不上传任何数据，也不修改 Session 或配置。
- **按实际用量**：按 provider 上报的 usage 统计，不做字符数估算。
- **不挑后端**：DeepSeek、GLM、Kimi 等只要在 Session 中留下 provider usage，就统一计入，不绑定单一模型或供应商。
- **安全可靠**：账本用临时文件 + 原子替换写入，文件损坏时保留 `.corrupt-*` 备份。
- **一眼看全**：左下角常驻今日用量；面板第一行是全部历史总量，下面是 365 天 GitHub 风格热力图。
- **明细够用**：每天可看总量、输入+输出、缓存读取、缓存写入和会话数。
- **不只 token**：全部历史的轮次、步骤和平均生成速度（tok/s）。
- **删了也不丢**：Host 把每个 Session 的日汇总持久化到 `~/.dsh/token-usage-ledger.json`，Session 归档或删除后历史仍然保留。
- **自动跟随**：先用上次结果秒开，页面可见时每 60 秒自动重读一次（只重扫变化过的会话），手动刷新立即重新扫描；面板会显示「更新于 HH:MM」。
- **增量刷新**：按 Session 日志的文件大小和修改时间判断变化，只重读变化或新增的 Session；包括其他 DSH 宿主写入的会话。
- **不会饿死老会话**：读取顺序是「正在使用的 → 15 分钟内还在写的（最新优先）→ 其余积压（最旧优先，先进先出）」；积压按固定顺序推进，新会话只会排到队尾，所以旧会话不会被一直挤在后面。
- **自动补齐**：一次扫描读不完时，后台按 2 秒间隔继续扫描（最多 40 轮），不需要反复刷新；单个会话读失败或超时会先跳过 10 分钟，不再反复占用读线程。
- **大日志给足时间**：单会话读超时按日志体积放大（15 秒基线 + 0.5 秒/MB，上限 60 秒），16MB 这类大日志不会被固定超时裁掉。
- **纯只读**：不修改任何 Session 或配置；fork 继承的事件不会重复计数。

## 关键指标

- 按 provider 上报的 usage 统计，包含 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`。
- 不区分 provider：所有在 Session 中记录 usage 的模型/后端统一汇总。
- 中文界面下大数字用「万 / 百万 / 千万 / 亿 / 万亿」显示，悬停明细同时保留精确数字。
- 日历显示最近 365 天；顶部总量覆盖全部历史。

## 安装

要求 DSH Desktop / Web 已安装，且 profile 中已启用 `@deepseek-ai/dsh-base`。

从本地目录安装到 Desktop profile：

```powershell
dsh plugin --profile desktop add D:\WORK\ai-v5\LLMDSHPlugin_token-usage
```

或直接从 GitHub 安装：

```powershell
dsh plugin --profile desktop add github:ai-v5/LLMDSHPlugin_token-usage
```

从 npm 安装：

```powershell
dsh plugin --profile desktop add llm-dsh-token-usage
```

安装后重启 DSH Desktop。插件会出现在左侧栏底部 Settings 上方（同一区域还有 Cordis 入口）。如果终端里没有 `dsh` 命令，可使用 DSH Desktop 安装目录下的 `resources\runtime\cli\bin\dsh.cmd`。

> 从旧的 LLMDSHPlugin monorepo 迁移：重新执行上面的 `add` 命令指向本仓库，旧的 `plugins\token-usage` 链接会失效。

卸载：

```powershell
dsh plugin --profile desktop remove llm-dsh-token-usage
```

## 统计口径

- 数据来自 DSH 的 `ctx.sessionQuery`：先 `listSessions()`，再读取每个 Session 的完整事件日志。
- 每个 `assistant/message` 或 `assistant/attempt` 的 provider usage 都会计入；同一 turn/step 的后续样本会替换前一样本，`llm/retry-started` 之后的 attempt 单独累计。
- `compaction/summary` 自带的 usage 也会计入（压缩调用不在 agent loop 的 step 内，日志里只有这一条记录）。
- 日期按 Host 本地时区划分。
- 增量依据 `<DSH home>/sessions` 下会话日志的大小与修改时间：变化或新增的 Session 重新读取，其余直接复用账本；读不到该目录时退回按 `live` 判断。
- `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`，其中包含 prompt cache 命中读取；面板同时展示不含 cache read 的 `inputOutputTokens`。
- 子 Session 与父 Session 都是独立 Session，会各自计入；fork 继承的前缀通过 `inheritedEventCount` 排除。

## 接口

Host 端注册只读路由：

```
GET /api/llm-token-usage/stats?range=all&refresh=1
```

也兼容 `?days=7|14|30|90` 的有界范围。返回：

```json
{
  "generatedAt": 1760000000000,
  "days": 366,
  "rangeKind": "all",
  "seriesTruncated": false,
  "range": { "from": "2025-10-19", "to": "2026-10-18" },
  "today": { "date": "2026-10-18", "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "totalTokens": 0, "inputOutputTokens": 0, "sessions": 0 },
  "totals": { "...": "same shape as today" },
  "allTime": { "...": "same shape as today" },
  "series": [{ "date": "2025-10-19", "...": "same shape as today" }],
  "sessionCount": 0,
  "skippedSessions": 0,
  "pendingSessions": 0,
  "staleSessions": 0,
  "refreshed": 0,
  "incomplete": false,
  "activity": {
    "turns": 0,
    "steps": 0,
    "generationMs": 0,
    "timedOutputTokens": 0,
    "tokensPerSecond": 0
  }
}
```

`activity` 为全部历史汇总：`turns`/`steps` 来自 `turn/start`/`step/start`；`tokensPerSecond = timedOutputTokens / (generationMs / 1000)`，只统计带流式时间戳的 Assistant 调用。`skippedSessions` 是读取失败的会话数，`pendingSessions` 是这次扫描超时后还没轮到的会话数（后台会接着补，不需要守着刷新），`staleSessions` 是日志已经变了但这次没能重读成功、只能沿用旧数字的会话数，`refreshed` 是这次真正重读的会话数。

Host 结果缓存 60 秒（缓存命中也只复用扫描结果，变化过的会话在下一轮重读）；`refresh=1` 跳过缓存并重新扫描。浏览器端在 `localStorage` 缓存最近一次成功结果，只用于首屏秒开：页面可见时每 60 秒轮询一次，页面从隐藏切回、窗口重新聚焦时立刻重读；手动刷新立即生效。

扫描因 45 秒预算被截断时，Host 会在后台连续跑后续几轮（每轮之间留 2 秒，一次刷新最多 40 轮）；只要还有排队会话就继续，不拿「队列是否变短」当判据——忙碌时新增会话会让队列长度反复持平，用长度比较会把补齐链提前掐断。任何一轮失败会记日志并重试，不会静默中断；扫描本身不随浏览器请求取消，关掉面板也会把这一轮读完。每轮最多同时读 4 个会话，所以同一个预算能推进的会话数约为串行时的 4 倍。期间读到的还是上一轮完整结果。

## 已知限制

- AI 会话标题（session title）等辅助调用不写入 Session 日志，因此不会计入；如果部署把这些调用计费，面板总量会略低于账单。
- 读取失败的 Session 会被跳过，面板会显示 `skippedSessions` 提示；扫描超时剩下的会话显示 `pendingSessions` 数量，后台补齐完成后下次刷新即归零；日志已更新但还没重读成功的会话显示 `staleSessions`，提示「数字稍后自动修正」。
- 统计是 provider 上报 usage 的汇总，不是计费账单；不同 provider 对缓存读/写的上报口径可能不同。
- 会话很多、日志很大时，一次扫描（45 秒预算）可能读不完所有变化的 Session；顺序是「正在使用的 → 最近 15 分钟变过的 → 其余按最旧优先」，历史会话在后续轮次里按期补齐。
- 单个 Session 读取超过「15 秒 + 0.5 秒/MB」（上限 60 秒），或整次扫描超过 45 秒，会跳过该部分并标记统计可能不完整，避免面板永久卡在刷新中；读失败的会话 10 分钟内不再重试，避免一个大日志反复堵住队列。
- 插件首次成功扫描前就已经删除的 Session 无法追溯；删除 `~/.dsh/token-usage-ledger.json` 会重置历史汇总。

## 开发

```powershell
node --test tests/stats.test.mjs
node --check lib/stats.js
node --check index.js
node --check client.js
```

项目本身不需要构建：`index.js` 是 Host 半部，`client.js` 是浏览器半部，`locale/*.json` 提供插件管理页显示名称。

## 参考

设计上参考了 MIT 许可的 [HaoyueQin/dsh-usage-statistics-panel](https://github.com/HaoyueQin/dsh-usage-statistics-panel) 的按天口径与 footer 面板布局；本仓库代码是独立实现，没有复制其源码。

## License

MIT
