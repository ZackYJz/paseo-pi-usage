import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { contextLevel, displayCost, formatCost, formatPercent, formatTokens, sessionCacheHitRate, type ContextLevel } from "../shared/format";
import type { CallUsage, ContextBreakdown, ContextCategory, ModelUsage, TurnUsage, UsageSnapshot } from "../shared/usage";
import { piUsageDetailRpc } from "../shared/usage";

const CALL_LIMIT = 40;

type ThemeColors = PluginHostProps["theme"]["colors"];
type Styles = ReturnType<typeof createStyles>;

function groupDigits(value: number): string {
  const text = String(Math.round(value));
  const negative = text.startsWith("-");
  const digits = (negative ? text.slice(1) : text).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${digits}` : digits;
}

/** HH:MM today, MM-DD HH:MM otherwise; seconds add nothing at this zoom level. */
function formatTime(value: string | number | null | undefined, now = Date.now()): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return new Date(now).toDateString() === date.toDateString() ? time : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `rh/deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`, with the channel kept separately. */
function splitModel(model: string | null): { name: string; channel: string | null } {
  if (!model) return { name: "—", channel: null };
  const parts = model.split("/");
  return { name: parts[parts.length - 1] || model, channel: parts.length > 1 ? parts[0]! : null };
}

/**
 * The plugin SDK exposes theme colors but no light/dark flag. The popover host
 * already paints its own surface, so our extra `surface0` layer only shows up
 * as a visible inset rectangle on dark themes; drop it there by luminance.
 */
function isDarkColor(color: string): boolean {
  let hex = color.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.split("").map((ch) => ch + ch).join("");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return false;
  const value = Number.parseInt(hex, 16);
  return 0.299 * ((value >> 16) & 0xff) + 0.587 * ((value >> 8) & 0xff) + 0.114 * (value & 0xff) < 128;
}

function levelColor(level: ContextLevel, colors: ThemeColors): string {
  return level === "danger" ? colors.statusDanger : level === "warn" ? colors.statusWarning : colors.accent;
}

/** Mid-saturation hues that read on both light and dark surfaces; the theme has no categorical palette. */
const CATEGORY_STYLE: Record<ContextCategory, { label: string; color: string; unit?: string }> = {
  messages: { label: "消息", color: "#4F86F7" },
  toolCalls: { label: "工具调用", color: "#9B6BDF" },
  thinking: { label: "思考", color: "#D9679A" },
  mcp: { label: "MCP 工具", color: "#E8743B", unit: "个" },
  systemTools: { label: "系统工具", color: "#3FA672", unit: "个" },
  skills: { label: "Skills", color: "#E3A72F", unit: "个" },
  projectContext: { label: "项目指令", color: "#2EA8B8", unit: "个文件" },
  systemPrompt: { label: "系统提示词", color: "#8C8C8C" },
};

/** Survives popover re-opens within the app session, like a disclosure the user left open. */
let compositionOpen = true;

/**
 * Composer-pill popover. The host closes it on an outside tap (and as a bottom
 * sheet on compact layouts), so there is no close button; `close` stays unused.
 */
export function PiUsagePopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") {
    return <Text style={{ color: props.theme.colors.foregroundMuted }}>该表面只服务于 agent 上下文。</Text>;
  }
  return <UsageView theme={props.theme} layout={props.layout} agentId={props.agentId} />;
}

function UsageView({ theme, layout, agentId }: { theme: PluginHostProps["theme"]; layout: PluginHostProps["layout"]; agentId: string }) {
  const colors = theme.colors;
  const compact = layout.compact;
  const detailRpc = useRpc(piUsageDetailRpc);
  const agent = useAgent(agentId, ({ status, title }) => ({ status, title }));
  const styles = useMemo(() => createStyles(colors, compact), [colors, compact]);
  const running = agent?.status === "running";

  const query = useQuery({
    queryKey: ["pi-usage", "detail", agentId, CALL_LIMIT],
    queryFn: () => detailRpc({ agentId, callLimit: CALL_LIMIT }),
    refetchInterval: running ? 2000 : 10_000,
    staleTime: 1000,
  });
  const detail = query.data ?? null;
  const snapshot = detail?.snapshot ?? null;
  const model = splitModel(snapshot?.model ?? null);
  const meta = [model.name, snapshot?.thinkingLevel ? `thinking ${snapshot.thinkingLevel}` : null, running ? "运行中" : null].filter(Boolean).join(" · ");

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title} numberOfLines={1}>{agent?.title || "Pi 用量"}</Text>
            {snapshot?.status === "ok" ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="立即刷新" hitSlop={6} disabled={query.isFetching}
            onPress={() => void query.refetch()}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.iconButton,
              (pressed || hovered) && { backgroundColor: colors.surface2 }, { opacity: query.isFetching ? 0.5 : 1, transform: [{ scale: pressed ? 0.9 : 1 }] }]}>
            <Icon name="RefreshCw" size={14} color={colors.foregroundMuted} />
          </Pressable>
        </View>

        {snapshot === null ? (
          <Text style={[styles.note, query.isError && { color: colors.statusDanger }]}>
            {query.isError ? `读取失败：${describe(query.error)}` : "正在读取 Pi 会话…"}
          </Text>
        ) : snapshot.status !== "ok" ? (
          <StatusNote snapshot={snapshot} styles={styles} colors={colors} />
        ) : (
          <>
            <ContextBlock snapshot={snapshot} calls={detail!.calls} composition={detail!.context ?? null} styles={styles} colors={colors} />
            <KeyFigures snapshot={snapshot} styles={styles} />
            {detail!.lastTurn ? <TurnRow turn={detail!.lastTurn} running={running} styles={styles} colors={colors} /> : null}
            <View style={styles.disclosures}>
              <Disclosure title="Token 明细" summary={formatTokens(snapshot.totalTokens)} styles={styles} colors={colors}>
                <Breakdown snapshot={snapshot} styles={styles} />
              </Disclosure>
              {detail!.perModel.length > 1 ? (
                <Disclosure title="按模型" summary={`${detail!.perModel.length} 个`} styles={styles} colors={colors}>
                  <PerModel items={detail!.perModel} styles={styles} />
                </Disclosure>
              ) : null}
              <Disclosure title="最近调用" summary={`${Math.min(detail!.calls.length, CALL_LIMIT)} 次`} styles={styles} colors={colors}>
                <Calls calls={detail!.calls} truncated={detail!.truncated} styles={styles} colors={colors} />
              </Disclosure>
            </View>
            <View>
              <Text selectable style={styles.footer} numberOfLines={1} ellipsizeMode="middle">{snapshot.sessionFile ?? ""}</Text>
              <Text style={styles.footer}>{`${formatBytes(snapshot.fileBytes)} · ${formatTime(query.dataUpdatedAt)} 更新`}</Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function StatusNote({ snapshot, styles, colors }: { snapshot: UsageSnapshot; styles: Styles; colors: ThemeColors }) {
  if (snapshot.status === "not_pi") {
    return <Text style={styles.note}>{`这个 agent 用的是 ${snapshot.provider ?? "其他"} provider，本插件只统计 Pi 会话。`}</Text>;
  }
  if (snapshot.status === "no_session") {
    return <Text style={styles.note}>Pi 会话文件还没生成。发出第一条消息后，这里会显示整个会话的累计用量。</Text>;
  }
  return <Text style={[styles.note, { color: colors.statusDanger }]}>{`读取失败：${snapshot.error ?? "未知错误"}`}</Text>;
}

/**
 * Context gauge, its composition (Claude-desktop style: a stacked bar plus one
 * row per category) and a sparkline of context size per call.
 */
function ContextBlock({ snapshot, calls, composition, styles, colors }: {
  snapshot: UsageSnapshot; calls: CallUsage[]; composition: ContextBreakdown | null; styles: Styles; colors: ThemeColors;
}) {
  const [open, setOpen] = useState(compositionOpen);
  const percent = snapshot.contextStale ? null : snapshot.contextPercent;
  const level = contextLevel(percent);
  const color = levelColor(level, colors);
  const window = snapshot.contextWindowTokens;
  const used = snapshot.contextStale ? "压缩后待更新" : `${formatTokens(snapshot.contextUsedTokens)}${window ? ` / ${formatTokens(window)}` : ""}`;
  const series = [...calls].reverse();
  // 进度条已经给出占窗口的绝对比例；迷你图按这批调用里的最大值缩放，只负责看出走势和压缩。
  const scale = Math.max(1, ...series.map((call) => call.contextTokens));
  const parts = composition ? composition.categories.filter((category) => category.tokens > 0) : [];
  // Shares are of the window when known, like the gauge; otherwise of the context itself.
  const denominator = window && window > 0 ? window : Math.max(1, composition?.total ?? 0);
  const toggle = () => {
    compositionOpen = !open;
    setOpen(compositionOpen);
  };
  const head = (
    <>
      <Text style={styles.label}>上下文</Text>
      {parts.length > 0 ? <Icon name={open ? "ChevronDown" : "ChevronRight"} size={12} color={colors.foregroundMuted} /> : null}
      <Text style={styles.contextUsed}>{used}</Text>
      <Text style={[styles.contextPercent, level !== "ok" && level !== "unknown" && { color }]}>
        {percent === null ? "—" : `${formatPercent(percent)}%`}
      </Text>
    </>
  );
  return (
    <View style={styles.contextBlock}>
      {parts.length > 0 ? (
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? "收起" : "展开"}上下文构成`}
          onPress={toggle} style={styles.contextHead}>
          {head}
        </Pressable>
      ) : (
        <View style={styles.contextHead}>{head}</View>
      )}
      <View style={[styles.barTrack, parts.length > 0 && styles.barStacked]}>
        {parts.length > 0 ? (
          parts.map((category) => (
            <View key={category.key} style={{ width: `${Math.min(100, (category.tokens / denominator) * 100)}%`, minWidth: 2,
              backgroundColor: CATEGORY_STYLE[category.key].color }} />
          ))
        ) : (
          <View style={[styles.barFill, { width: `${Math.max(0, Math.min(100, percent ?? 0))}%`, backgroundColor: color }]} />
        )}
      </View>
      {open && composition && parts.length > 0 ? <Composition composition={composition} parts={parts} denominator={denominator} styles={styles} /> : null}
      {series.length > 1 ? (
        <View style={styles.spark} accessibilityLabel={`最近 ${series.length} 次调用的上下文大小，最高 ${formatTokens(scale)}`}>
          {series.map((call, index) => {
            const failed = call.stopReason === "error" || call.stopReason === "aborted";
            const height = Math.max(2, Math.round(Math.min(1, call.contextTokens / scale) * 28));
            return (
              <View key={`${call.index}`} style={[styles.sparkBar, { height,
                backgroundColor: failed ? colors.statusDanger : color, opacity: failed || index === series.length - 1 ? 1 : 0.45 }]} />
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function Composition({ composition, parts, denominator, styles }: {
  composition: ContextBreakdown; parts: ContextBreakdown["categories"]; denominator: number; styles: Styles;
}) {
  const note = [
    composition.calibrated ? "按字符估算，已对齐最近一次请求的实际用量" : "按字符估算，压缩后还没有实际用量可对齐",
    composition.pendingTokens > 0 ? `另有约 ${formatTokens(composition.pendingTokens)} 新内容将计入下一次请求` : null,
  ].filter(Boolean).join("；");
  return (
    <View style={styles.composition}>
      {parts.map((category) => {
        const meta = CATEGORY_STYLE[category.key];
        const tools = category.key === "toolCalls" ? composition.topTools : [];
        return (
          <View key={category.key}>
            <View style={styles.compRow}>
              <View style={[styles.swatch, { backgroundColor: meta.color }]} />
              <Text style={styles.compLabel} numberOfLines={1}>
                {meta.label}
                {category.count !== null && meta.unit ? <Text style={styles.compCount}>{`  ${category.count} ${meta.unit}`}</Text> : null}
              </Text>
              <Text style={styles.compTokens}>{formatTokens(category.tokens)}</Text>
              <Text style={styles.compShare}>{`${formatShare((category.tokens / denominator) * 100)}%`}</Text>
            </View>
            {tools.length > 0 ? (
              <Text style={styles.compTools} numberOfLines={1}>{tools.map((tool) => `${tool.name} ${formatTokens(tool.tokens)}`).join(" · ")}</Text>
            ) : null}
          </View>
        );
      })}
      <Text style={styles.footer}>{note}</Text>
    </View>
  );
}

/** One decimal like Claude desktop, but small shares stay visible instead of reading 0.0%. */
function formatShare(percent: number): string {
  if (percent > 0 && percent < 0.1) return "<0.1";
  return percent.toFixed(1);
}

function KeyFigures({ snapshot, styles }: { snapshot: UsageSnapshot; styles: Styles }) {
  const cost = displayCost(snapshot);
  const rate = sessionCacheHitRate(snapshot.totals);
  return (
    <View style={styles.figures}>
      <Figure styles={styles} first label="花费" value={cost > 0 ? formatCost(cost) : "—"}
        detail={snapshot.estimatedCost > 0 ? "官方价估算" : cost > 0 ? "Pi 记账" : "模型未收录价表"} />
      <View style={styles.figureRule} />
      <Figure styles={styles} label="总 token" value={formatTokens(snapshot.totalTokens)}
        detail={`${groupDigits(snapshot.callCount)} 次调用 · ${groupDigits(snapshot.userTurns)} 轮`} />
      <View style={styles.figureRule} />
      <Figure styles={styles} label="缓存命中" value={rate === null ? "—" : `${rate.toFixed(1)}%`}
        detail={snapshot.cacheHitRate === null ? "全会话" : `最近一次 ${snapshot.cacheHitRate.toFixed(1)}%`} />
    </View>
  );
}

function Figure({ styles, first, label, value, detail }: { styles: Styles; first?: boolean; label: string; value: string; detail: string }) {
  return (
    <View style={[styles.figure, first && { paddingLeft: 0 }]}>
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      <Text style={styles.figureValue} numberOfLines={1}>{value}</Text>
      <Text style={styles.figureDetail} numberOfLines={1}>{detail}</Text>
    </View>
  );
}

function TurnRow({ turn, running, styles, colors }: { turn: TurnUsage; running: boolean; styles: Styles; colors: ThemeColors }) {
  const cost = turn.estimated > 0 ? turn.estimated : turn.cost;
  const parts = [`↑${formatTokens(turn.input)}`, `↓${formatTokens(turn.output)}`, `缓存读 ${formatTokens(turn.cacheRead)}`, `${turn.callCount} 次调用`];
  if (cost > 0) parts.push(formatCost(cost));
  return (
    <View style={styles.turn}>
      <View style={styles.turnHead}>
        {running ? <View style={[styles.dot, { backgroundColor: colors.statusSuccess }]} /> : null}
        <Text style={styles.label}>{turn.turn > 0 ? `本轮 · 第 ${turn.turn} 轮${running ? "（进行中）" : ""}` : "会话启动"}</Text>
        <Text style={[styles.label, styles.turnTime]}>{formatTime(turn.startedAt)}</Text>
      </View>
      <Text style={styles.turnText}>{parts.join(" · ")}</Text>
    </View>
  );
}

function Disclosure({ title, summary, styles, colors, children }: { title: string; summary: string; styles: Styles; colors: ThemeColors; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${open ? "收起" : "展开"}${title}`}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [styles.disclosureHead, (pressed || hovered) && { backgroundColor: colors.surface2 }]}>
        <Icon name={open ? "ChevronDown" : "ChevronRight"} size={14} color={colors.foregroundMuted} />
        <Text style={styles.disclosureTitle}>{title}</Text>
        <Text style={styles.disclosureSummary}>{summary}</Text>
      </Pressable>
      {open ? <View style={styles.disclosureBody}>{children}</View> : null}
    </View>
  );
}

function Line({ styles, label, value, detail }: { styles: Styles; label: string; value: string; detail?: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel} numberOfLines={1}>{label}</Text>
      {detail ? <Text style={styles.lineDetail} numberOfLines={1}>{detail}</Text> : null}
      <Text style={styles.lineValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

function Breakdown({ snapshot, styles }: { snapshot: UsageSnapshot; styles: Styles }) {
  const t = snapshot.totals;
  return (
    <>
      <Line styles={styles} label="↑ 输入" detail={formatTokens(t.input)} value={groupDigits(t.input)} />
      <Line styles={styles} label="↓ 输出" detail={formatTokens(t.output)} value={groupDigits(t.output)} />
      <Line styles={styles} label="缓存读" detail={formatTokens(t.cacheRead)} value={groupDigits(t.cacheRead)} />
      <Line styles={styles} label="缓存写" detail={formatTokens(t.cacheWrite)} value={groupDigits(t.cacheWrite)} />
      <Line styles={styles} label="思考（含在输出里）" detail={formatTokens(t.reasoning)} value={groupDigits(t.reasoning)} />
      {t.cost > 0 && snapshot.estimatedCost > 0 ? <Line styles={styles} label="Pi 记账花费" value={formatCost(t.cost)} /> : null}
      <Line styles={styles} label="压缩" value={`${snapshot.compactions} 次`} />
      <Line styles={styles} label="开始" value={formatTime(snapshot.startedAt)} />
    </>
  );
}

function PerModel({ items, styles }: { items: ModelUsage[]; styles: Styles }) {
  return (
    <>
      {items.map((item) => (
        <Line key={item.key} styles={styles} label={item.key === "Tools/summaries" ? "工具与摘要" : splitModel(item.key).name} detail={formatTokens(item.tokens)}
          value={formatCost(item.estimated > 0 ? item.estimated : item.cost)} />
      ))}
      <Text style={styles.footer}>按官方 API 价估算，价表在插件的 shared/pricing.ts，未收录的模型记 $0。</Text>
    </>
  );
}

function Calls({ calls, truncated, styles, colors }: { calls: CallUsage[]; truncated: boolean; styles: Styles; colors: ThemeColors }) {
  if (calls.length === 0) return <Text style={styles.note}>还没有带 usage 的调用。</Text>;
  return (
    <>
      <View style={styles.callRow}>
        <Text style={[styles.callIndex, styles.callHead]}>#</Text>
        <Text style={[styles.callTime, styles.callHead]}>时间</Text>
        <Text style={[styles.callTokens, styles.callHead]}>输入 / 输出</Text>
        <Text style={[styles.callNumber, styles.callHead]}>上下文</Text>
        <Text style={[styles.callNumber, styles.callHead]}>花费</Text>
      </View>
      {calls.map((call) => {
        const failed = call.stopReason === "error" || call.stopReason === "aborted";
        const cost = call.estimated > 0 ? call.estimated : call.cost;
        return (
          <View key={`${call.index}-${call.at ?? ""}`} style={styles.callRow}>
            <Text style={styles.callIndex}>{`#${call.index}`}</Text>
            <Text style={styles.callTime}>{formatTime(call.at)}</Text>
            <Text style={[styles.callTokens, failed && { color: colors.statusDanger }]} numberOfLines={1}>
              {failed ? call.stopReason : `↑${formatTokens(call.input)} ↓${formatTokens(call.output)}`}
            </Text>
            <Text style={styles.callNumber}>{formatTokens(call.contextTokens)}</Text>
            <Text style={styles.callNumber}>{cost > 0 ? formatCost(cost) : "—"}</Text>
          </View>
        );
      })}
      {truncated ? <Text style={styles.footer}>更早的调用不再保留明细，累计总量仍包含它们。</Text> : null}
    </>
  );
}

function createStyles(colors: ThemeColors, compact: boolean) {
  const num = { fontVariant: ["tabular-nums" as const] };
  return {
    screen: { flex: 1, backgroundColor: isDarkColor(colors.surface0) ? "transparent" : colors.surface0 },
    content: { width: compact ? undefined : 380, padding: 16, gap: 12 },
    header: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8 },
    headerText: { flex: 1, minWidth: 0, gap: 2 },
    title: { color: colors.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" as const },
    meta: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
    iconButton: { width: 28, height: 28, borderRadius: 6, alignItems: "center" as const, justifyContent: "center" as const },
    note: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
    label: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 16 },
    contextBlock: { gap: 6 },
    contextHead: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8 },
    contextUsed: { flex: 1, color: colors.foregroundMuted, fontSize: 12, textAlign: "right" as const, ...num },
    contextPercent: { color: colors.foreground, fontSize: 20, lineHeight: 24, fontWeight: "600" as const, minWidth: 48, textAlign: "right" as const, ...num },
    barTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" as const },
    barFill: { height: 4, borderRadius: 2 },
    barStacked: { height: 6, borderRadius: 3, flexDirection: "row" as const, gap: 1 },
    composition: { gap: 5, marginTop: 4 },
    compRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    swatch: { width: 10, height: 10, borderRadius: 2 },
    compLabel: { flex: 1, minWidth: 0, color: colors.foreground, fontSize: 13, lineHeight: 18 },
    compCount: { color: colors.foregroundMuted, fontSize: 11 },
    compTokens: { color: colors.foregroundMuted, fontSize: 12, minWidth: 48, textAlign: "right" as const, ...num },
    compShare: { color: colors.foreground, fontSize: 12, minWidth: 44, textAlign: "right" as const, ...num },
    compTools: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15, paddingLeft: 18, ...num },
    spark: { flexDirection: "row" as const, alignItems: "flex-end" as const, gap: 2, height: 28, marginTop: 4 },
    sparkBar: { flex: 1, maxWidth: 8, borderRadius: 1 },
    figures: { flexDirection: "row" as const, alignItems: "stretch" as const, paddingVertical: 10, borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.border },
    figure: { flex: 1, minWidth: 0, gap: 2, paddingHorizontal: 10 },
    figureRule: { width: 1, backgroundColor: colors.border },
    figureValue: { color: colors.foreground, fontSize: 17, lineHeight: 22, fontWeight: "600" as const, ...num },
    figureDetail: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 14 },
    turn: { gap: 3 },
    turnHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
    turnTime: { marginLeft: "auto" as const, ...num },
    turnText: { color: colors.foreground, fontSize: 13, lineHeight: 18, ...num },
    dot: { width: 6, height: 6, borderRadius: 3 },
    disclosures: { borderTopWidth: 1, borderColor: colors.border, paddingTop: 4, gap: 2 },
    disclosureHead: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6, height: 30, paddingHorizontal: 4, marginHorizontal: -4, borderRadius: 6 },
    disclosureTitle: { color: colors.foreground, fontSize: 13, fontWeight: "500" as const, flex: 1 },
    disclosureSummary: { color: colors.foregroundMuted, fontSize: 12, ...num },
    disclosureBody: { gap: 4, paddingLeft: 20, paddingBottom: 8 },
    line: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8 },
    lineLabel: { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18, flex: 1, minWidth: 0 },
    lineDetail: { color: colors.foregroundMuted, fontSize: 11, ...num },
    lineValue: { color: colors.foreground, fontSize: 12, lineHeight: 18, minWidth: 72, textAlign: "right" as const, ...num },
    callRow: { flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8 },
    callIndex: { color: colors.foregroundMuted, fontSize: 11, width: 30, ...num },
    callTime: { color: colors.foregroundMuted, fontSize: 11, width: compact ? 70 : 74, ...num },
    callTokens: { color: colors.foreground, fontSize: 11, flex: 1, minWidth: 0, ...num },
    callNumber: { color: colors.foregroundMuted, fontSize: 11, minWidth: 48, textAlign: "right" as const, ...num },
    callHead: { color: colors.foregroundMuted, opacity: 0.7 },
    footer: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 15 },
  };
}
