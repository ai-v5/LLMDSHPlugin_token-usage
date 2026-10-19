# Token Usage（LLMDSHPlugin / token-usage）

DeepSeek Harness (DSH) 插件：在桌面端/Web 端侧边栏左下角增加 **Token 统计**，按天汇总当前 profile 下所有 Session 的 token 用量。它是 [LLMDSHPlugin](../../README.md) 插件集合中的第一个插件。

## 功能

- 左下角 footer 常驻入口，显示今日 token 总量。
- 点击展开统计面板：第一行是**全部历史总量**，下面是 GitHub 风格的每日日历热力图；颜色深浅表示当天用量，鼠标悬停/键盘聚焦可看当天总量、输入+输出、缓存读写和会话数。
- 按 provider 上报的 usage 统计，包含 `inputTokens`、`outputTokens`、`cacheReadTokens`、`cacheWriteTokens`。
- 中文界面下大数字用「万 / 百万 / 千万 / 亿 / 万亿」显示，悬停明细同时保留精确数字。
- 日历显示最近 365 天；顶部总量覆盖全部历史。
- 统计全部历史的轮次、步骤和平均生成速度（tok/s）。
- 面板打开优先使用本地缓存；自动刷新最快 1 小时一次，手动刷新立即重新扫描。
- Host 把每个 Session 的日汇总持久化到 `~/.dsh/token-usage-ledger.json`；Session 归档或删除后历史仍然保留。
- 只读扫描 Session 历史，不修改任何 Session 或配置；fork 继承的事件不会重复计数。

## 安装

要求 DSH Desktop / Web 已安装，且 profile 中已启用 `@deepseek-ai/dsh-base`。

从本地目录安装到 Desktop profile：

```powershell
dsh plugin --profile desktop add D:\WORK\ai-v5\LLMDSHPlugin\plugins\token-usage
```

从 GitHub 安装时，先克隆仓库，再把插件子目录装进 profile：

```powershell
git clone https://github.com/ai-v5/LLMDSHPlugin.git
dsh plugin --profile desktop add .\LLMDSHPlugin\plugins\token-usage
```

安装后重启 DSH Desktop。插件会出现在左侧栏底部 Settings 上方（同一区域还有 Cordis 入口）。如果终端里没有 `dsh` 命令，可使用 DSH Desktop 安装目录下的 `resources\runtime\cli\bin\dsh.cmd`。

> 从旧版本升级：旧版把插件放在仓库根目录；拉取新版后，请重新执行上面的 `add` 命令并指向 `plugins\token-usage`，否则 profile 里的旧链接会失效。

卸载：

```powershell
dsh plugin --profile desktop remove llm-dsh-token-usage
```

## 统计口径

- 数据来自 DSH 的 `ctx.sessionQuery`：先 `listSessions()`，再读取每个 Session 的完整事件日志。
- 每个 `assistant/message` 或 `assistant/attempt` 的 provider usage 都会计入；同一 turn/step 的后续样本会替换前一样本，`llm/retry-started` 之后的 attempt 单独累计。
- `compaction/summary` 自带的 usage 也会计入（压缩调用不在 agent loop 的 step 内，日志里只有这一条记录）。
- 日期按 Host 本地时区划分。
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

`activity` 为全部历史汇总：`turns`/`steps` 来自 `turn/start`/`step/start`；`tokensPerSecond = timedOutputTokens / (generationMs / 1000)`，只统计带流式时间戳的 Assistant 调用。

Host 结果缓存 1 小时；`refresh=1` 跳过缓存并重新扫描。浏览器端在 `localStorage` 缓存最近一次成功结果：面板打开时优先显示缓存，缓存不足 1 小时不发请求，超过 1 小时才后台刷新；手动刷新不受此限制。

## 已知限制

- AI 会话标题（session title）等辅助调用不写入 Session 日志，因此不会计入；如果部署把这些调用计费，面板总量会略低于账单。
- 读取失败的 Session 会被跳过，面板会显示 `skippedSessions` 提示。
- 统计是 provider 上报 usage 的汇总，不是计费账单；不同 provider 对缓存读/写的上报口径可能不同。
- 首次打开或手动刷新需要扫描全部 Session 日志，Session 很多时会有短暂延迟；之后 1 小时内优先使用浏览器和 Host 缓存。
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
