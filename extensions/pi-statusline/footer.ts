import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import {
  configEnablesOpenAISubscription,
  loadStatuslineConfig,
  type SectionName,
  type StatuslineConfig,
} from "./config.ts";
import {
  formatOpenAISubscriptionWindow,
  formatSubscriptionError,
  selectOpenAIWindows,
  type OpenAISubscriptionState,
} from "./openai-usage.ts";

const GIT_TIMEOUT_MS = 800;
const RESET = "\x1b[0m";
const USE_COLOR =
  !process.env.NO_COLOR &&
  process.env.FORCE_COLOR !== "0" &&
  process.env.TERM !== "dumb";
const SYMBOLS = {
  pi: "pi",
  git: "git",
  input: "in ",
  output: "out ",
  ahead: "ahead ",
  behind: "behind ",
  dirty: "+",
  filled: "#",
  empty: "-",
};

type ThemeFg = Parameters<Theme["getFgAnsi"]>[0];
type ThemeBg = Parameters<Theme["getBgAnsi"]>[0];

interface Segment {
  text: string;
  fg: ThemeFg;
  bg: ThemeBg;
}

interface GitState {
  branch?: string | undefined;
  sha?: string | undefined;
  dirtyCount: number;
  ahead: number;
  behind: number;
}

const COLORS = {
  cwd: { fg: "text", bg: "selectedBg" },
  gitClean: { fg: "text", bg: "toolSuccessBg" },
  gitDirty: { fg: "text", bg: "toolPendingBg" },
  session: { fg: "text", bg: "selectedBg" },
  subscription: { fg: "text", bg: "toolSuccessBg" },
  status: { fg: "text", bg: "customMessageBg" },
  model: { fg: "customMessageText", bg: "customMessageBg" },
  context: { fg: "text", bg: "selectedBg" },
  warning: { fg: "text", bg: "toolPendingBg" },
  critical: { fg: "text", bg: "toolErrorBg" },
} satisfies Record<string, { fg: ThemeFg; bg: ThemeBg }>;

export class PiStatuslineFooter implements Component {
  private git: GitState | undefined;
  private gitRefresh: Promise<void> | undefined;
  private config: StatuslineConfig;
  private disposed = false;
  private readonly unsubscribeBranch: () => void;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly footerData: ReadonlyFooterDataProvider,
    private readonly subscription: OpenAISubscriptionState,
  ) {
    this.config = loadStatuslineConfig(ctx);
    this.unsubscribeBranch = footerData.onBranchChange(() => {
      this.refreshGit();
      this.requestRender();
    });
    this.refreshGit();
  }

  invalidate(): void {
    this.requestRender();
  }

  isOpenAISubscriptionEnabled(): boolean {
    return configEnablesOpenAISubscription(this.config);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeBranch();
  }

  reloadConfig(): void {
    this.config = loadStatuslineConfig(this.ctx);
    this.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth <= 0) return [""];

    const left = this.renderConfiguredSegments(this.config.left);
    const right = this.renderConfiguredSegments(this.config.right);

    const leftText = renderSegments(left, this.theme);
    const rightText = renderSegments(right, this.theme);
    if (!rightText) return [ensureWidth(leftText, safeWidth)];

    const rightSafe = ensureWidth(rightText, safeWidth);
    const rightWidth = visibleWidth(rightSafe);
    if (rightWidth >= safeWidth) return [rightSafe];
    const leftAvailable = safeWidth - rightWidth - 1;
    const leftSafe =
      leftAvailable > 0 ? ensureWidth(leftText, leftAvailable) : "";
    const gap = Math.max(1, safeWidth - visibleWidth(leftSafe) - rightWidth);
    return [
      ensureWidth(`${leftSafe}${" ".repeat(gap)}${rightSafe}`, safeWidth),
    ];
  }

  private renderConfiguredSegments(sections: SectionName[]): Segment[] {
    const segments: Segment[] = [];
    for (const section of sections) {
      const rendered = this.renderSection(section);
      if (Array.isArray(rendered)) segments.push(...rendered);
      else if (rendered) segments.push(rendered);
    }
    return segments.filter((segment) => Boolean(segment.text.trim()));
  }

  private renderSection(section: SectionName): Segment | Segment[] | undefined {
    switch (section) {
      case "cwd":
        return this.cwdSegment();
      case "git":
        return this.gitSegment();
      case "session":
        return this.sessionSegment();
      case "subscription":
        return this.subscriptionSegment();
      case "status":
        return this.statusSegments();
      case "context":
        return this.contextSegment();
      case "model":
        return this.modelSegment();
    }
  }

  private cwdSegment(): Segment {
    return {
      ...COLORS.cwd,
      text: `${SYMBOLS.pi} ${fishPath(collapseHome(this.ctx.cwd))}`,
    };
  }

  private gitSegment(): Segment | undefined {
    const branch = sanitize(
      this.footerData.getGitBranch() ?? this.git?.branch ?? "",
    );
    if (!branch) return undefined;
    const parts = [`${SYMBOLS.git} ${branch}`];
    if (this.git?.sha) parts.push(this.git.sha);
    if (this.git?.dirtyCount) parts.push(SYMBOLS.dirty);
    if (this.git?.ahead) parts.push(`${SYMBOLS.ahead}${this.git.ahead}`);
    if (this.git?.behind) parts.push(`${SYMBOLS.behind}${this.git.behind}`);
    return {
      ...(this.git?.dirtyCount ? COLORS.gitDirty : COLORS.gitClean),
      text: parts.join(" "),
    };
  }

  private sessionSegment(): Segment | undefined {
    const usage = getUsage(this.ctx);
    if (
      usage.input === 0 &&
      usage.output === 0 &&
      usage.cacheRead === 0 &&
      usage.cacheWrite === 0 &&
      usage.cost === 0
    )
      return undefined;
    const cacheText =
      usage.cacheRead > 0 || usage.cacheWrite > 0
        ? ` R${formatTokens(usage.cacheRead)} W${formatTokens(usage.cacheWrite)}`
        : "";
    return {
      ...COLORS.session,
      text: `${SYMBOLS.input}${formatTokens(usage.input)} ${SYMBOLS.output}${formatTokens(usage.output)}${cacheText} $${usage.cost.toFixed(3)}`,
    };
  }

  private subscriptionSegment(): Segment | undefined {
    if (!this.subscription.enabled) return undefined;
    const usage = this.subscription.usage;
    if (this.subscription.loading && (!usage || usage.windows.length === 0))
      return { ...COLORS.subscription, text: "OpenAI ..." };
    if (!usage) return undefined;
    if (usage.error?.code === "NO_CREDENTIALS")
      return { ...COLORS.warning, text: "OpenAI no OAuth" };

    const windows = selectOpenAIWindows(usage.windows, this.ctx.model).slice(
      0,
      3,
    );
    if (windows.length === 0) {
      if (!usage.error) return undefined;
      return {
        ...COLORS.warning,
        text: `OpenAI ${formatSubscriptionError(usage.error)}`,
      };
    }

    const remainingValues = windows.map((window) => 100 - window.usedPercent);
    const minRemaining = Math.min(...remainingValues);
    const color =
      minRemaining <= 10
        ? COLORS.critical
        : minRemaining <= 25 || usage.error
          ? COLORS.warning
          : COLORS.subscription;
    const showResetTimes = this.config.openaiSubscription.showResetTimes;
    return {
      ...color,
      text: `OpenAI ${windows.map((window) => formatOpenAISubscriptionWindow(window, showResetTimes)).join(" | ")}`,
    };
  }

  private statusSegments(): Segment[] {
    return Array.from(this.footerData.getExtensionStatuses().entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitize(text))
      .filter(Boolean)
      .slice(0, 3)
      .map((text) => ({ ...COLORS.status, text }));
  }

  private contextSegment(): Segment | undefined {
    const usage = this.ctx.getContextUsage();
    const window = usage?.contextWindow ?? this.ctx.model?.contextWindow;
    if (!window) return undefined;
    const tokens = usage?.tokens ?? undefined;
    const percent =
      usage?.percent ??
      (tokens !== undefined ? (tokens / window) * 100 : undefined);
    const ratio = percent === undefined ? 0 : clamp(percent / 100, 0, 1);
    const color =
      percent !== undefined && percent >= 90
        ? COLORS.critical
        : percent !== undefined && percent >= 70
          ? COLORS.warning
          : COLORS.context;
    const label =
      percent === undefined ? "ctx ?" : `ctx ${percent.toFixed(0)}%`;
    const tokenText =
      tokens === undefined
        ? ""
        : ` ${formatTokens(tokens)}/${formatTokens(window)}`;
    return { ...color, text: `${label} ${bar(ratio, 8)}${tokenText}` };
  }

  private modelSegment(): Segment {
    const model = this.ctx.model;
    let text = model?.id ?? "no-model";
    if (model && this.footerData.getAvailableProviderCount() > 1)
      text = `${model.provider}/${text}`;
    const thinking = this.getThinkingLevel();
    if (thinking) text += ` ${thinking}`;
    return { ...COLORS.model, text: sanitize(text) };
  }

  private getThinkingLevel(): string | undefined {
    return this.ctx.thinkingLevel ?? this.pi.getThinkingLevel();
  }

  refreshGit(): void {
    if (this.gitRefresh || this.disposed) return;
    this.gitRefresh = readGitState(this.ctx.cwd)
      .then((git) => {
        if (!this.disposed) this.git = git;
      })
      .finally(() => {
        this.gitRefresh = undefined;
        this.requestRender();
      });
  }

  private requestRender(): void {
    if (!this.disposed) this.tui.requestRender();
  }
}

function renderSegments(segments: Segment[], theme: Theme): string {
  return segments
    .map((segment) =>
      ansi(segment.text ? ` ${segment.text} ` : "", segment, theme),
    )
    .join("");
}

function ensureWidth(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  return truncateToWidth(line, width, "...");
}

function ansi(text: string, segment: Segment, theme: Theme): string {
  if (!USE_COLOR) return text;
  return `${theme.getFgAnsi(segment.fg)}${theme.getBgAnsi(segment.bg)}${text}${RESET}`;
}

function sanitize(text: string): string {
  /* eslint-disable no-control-regex -- Sanitizing terminal control sequences is intentional. */
  return text
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/ +/g, " ")
    .trim();
  /* eslint-enable no-control-regex */
}

function collapseHome(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)
    ? `~${path.slice(home.length)}`
    : path;
}

function fishPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized === "~" || !normalized.includes("/")) return normalized;
  const prefix = normalized.startsWith("~/")
    ? "~/"
    : normalized.startsWith("/")
      ? "/"
      : "";
  const body = normalized.replace(/^~\//, "").replace(/^\//, "");
  const parts = body.split("/").filter(Boolean);
  if (parts.length <= 1) return `${prefix}${parts.join("/")}`;
  return `${prefix}${[...parts.slice(0, -1).map((part) => part[0] ?? part), parts.at(-1) ?? basename(path)].join("/")}`;
}

function getUsage(ctx: ExtensionContext): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
} {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message") {
      if (entry.message.role === "assistant")
        addUsage(totals, (entry.message as AssistantMessage).usage);
      else if (entry.message.role === "toolResult")
        addUsage(totals, (entry.message as ToolResultMessage).usage);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(totals, entry.usage);
    }
  }
  return totals;
}

function addUsage(
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  },
  usage: Usage | undefined,
): void {
  if (!usage) return;
  totals.input += usage.input ?? 0;
  totals.output += usage.output ?? 0;
  totals.cacheRead += usage.cacheRead ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? 0;
  totals.cost += usage.cost?.total ?? 0;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 10_000) return `${(value / 1_000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function bar(ratio: number, width: number): string {
  const filled = Math.round(clamp(ratio, 0, 1) * width);
  return `${SYMBOLS.filled.repeat(filled)}${SYMBOLS.empty.repeat(Math.max(0, width - filled))}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function readGitState(cwd: string): Promise<GitState | undefined> {
  const [sha, status] = await Promise.all([
    git(["rev-parse", "--short", "HEAD"], cwd),
    git(["status", "--porcelain=v1", "--branch"], cwd),
  ]);
  if (!status) return undefined;
  const lines = status.split("\n").filter(Boolean);
  const header = lines.find((line) => line.startsWith("## "));
  if (!header) return undefined;
  const branchPart = header.slice(3);
  let branch = branchPart.split("...")[0]?.split(" ")[0]?.trim();
  if (branch === "HEAD") branch = "detached";
  return {
    branch,
    sha,
    dirtyCount: lines.filter((line) => !line.startsWith("## ")).length,
    ahead: Number.parseInt(branchPart.match(/ahead (\d+)/)?.[1] ?? "0", 10),
    behind: Number.parseInt(branchPart.match(/behind (\d+)/)?.[1] ?? "0", 10),
  };
}

function git(args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS },
      (error, stdout) => {
        resolve(error ? undefined : stdout.trim() || undefined);
      },
    );
    child.on("error", () => resolve(undefined));
  });
}
