# paseo-pi-usage

在 Paseo 里看到 Pi 会话的累计 token 用量、花费和上下文占用，也就是 Pi TUI 状态栏（footer）那一行信息。Paseo 原生只在 agent 快照里暴露 `lastUsage`（单轮），所以整个会话的总量看不到。

## 展示形式

- **Composer pill**：每个 Pi agent 的输入框轨道栏上一个 pill（Gauge 图标），label 实时刷新为 `↑485k ↓113k 97%`，依次是输入、输出、全会话缓存命中率，有花费时在末尾追加。上下文占用不放 pill，在弹窗里看。
- **点击 pill 打开弹窗（popover）**：整个 token 视图以弹窗形式锚定在 pill 上，头部有刷新与「关闭」按钮。popover 是 SDK 里唯一自带 `close()` 的表面，所以关闭是真正的消失，点弹窗外部也会关。副标题显示会话标题，带「会话：」前缀。弹窗内为窄列布局：
  - 总 token、花费
  - 上下文进度条，>70% 黄、>90% 红，与 Pi 同阈值
  - token 明细：总 token 合计公式 = ↑输入+↓输出+R缓存读+W缓存写；输入、输出、缓存读、缓存写、思考；命中率·最近调用，命中率·全会话 ΣcacheRead/Σprompt
  - 会话信息：模型、thinking level、LLM 调用数、用户轮次、压缩次数、开始与最后活动时间、session id
  - 按模型拆分的 token 与花费
  - 最近 40 次 LLM 调用逐条明细，窄列下隐藏 R/ctx 列
  - session 文件路径与大小

## 数据来源

1. `paseo.agents.ref(agentId).refresh()` → `persistence.nativeHandle` 就是 Pi session JSONL 的绝对路径（Paseo 自己记录的），并顺带拿到 `lastUsage.contextWindowMaxTokens` 与模型。
2. 回退方案：按 Pi 的编码规则 `--<cwd 把 / \ : 换成 ->--` 在 `~/.pi/agent/sessions/`（或 `PI_CODING_AGENT_SESSION_DIR` / `PI_CODING_AGENT_DIR`）下按 `*_<sessionId>.jsonl` 查找。
3. 增量解析该 JSONL：只读上次之后新增的字节，按行聚合。

统计口径逐条对齐 Pi 自身实现（`core/usage-totals.js` + `modes/interactive/components/footer.js`）：

- 累计范围 = 所有 assistant 消息 + 带 usage 的 toolResult + `compaction` / `branch_summary` 条目。
- 上下文 token = `usage.totalTokens || input + output + cacheRead + cacheWrite`（Pi 的 `calculateContextTokens`）。
- 压缩之后、下一次有效 assistant usage 之前，上下文显示为 `?`（`contextStale`），与 Pi 一致。
- `aborted` / `error` / 全零 usage 的 assistant 消息不参与上下文推导，但计入累计总量。Pi 也是如此。
- 按模型拆分时 assistant 归到 `provider/model`，其余归到 `Tools/summaries`（Pi 的 `getUsageCostBreakdown`）。
- `formatTokens` 直接照搬 Pi footer 的分档：<1k 原样、<10k 一位小数 k、<1M 整数 k、<10M 一位小数 M、否则整数 M。

因为读的是 Pi 的 session 文件，**历史轮次也算在内**，包括插件安装之前的部分。

## 刷新策略

- pill：客户端每 2.5s 一次批量 RPC（`pi-usage.snapshot`，单批最多 40 个 agent）。运行中或 2 分钟内活跃过的 agent 每轮都刷新；安静的 agent 只在 Paseo 报告 status / lastActivityAt 变化时才重新读取，避免空转。
- 弹窗：运行中 2s、空闲 10s，另有「刷新」按钮。
- 服务端：`persistence` 解析结果缓存 120s，未找到 session 时只缓存 4s，因此新会话第一轮消息后就能显示。每个 session 文件只读增量，reader 数量上限 200（LRU），调用明细在内存中保留最近 400 条，累计总量不受影响。

## 开发与验证

```bash
npm install
npm run test        # vitest：解析器、resolver、格式化
npm run typecheck
paseo plugin install /absolute/path/to/paseo-pi-usage
paseo plugin ls     # 需要 running
paseo plugin logs paseo-pi-usage
paseo plugin reload paseo-pi-usage   # 改完源码后必须 reload，不要重启 daemon
```

已做过的验证：

- 用 Pi 自己的 `dist/core/usage-totals.js` 作为独立 oracle，对 5 个真实 session 文件逐字段比对 input / output / cacheRead / cacheWrite / cost，全部一致。最大的一个文件是 2.3MB、474 次调用、6160 万 token。
- 用真实的 Paseo agent 记录跑通 `resolve → 增量解析 → snapshot/calls` 全链路。
- 解析器单测覆盖：跨 refresh 不重复计数、半行（含 UTF-8 多字节被切断）缓冲、文件被截断后重置、坏行跳过、调用列表上限。

## 限制

- 只统计 `provider === "pi"` 的 agent。其它 provider 的 pill 不会出现，弹窗会说明原因。
- Pi 的 session 文件是追加写的树结构，本插件按文件线性顺序聚合，这与 Pi footer 的累计口径相同。会话被 rewind 或分叉后，分支上的重复条目会像 Pi 一样被一并计入。
- 花费不是本插件算的。Pi 在每次调用时按模型单价（input/output/cacheRead/cacheWrite 每百万 token，含 tiers）算出 `usage.cost` 写进会话 JSONL，我们只求和。单价来自 `~/.pi/agent/models-store.json`（provider 拉取），可在 `~/.pi/agent/models.json` 按模型覆盖。无单价的模型（订阅、分销渠道）cost 为 0，pill 不显示 `$`。
- 上下文窗口大小来自 Paseo 的 `lastUsage.contextWindowMaxTokens`，缺失时回退到 `providers.listModels`，两者都拿不到就显示 `?`。
