# Pi Usage (paseo-pi-usage)

**English** | [简体中文](README.zh-CN.md)

A Paseo plugin that shows how many tokens a Pi session has used and what it has cost, right above the prompt box. Click it to see what is filling the context window. It brings the status line at the bottom of the Pi terminal UI into Paseo.

![Pi usage popover, sample session](docs/screenshots/usage-popover.png)

The screenshot comes from a sample project session and contains no real data.

## Usage

**Pill above the prompt box**: every Pi agent gets a small pill, for example `1.7M · $0.061`, showing the session's total tokens and cost. It updates live. Hover to see the input / output / cache-read breakdown and the cache hit rate.

**Popover** (a bottom sheet on narrow screens), top to bottom:

- Session title, model and thinking level, with a refresh button at the top right.
- Context: used / window size and percentage, with a colored bar split by category. Below it, the size of each category: messages, tool calls (with the heaviest tools), thinking, MCP tools, system tools, skills, project instructions and the system prompt. Then a small chart of the context size over the last 40 calls, which shows when compaction happened.
- Three key numbers: cost, total tokens (with call and turn counts) and cache hit rate.
- Current turn: input, output, cache read, call count and cost since the latest user message.
- Expandable: token details, a per-model breakdown (shown when more than one model was used) and a call-by-call list of recent calls.
- Footer: the session file path and size.

## Where the numbers come from

- The plugin reads Pi's own session files (JSONL under `~/.pi/agent/sessions/`), so history from before the plugin was installed is counted too. Only newly appended data is parsed, never the whole file again.
- Totals follow the same rules as the Pi status line: every model call, every tool result that carries usage, and compaction and branch summaries are included. Between a compaction and the next call the context shows `?`, same as Pi.
- **Cost**: relay and subscription providers often write a cost of 0 into the session file. The plugin ships a table of official API prices (`shared/pricing.ts`). If the model is in the table, the cost is estimated from official prices; otherwise the value recorded by Pi is used. The pill and the popover use the same rule. The estimate ignores tiered pricing and discounts, so it can differ from your real bill.
- **Context breakdown**: since Pi 1.2 the system prompt and tool declarations are written into the session file. The plugin estimates each category from them (characters / 4, and one token per CJK character), then calibrates against the real usage of the latest request. Sessions from before Pi 1.2 only show the total bar, without a breakdown.

## Limitations

- Only agents whose provider is `pi` are counted.
- If a session is rewound or forked, duplicated records on the branch are counted, as in Pi.
- The price table is static. After a vendor changes prices, edit `shared/pricing.ts` by hand. Models not in the table are estimated at $0, and the popover says so.
- The context window size comes from the value Paseo recorded. If that is missing, the plugin reads Pi's model config, and shows `?` if that is missing too.

## Development

```bash
npm install
npm run test
npm run typecheck
paseo plugin install /absolute/path/to/paseo-pi-usage
paseo plugin ls
```

After editing the source, run the tests and the type check, then `paseo plugin reload paseo-pi-usage`. No daemon restart is needed. If something goes wrong, check `paseo plugin logs paseo-pi-usage`.

```text
client/pills.ts          Prompt-box pill: batch refresh every 2.5 s, idle agents re-read only on state change
client/panel.tsx         Popover
server/usageService.ts   Locates the session file, builds the summary snapshot and popover data
server/sessionFile.ts    Incremental parsing of the session JSONL
server/contextLedger.ts  Replays the system prompt and tool declarations to estimate the context breakdown
server/resolve.ts        Finds the session file and context window from Paseo's agent record
shared/pricing.ts        Official price table
shared/format.ts         Number and cost formatting
```
