import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { formatCost, formatPercent, formatTokens, sessionCacheHitRate } from "../shared/format";
import type { CallUsage, ModelUsage, UsageSnapshot } from "../shared/usage";
import { piUsageCallsRpc, piUsageSnapshotRpc } from "../shared/usage";

const CALL_LIMIT = 40;

type ThemeColors = PluginHostProps["theme"]["colors"];
type Styles = ReturnType<typeof createStyles>;

function groupDigits(value: number): string {
  const text = String(Math.round(value));
  const negative = text.startsWith("-");
  const digits = negative ? text.slice(1) : text;
  return negative ? `-${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}` : digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatTime(iso: string | number | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Composer-pill popover surface. The host hands popover content a `close()`
 * callback, which is the only real "dismiss" affordance the plugin SDK offers —
 * so the token view lives here instead of in a tab the plugin cannot close.
 */
export function PiUsagePopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") {
    return <Text style={{ color: props.theme.colors.foregroundMuted }}>该表面只服务于 agent 上下文。</Text>;
  }
  return (
    <TokenUsageView
      theme={props.theme}
      layout={props.layout}
      agentId={props.agentId}
      narrow
      onClose={props.close}
    />
  );
}

function TokenUsageView({
  theme,
  layout,
  agentId,
  narrow,
  onClose,
}: {
  theme: PluginHostProps["theme"];
  layout: PluginHostProps["layout"];
  agentId: string;
  narrow?: boolean;
  onClose(): void;
}) {
  const colors = theme.colors;
  const compact = layout.compact;
  const snapshotRpc = useRpc(piUsageSnapshotRpc);
  const callsRpc = useRpc(piUsageCallsRpc);
  const agent = useAgent(agentId, ({ status, title }) => ({ status, title }));
  const styles = useMemo(() => createStyles(colors, compact), [colors, compact]);

  const intervalMs = agent?.status === "running" ? 2000 : 10_000;

  const snapshotQuery = useQuery({
    queryKey: ["pi-usage", "snapshot", agentId],
    queryFn: async () => {
      const result = await snapshotRpc({ agentIds: [agentId] });
      return result.agents.find((entry) => entry.agentId === agentId) ?? null;
    },
    refetchInterval: intervalMs,
    staleTime: 1000,
  });

  const callsQuery = useQuery({
    queryKey: ["pi-usage", "calls", agentId, CALL_LIMIT],
    queryFn: () => callsRpc({ agentId, limit: CALL_LIMIT }),
    refetchInterval: intervalMs,
    staleTime: 1000,
  });

  const snapshot = snapshotQuery.data ?? null;
  const calls = callsQuery.data ?? null;

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.headerRow}>
          <View style={styles.headerText}>
            <Text style={styles.title}>π Token 用量</Text>
            {agent?.title ? (
              <Text numberOfLines={1} style={styles.subtitle}>
                {`会话：${agent.title}`}
              </Text>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="立即刷新 Pi token 用量"
            style={styles.refreshButton}
            onPress={() => {
              void snapshotQuery.refetch();
              void callsQuery.refetch();
            }}
          >
            <Text style={styles.refreshText}>刷新</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="关闭 Token 面板"
            style={styles.refreshButton}
            onPress={onClose}
          >
            <Text style={styles.refreshText}>关闭</Text>
          </Pressable>
        </View>

        {snapshot === null ? (
          <Text style={styles.muted}>
            {snapshotQuery.isError ? `读取失败：${describe(snapshotQuery.error)}` : "正在读取 Pi 会话…"}
          </Text>
        ) : (
          <SnapshotBody snapshot={snapshot} styles={styles} colors={colors} />
        )}

        {snapshot?.status === "ok" && calls?.perModel.length ? (
          <PerModelList items={calls.perModel} styles={styles} />
        ) : null}

        {snapshot?.status === "ok" ? (
          <CallsTable
            calls={calls?.calls ?? []}
            truncated={calls?.truncated ?? false}
            loading={calls === null && !callsQuery.isError}
            error={callsQuery.isError ? describe(callsQuery.error) : null}
            styles={styles}
            compact={compact}
            narrowColumns={compact || Boolean(narrow)}
          />
        ) : null}

        {snapshot?.status === "ok" && snapshot.sessionFile ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>会话文件</Text>
            <Text selectable style={styles.mono}>
              {snapshot.sessionFile}
            </Text>
            <Text style={styles.muted}>
              {formatBytes(snapshot.fileBytes)} · 读取于 {formatTime(snapshotQuery.dataUpdatedAt)}
            </Text>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SnapshotBody({ snapshot, styles, colors }: { snapshot: UsageSnapshot; styles: Styles; colors: ThemeColors }) {
  if (snapshot.status === "not_pi") {
    return <Text style={styles.muted}>该 agent 的 provider 是 {snapshot.provider ?? "未知"}，本插件只统计 Pi 会话。</Text>;
  }
  if (snapshot.status === "no_session") {
    return <Text style={styles.muted}>Pi 会话文件还没生成。发出第一条消息后，这里会出现整个会话的累计用量（含插件安装之前的历史）。</Text>;
  }
  if (snapshot.status === "error") {
    return <Text style={[styles.muted, { color: colors.statusDanger }]}>读取失败：{snapshot.error ?? "未知错误"}</Text>;
  }

  const percent = snapshot.contextPercent;
  const barColor =
    percent === null ? colors.accent : percent > 90 ? colors.statusDanger : percent > 70 ? colors.statusWarning : colors.accent;
  const contextDetail = snapshot.contextStale
    ? `压缩后待更新 · 已用 ${formatTokens(snapshot.contextUsedTokens)}`
    : `${formatTokens(snapshot.contextUsedTokens)}${snapshot.contextWindowTokens ? ` / ${formatTokens(snapshot.contextWindowTokens)}` : ""}`;
  const sessionRate = sessionCacheHitRate(snapshot.totals);

  return (
    <>
      <View style={styles.cardRow}>
        <StatCard styles={styles} label="总 token" value={formatTokens(snapshot.totalTokens)} detail={groupDigits(snapshot.totalTokens)} />
        <StatCard styles={styles} label="花费" value={formatCost(snapshot.totals.cost)} detail={`压缩 ${snapshot.compactions} 次`} />
        <StatCard
          styles={styles}
          label="上下文"
          value={percent === null ? "?" : `${formatPercent(percent)}%`}
          detail={snapshot.contextWindowTokens || snapshot.contextUsedTokens ? contextDetail : "窗口未知"}
          bar={percent === null ? undefined : { percent, color: barColor }}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Token 明细（整个会话累计）</Text>
        <Row
          styles={styles}
          label="总 token"
          value={formatTokens(snapshot.totalTokens)}
          detail="= ↑输入 + ↓输出 + R缓存读 + W缓存写"
        />
        <Row styles={styles} label="↑ 输入" value={formatTokens(snapshot.totals.input)} detail={groupDigits(snapshot.totals.input)} />
        <Row styles={styles} label="↓ 输出" value={formatTokens(snapshot.totals.output)} detail={groupDigits(snapshot.totals.output)} />
        <Row styles={styles} label="R 缓存读" value={formatTokens(snapshot.totals.cacheRead)} detail={groupDigits(snapshot.totals.cacheRead)} />
        <Row styles={styles} label="W 缓存写" value={formatTokens(snapshot.totals.cacheWrite)} detail={groupDigits(snapshot.totals.cacheWrite)} />
        <Row styles={styles} label="✳ 思考" value={formatTokens(snapshot.totals.reasoning)} detail={groupDigits(snapshot.totals.reasoning)} />
        <Row
          styles={styles}
          label="命中率 · 最近调用"
          value={snapshot.cacheHitRate === null ? "—" : `${snapshot.cacheHitRate.toFixed(1)}%`}
        />
        <Row
          styles={styles}
          label="命中率 · 全会话"
          value={sessionRate === null ? "—" : `${sessionRate.toFixed(1)}%`}
          detail="ΣcacheRead / Σprompt tokens"
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>会话</Text>
        <Row
          styles={styles}
          label="模型"
          value={snapshot.model ?? "—"}
          detail={snapshot.thinkingLevel ? `thinking ${snapshot.thinkingLevel}` : undefined}
        />
        <Row styles={styles} label="LLM 调用" value={groupDigits(snapshot.calls)} detail={`用户轮次 ${groupDigits(snapshot.userTurns)}`} />
        <Row styles={styles} label="开始" value={formatTime(snapshot.startedAt)} detail={`最后活动 ${formatTime(snapshot.lastActivityAt)}`} />
        {snapshot.sessionId ? <Row styles={styles} label="Session" value={snapshot.sessionId} /> : null}
      </View>
    </>
  );
}

function PerModelList({ items, styles }: { items: ModelUsage[]; styles: Styles }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>按模型拆分</Text>
      {items.map((item) => (
        <Row key={item.key} styles={styles} label={item.key} value={formatTokens(item.tokens)} detail={formatCost(item.cost)} />
      ))}
    </View>
  );
}

function CallsTable({
  calls,
  truncated,
  loading,
  error,
  styles,
  compact,
  narrowColumns,
}: {
  calls: CallUsage[];
  truncated: boolean;
  loading: boolean;
  error: string | null;
  styles: Styles;
  compact: boolean;
  narrowColumns: boolean;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>最近 {CALL_LIMIT} 次 LLM 调用（新→旧）</Text>
      {error ? <Text style={styles.muted}>读取失败：{error}</Text> : null}
      {loading ? <Text style={styles.muted}>正在读取…</Text> : null}
      {!loading && !error && calls.length === 0 ? <Text style={styles.muted}>还没有带 usage 的调用。</Text> : null}
      {calls.map((call) => (
        <View key={`${call.index}-${call.at ?? ""}`} style={styles.callRow}>
          <Text style={styles.callIndex}>#{call.index}</Text>
          <Text style={styles.callTime}>{formatTime(call.at)}</Text>
          <Text style={styles.callModel} numberOfLines={1}>
            {call.model}
          </Text>
          <Text style={styles.callNumber}>↑{formatTokens(call.input)}</Text>
          <Text style={styles.callNumber}>↓{formatTokens(call.output)}</Text>
          {narrowColumns ? null : <Text style={styles.callNumber}>R{formatTokens(call.cacheRead)}</Text>}
          <Text style={styles.callNumber}>{formatCost(call.cost)}</Text>
          {narrowColumns ? null : <Text style={styles.callNumber}>{formatTokens(call.contextTokens)} ctx</Text>}
        </View>
      ))}
      {truncated ? <Text style={styles.muted}>更早的调用已从内存中丢弃，累计总量仍然包含它们。</Text> : null}
    </View>
  );
}

function StatCard({
  styles,
  label,
  value,
  detail,
  bar,
}: {
  styles: Styles;
  label: string;
  value: string;
  detail?: string;
  bar?: { percent: number; color: string };
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={styles.cardValue}>{value}</Text>
      {detail ? (
        <Text numberOfLines={1} style={styles.cardDetail}>
          {detail}
        </Text>
      ) : null}
      {bar ? (
        <View style={styles.cardBarTrack}>
          <View
            style={[
              styles.cardBarFill,
              { width: `${Math.max(0, Math.min(100, bar.percent))}%`, backgroundColor: bar.color },
            ]}
          />
        </View>
      ) : null}
    </View>
  );
}

function Row({ styles, label, value, detail }: { styles: Styles; label: string; value: string; detail?: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.rowValue}>
        <Text style={styles.rowValueText}>{value}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

function createStyles(colors: ThemeColors, compact: boolean) {
  return {
    screen: { flex: 1, backgroundColor: colors.surface0 },
    content: { padding: compact ? 16 : 20, gap: compact ? 12 : 16 },
    headerRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    headerText: { flex: 1, gap: 2 },
    title: { color: colors.foreground, fontSize: compact ? 16 : 18, fontWeight: "600" as const },
    subtitle: { color: colors.foregroundMuted, fontSize: 12 },
    refreshButton: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: colors.surface2 },
    refreshText: { color: colors.foreground, fontSize: 12 },
    muted: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 },
    mono: { color: colors.foregroundMuted, fontSize: 11, lineHeight: 16 },
    cardRow: { flexDirection: "row" as const, gap: compact ? 8 : 10 },
    card: {
      flex: 1,
      gap: 2,
      padding: compact ? 10 : 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface1,
    },
    cardLabel: { color: colors.foregroundMuted, fontSize: 11 },
    cardValue: { color: colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
    cardDetail: { color: colors.foregroundMuted, fontSize: 11 },
    cardBarTrack: { height: 4, borderRadius: 2, backgroundColor: colors.surface2, overflow: "hidden" as const, marginTop: 6 },
    cardBarFill: { height: 4, borderRadius: 2 },
    section: { gap: 6, paddingTop: 4 },
    sectionTitle: { color: colors.foreground, fontSize: 13, fontWeight: "600" as const, marginBottom: 2 },
    row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
    rowLabel: { color: colors.foregroundMuted, fontSize: 13, width: compact ? 96 : 132 },
    rowValue: { flex: 1, flexDirection: "row" as const, alignItems: "baseline" as const, gap: 8, justifyContent: "flex-end" as const },
    rowValueText: { color: colors.foreground, fontSize: 13, fontWeight: "500" as const, textAlign: "right" as const },
    rowDetail: { color: colors.foregroundMuted, fontSize: 11, textAlign: "right" as const },
    callRow: { flexDirection: "row" as const, alignItems: "center" as const, gap: compact ? 6 : 8 },
    callIndex: { color: colors.foregroundMuted, fontSize: 11, width: compact ? 30 : 36 },
    callTime: { color: colors.foregroundMuted, fontSize: 11, width: compact ? 58 : 84 },
    callModel: { color: colors.foreground, fontSize: 11, flex: 1 },
    callNumber: { color: colors.foregroundMuted, fontSize: 11, minWidth: compact ? 40 : 48, textAlign: "right" as const },
  };
}
