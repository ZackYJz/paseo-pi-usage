import type { ContextBreakdown, ContextCategory } from "../shared/usage";
import { CONTEXT_CATEGORIES } from "../shared/usage";

/**
 * Context composition for one Pi session file.
 *
 * Pi 1.2+ persists the prompt and tool loadout as system messages: the first
 * carries every prompt section and tool declaration, later ones patch sections
 * by name (`null` removes one) and add or remove tools, and compactions carry a
 * full checkpoint. The ledger keeps a small numeric record per entry (no text)
 * and replays them along the active branch the way Pi's `buildSessionProjection`
 * does: leaf-to-root path, newest compaction plus its kept range, and
 * `context_edit` replacements.
 *
 * Token counts are estimates (Pi's chars/4, with CJK at one token per
 * character). `breakdown()` calibrates them against the newest measured request.
 */

/** Pi's `ESTIMATED_IMAGE_CHARS` (4800) at four characters per token. */
const IMAGE_TOKENS = 1200;
const TOP_TOOLS = 5;

/** About one token per CJK character and four characters per token otherwise. */
export function estimateTextTokens(text: string): number {
  let wide = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) wide += 1;
  }
  return wide + (text.length - wide) / 4;
}

/** Estimated tokens of one content value, split the way the categories need it. */
interface Parts {
  text: number;
  thinking: number;
  /** Tool-call blocks by tool name (name plus JSON arguments). */
  calls: Record<string, number>;
}

function partsOf(content: unknown): Parts {
  const parts: Parts = { text: 0, thinking: 0, calls: {} };
  if (typeof content === "string") {
    parts.text = estimateTextTokens(content);
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.text += estimateTextTokens(block.text);
    else if (block.type === "image") parts.text += IMAGE_TOKENS;
    else if (block.type === "thinking" && typeof block.thinking === "string") parts.thinking += estimateTextTokens(block.thinking);
    else if (block.type === "toolCall") {
      const name = typeof block.name === "string" ? block.name : "?";
      parts.calls[name] = (parts.calls[name] ?? 0) + estimateTextTokens(name + JSON.stringify(block.arguments ?? {}));
    }
  }
  return parts;
}

interface Section {
  tokens: number;
  count: number | null;
}

interface SystemPatch {
  content: number;
  sections: Record<string, Section | null>;
  toolsAdded: Array<{ name: string; tokens: number }>;
  toolsRemoved: string[];
}

type Node =
  | { kind: "context"; id: string; parentId: string | null; role: string; toolName: string | null; parts: Parts }
  | { kind: "system"; id: string; parentId: string | null; patch: SystemPatch }
  | { kind: "compaction"; id: string; parentId: string | null; firstKeptId: string | null; summary: number; checkpoint: SystemPatch | null }
  | { kind: "edit"; id: string; parentId: string | null; targetId: string; replacement: Parts | null }
  | { kind: "other"; id: string; parentId: string | null };

function countMatches(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

function sectionOf(name: string, text: string): Section {
  const count = name === "skills" ? countMatches(text, "<skill>") : name === "project_context" ? countMatches(text, "<project_instructions") : null;
  return { tokens: estimateTextTokens(text), count };
}

function patchOf(message: Record<string, unknown>): SystemPatch {
  const sections: Record<string, Section | null> = {};
  const raw = message.sections;
  if (raw && typeof raw === "object") {
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (value === null) sections[name] = null;
      else if (typeof value === "string") sections[name] = sectionOf(name, value);
    }
  }
  const toolsAdded: SystemPatch["toolsAdded"] = [];
  if (Array.isArray(message.toolsAdded)) {
    for (const tool of message.toolsAdded as Array<Record<string, unknown>>) {
      if (tool && typeof tool.name === "string") toolsAdded.push({ name: tool.name, tokens: estimateTextTokens(JSON.stringify(tool)) });
    }
  }
  const toolsRemoved: string[] = [];
  if (Array.isArray(message.toolsRemoved)) {
    for (const tool of message.toolsRemoved as Array<Record<string, unknown>>) {
      if (tool && typeof tool.name === "string") toolsRemoved.push(tool.name);
    }
  }
  return { content: partsOf(message.content).text, sections, toolsAdded, toolsRemoved };
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** MCP adapters namespace their tools; `mcp_servers` is the prompt section listing codemode-only servers. */
function isMcpTool(name: string): boolean {
  return name.startsWith("mcp__") || name.startsWith("mcp_");
}

function sectionCategory(name: string): ContextCategory {
  if (name === "skills") return "skills";
  if (name === "project_context") return "projectContext";
  if (name === "tools") return "systemTools";
  if (name === "mcp_servers") return "mcp";
  return "systemPrompt";
}

class SystemState {
  private content = 0;
  private sections = new Map<string, Section>();
  private tools = new Map<string, number>();

  get known(): boolean {
    return this.content > 0 || this.sections.size > 0 || this.tools.size > 0;
  }

  reset(): void {
    this.content = 0;
    this.sections.clear();
    this.tools.clear();
  }

  apply(patch: SystemPatch): void {
    this.content += patch.content;
    for (const [name, section] of Object.entries(patch.sections)) {
      if (section) this.sections.set(name, section);
      else this.sections.delete(name);
    }
    for (const name of patch.toolsRemoved) this.tools.delete(name);
    for (const tool of patch.toolsAdded) this.tools.set(tool.name, tool.tokens);
  }

  addTo(totals: Record<ContextCategory, number>, counts: Partial<Record<ContextCategory, number>>): void {
    totals.systemPrompt += this.content;
    for (const [name, section] of this.sections) {
      const category = sectionCategory(name);
      totals[category] += section.tokens;
      if (section.count !== null) counts[category] = (counts[category] ?? 0) + section.count;
    }
    for (const [name, tokens] of this.tools) {
      const category = isMcpTool(name) ? "mcp" : "systemTools";
      totals[category] += tokens;
      counts[category] = (counts[category] ?? 0) + 1;
    }
  }
}

interface Dynamic {
  messages: number;
  toolCalls: number;
  thinking: number;
  tools: Map<string, number>;
}

function emptyDynamic(): Dynamic {
  return { messages: 0, toolCalls: 0, thinking: 0, tools: new Map() };
}

function addParts(into: Dynamic, role: string, toolName: string | null, parts: Parts): void {
  if (role === "toolResult") {
    into.toolCalls += parts.text;
    const name = toolName ?? "?";
    into.tools.set(name, (into.tools.get(name) ?? 0) + parts.text);
  } else {
    into.messages += parts.text;
  }
  into.thinking += parts.thinking;
  for (const [name, tokens] of Object.entries(parts.calls)) {
    into.toolCalls += tokens;
    into.tools.set(name, (into.tools.get(name) ?? 0) + tokens);
  }
}

const EDITABLE_ROLES = new Set(["user", "assistant", "toolResult", "custom"]);

export class ContextLedger {
  private nodes = new Map<string, Node>();
  private leafId: string | null = null;

  /** Feed every parsed session entry in file order. */
  add(entry: Record<string, unknown>): void {
    const id = str(entry.id);
    if (!id) return;
    const parentId = str(entry.parentId);
    this.leafId = id;
    this.nodes.set(id, this.nodeOf(entry, id, parentId));
  }

  private nodeOf(entry: Record<string, unknown>, id: string, parentId: string | null): Node {
    switch (entry.type) {
      case "message": {
        const message = entry.message as Record<string, unknown> | undefined;
        const role = typeof message?.role === "string" ? message.role : null;
        if (!message || !role) break;
        if (role === "system") return { kind: "system", id, parentId, patch: patchOf(message) };
        if (role === "bashExecution") {
          if (message.excludeFromContext === true) break;
          const text = `${typeof message.command === "string" ? message.command : ""}${typeof message.output === "string" ? message.output : ""}`;
          return { kind: "context", id, parentId, role, toolName: null, parts: { text: estimateTextTokens(text), thinking: 0, calls: {} } };
        }
        if (role === "branchSummary" || role === "compactionSummary") {
          const text = typeof message.summary === "string" ? message.summary : "";
          return { kind: "context", id, parentId, role, toolName: null, parts: { text: estimateTextTokens(text), thinking: 0, calls: {} } };
        }
        return { kind: "context", id, parentId, role, toolName: str(message.toolName), parts: partsOf(message.content) };
      }
      case "custom_message":
        return { kind: "context", id, parentId, role: "custom", toolName: null, parts: partsOf(entry.content) };
      case "branch_summary": {
        const summary = typeof entry.summary === "string" ? entry.summary : "";
        if (!summary) break;
        return { kind: "context", id, parentId, role: "branchSummary", toolName: null, parts: { text: estimateTextTokens(summary), thinking: 0, calls: {} } };
      }
      case "compaction": {
        const checkpoint = entry.systemMessage && typeof entry.systemMessage === "object" ? patchOf(entry.systemMessage as Record<string, unknown>) : null;
        return {
          kind: "compaction",
          id,
          parentId,
          firstKeptId: str(entry.firstKeptEntryId),
          summary: estimateTextTokens(typeof entry.summary === "string" ? entry.summary : ""),
          checkpoint,
        };
      }
      case "context_edit": {
        const targetId = str(entry.targetId);
        if (!targetId) break;
        const replacement = entry.replacement as Record<string, unknown> | null | undefined;
        return { kind: "edit", id, parentId, targetId, replacement: replacement ? partsOf(replacement.content) : null };
      }
    }
    return { kind: "other", id, parentId };
  }

  /**
   * Composition of the active context. With a measured request (`anchorId` is
   * the assistant entry whose usage gave `measuredTokens`), everything up to it
   * is scaled to sum to that measurement and anything after it is reported as
   * pending. Null when the session never declared its prompt (pre-1.2 Pi).
   */
  breakdown(anchor: { id: string; tokens: number } | null): ContextBreakdown | null {
    const path = this.path();
    if (path.length === 0) return null;

    // The prompt and tools: replay every system patch on the path; a compaction
    // checkpoint replaces everything before it, as Pi's projection does.
    const system = new SystemState();
    for (const node of path) {
      if (node.kind === "system") system.apply(node.patch);
      else if (node.kind === "compaction" && node.checkpoint) {
        system.reset();
        system.apply(node.checkpoint);
      }
    }
    if (!system.known) return null;

    const entries = this.contextEntries(path);
    const edits = new Map<string, Node & { kind: "edit" }>();
    for (const node of entries) if (node.kind === "edit") edits.set(node.targetId, node);

    const anchorIndex = anchor ? entries.findIndex((node) => node.id === anchor.id) : -1;
    const measured = emptyDynamic();
    const pending = emptyDynamic();
    entries.forEach((node, index) => {
      const into = anchorIndex >= 0 && index > anchorIndex ? pending : measured;
      if (node.kind === "compaction") {
        // Only the newest compaction (always first) contributes its summary.
        if (index === 0) into.messages += node.summary;
        return;
      }
      if (node.kind !== "context") return;
      const edit = edits.get(node.id);
      if (edit && EDITABLE_ROLES.has(node.role)) {
        if (edit.replacement) addParts(into, node.role, node.toolName, edit.replacement);
        return;
      }
      addParts(into, node.role, node.toolName, node.parts);
    });

    const totals = Object.fromEntries(CONTEXT_CATEGORIES.map((key) => [key, 0])) as Record<ContextCategory, number>;
    const counts: Partial<Record<ContextCategory, number>> = {};
    system.addTo(totals, counts);

    const calibrated = anchorIndex >= 0 && anchor !== null && anchor.tokens > 0;
    const scale = calibrated ? calibrate(totals, measured, anchor.tokens) : { fixed: 1, dynamic: 1, thinking: measured.thinking };
    for (const key of ["mcp", "systemTools", "skills", "projectContext", "systemPrompt"] as const) totals[key] *= scale.fixed;
    totals.messages = measured.messages * scale.dynamic;
    totals.toolCalls = measured.toolCalls * scale.dynamic;
    totals.thinking = scale.thinking;

    const categories = CONTEXT_CATEGORIES.map((key) => ({
      key,
      tokens: Math.round(totals[key]),
      count: counts[key] ?? null,
    }));
    const topTools = Array.from(measured.tools, ([name, tokens]) => ({ name, tokens: Math.round(tokens * scale.dynamic) }))
      .filter((tool) => tool.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, TOP_TOOLS);
    const pendingTokens = Math.round(pending.messages + pending.toolCalls + pending.thinking);
    return {
      total: categories.reduce((sum, category) => sum + category.tokens, 0),
      calibrated,
      pendingTokens,
      categories,
      topTools,
    };
  }

  /** Leaf-to-root path, oldest first. The leaf is the newest entry, as in Pi. */
  private path(): Node[] {
    const path: Node[] = [];
    const seen = new Set<string>();
    let current = this.leafId ? this.nodes.get(this.leafId) : undefined;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.push(current);
      current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    }
    return path.reverse();
  }

  /** Pi's `buildContextEntries`: the newest compaction, its kept range, then everything after it. */
  private contextEntries(path: Node[]): Node[] {
    let compactionIndex = -1;
    path.forEach((node, index) => {
      if (node.kind === "compaction") compactionIndex = index;
    });
    if (compactionIndex < 0) return path;
    const compaction = path[compactionIndex] as Node & { kind: "compaction" };
    const entries: Node[] = [compaction];
    let kept = false;
    for (let i = 0; i < compactionIndex; i += 1) {
      const node = path[i]!;
      if (node.id === compaction.firstKeptId) kept = true;
      if (kept && node.kind !== "system") entries.push(node);
    }
    entries.push(...path.slice(compactionIndex + 1));
    return entries;
  }
}

/**
 * Reconcile the estimates with a measured request. The prompt and tool
 * declarations estimate well (within a few percent of a first request), so they
 * stay as estimated. Messages and tool traffic fill the rest. Thinking gets
 * only what is left after that, capped at its own estimate, because whether
 * earlier thinking is replayed depends on the provider.
 */
function calibrate(totals: Record<ContextCategory, number>, measured: Dynamic, tokens: number): { fixed: number; dynamic: number; thinking: number } {
  const fixed = totals.mcp + totals.systemTools + totals.skills + totals.projectContext + totals.systemPrompt;
  const base = measured.messages + measured.toolCalls;
  const remainder = tokens - fixed;
  if (remainder <= 0 || base <= 0) {
    // Estimates and measurement disagree badly; keep the proportions and fit the total.
    const all = fixed + base + measured.thinking;
    const factor = all > 0 ? tokens / all : 1;
    return { fixed: factor, dynamic: factor, thinking: measured.thinking * factor };
  }
  if (remainder <= base) return { fixed: 1, dynamic: remainder / base, thinking: 0 };
  const thinking = Math.min(measured.thinking, remainder - base);
  return { fixed: 1, dynamic: (remainder - thinking) / base, thinking };
}
