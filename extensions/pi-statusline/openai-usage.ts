import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SUBSCRIPTION_API_TIMEOUT_MS = 5_000;
const MIN_SUBSCRIPTION_REFRESH_INTERVAL_MS = 10_000;

export interface RateWindow {
  label: string;
  usedPercent: number;
  resetDescription?: string | undefined;
  resetAt?: string | undefined;
}

export interface OpenAISubscriptionError {
  code: "NO_CREDENTIALS" | "FETCH_FAILED" | "HTTP_ERROR";
  httpStatus?: number;
}

interface OpenAISubscriptionSnapshot {
  windows: RateWindow[];
  error?: OpenAISubscriptionError | undefined;
}

export interface OpenAISubscriptionState {
  enabled: boolean;
  usage?: OpenAISubscriptionSnapshot | undefined;
  loading: boolean;
}

export interface OpenAISubscriptionRefreshOptions {
  force?: boolean;
  allowStaleCache?: boolean;
  resetProvider?: boolean;
}

export interface OpenAISubscriptionController {
  readonly state: OpenAISubscriptionState;
  refresh(
    ctx: ExtensionContext,
    options?: OpenAISubscriptionRefreshOptions,
  ): Promise<void>;
  clear(): void;
}

interface OpenAICredentials {
  accessToken?: string | undefined;
  accountId?: string | undefined;
}

interface OpenAIRateWindow {
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
  used_percent?: number;
}

interface OpenAIRateLimit {
  primary_window?: OpenAIRateWindow;
  secondary_window?: OpenAIRateWindow;
}

interface OpenAIAdditionalRateLimit {
  limit_name?: string;
  metered_feature?: string;
  rate_limit?: OpenAIRateLimit;
}

export function createOpenAISubscriptionController(
  onUpdate?: () => void,
): OpenAISubscriptionController {
  const state: OpenAISubscriptionState = { enabled: false, loading: false };
  let cache: OpenAISubscriptionSnapshot | undefined;
  let lastAttemptAt: number | undefined;
  let inFlight: Promise<void> | undefined;
  let queuedRefresh: Promise<void> | undefined;
  let pendingRefresh:
    | { ctx: ExtensionContext; options: OpenAISubscriptionRefreshOptions }
    | undefined;
  let sequence = 0;
  let generation = 0;

  function notify(): void {
    onUpdate?.();
  }

  async function refresh(
    ctx: ExtensionContext,
    options: OpenAISubscriptionRefreshOptions = {},
  ): Promise<void> {
    if (!shouldUseOpenAISubscription(ctx)) {
      sequence++;
      state.enabled = false;
      state.usage = undefined;
      state.loading = false;
      notify();

      return;
    }

    state.enabled = true;

    if (options.resetProvider) {
      state.usage = options.allowStaleCache ? cache : undefined;
    } else if (!state.usage && cache) {
      state.usage = cache;
    }

    state.loading = !state.usage;
    notify();

    if (inFlight) {
      sequence++;
      pendingRefresh = {
        ctx,
        options: {
          ...mergeSubscriptionRefreshOptions(pendingRefresh?.options, options),
          force: true,
        },
      };
      state.loading = !state.usage;
      notify();

      if (!queuedRefresh) {
        const queueGeneration = generation;
        queuedRefresh = inFlight.finally(async () => {
          if (generation !== queueGeneration) {
            return;
          }

          queuedRefresh = undefined;
          const pending = pendingRefresh;
          pendingRefresh = undefined;

          if (pending) {
            await refresh(pending.ctx, pending.options);
          }
        });
      }

      return queuedRefresh;
    }

    const now = Date.now();

    if (
      !options.force &&
      lastAttemptAt &&
      now - lastAttemptAt < MIN_SUBSCRIPTION_REFRESH_INTERVAL_MS
    ) {
      state.loading = false;
      notify();

      return;
    }

    const requestSequence = ++sequence;
    lastAttemptAt = now;
    state.loading = true;
    notify();

    const promise = fetchAndCommit(ctx, requestSequence).finally(() => {
      if (inFlight === promise) {
        inFlight = undefined;
      }

      if (sequence === requestSequence) {
        state.loading = false;
        notify();
      }
    });
    inFlight = promise;

    return promise;
  }

  async function fetchAndCommit(
    ctx: ExtensionContext,
    requestSequence: number,
  ): Promise<void> {
    const snapshot = await fetchOpenAISubscriptionUsage(ctx);

    if (sequence !== requestSequence) {
      return;
    }

    const displaySnapshot = withFallbackForFetchFailure(snapshot, cache);

    if (!snapshot.error) {
      cache = displaySnapshot;
    }

    state.usage = displaySnapshot;
    notify();
  }

  function clear(): void {
    sequence++;
    generation++;
    state.enabled = false;
    state.usage = undefined;
    state.loading = false;
    cache = undefined;
    lastAttemptAt = undefined;
    inFlight = undefined;
    queuedRefresh = undefined;
    pendingRefresh = undefined;
    notify();
  }

  return { state, refresh, clear };
}

export function selectOpenAIWindows(
  windows: RateWindow[],
  model?: { id?: string } | null,
): RateWindow[] {
  const prioritized = prioritizeWindowsForModel(windows, model).sort(
    (a, b) => windowPriority(a) - windowPriority(b),
  );
  const selected: RateWindow[] = [];
  const seen = new Set<string>();

  for (const window of prioritized) {
    const key = formatSubscriptionLabel(window.label);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    selected.push(window);
  }

  return selected;
}

export function formatOpenAISubscriptionWindow(
  window: RateWindow,
  showResetTime: boolean,
): string {
  const label = formatSubscriptionLabel(window.label);
  const remaining = formatSubscriptionPercent(100 - window.usedPercent);
  const reset = showResetTime ? formatWindowReset(window) : undefined;

  return `${label}-${remaining}%${reset ? ` reset ${reset}` : ""}`;
}

export function formatSubscriptionError(
  error: OpenAISubscriptionError,
): string {
  if (error.code === "HTTP_ERROR" && error.httpStatus) {
    return `HTTP ${error.httpStatus}`;
  }

  if (error.code === "NO_CREDENTIALS") {
    return "no OAuth";
  }

  return "fetch failed";
}

function mergeSubscriptionRefreshOptions(
  previous: OpenAISubscriptionRefreshOptions | undefined,
  next: OpenAISubscriptionRefreshOptions,
): OpenAISubscriptionRefreshOptions {
  return {
    force: Boolean(previous?.force || next.force),
    allowStaleCache: Boolean(previous?.allowStaleCache || next.allowStaleCache),
    resetProvider: Boolean(previous?.resetProvider || next.resetProvider),
  };
}

function shouldUseOpenAISubscription(ctx: ExtensionContext): boolean {
  const envToken = firstEnv([
    "OPENAI_CODEX_OAUTH_TOKEN",
    "OPENAI_CODEX_ACCESS_TOKEN",
    "CODEX_OAUTH_TOKEN",
    "CODEX_ACCESS_TOKEN",
  ]);
  const model = ctx.model;

  if (!model) {
    return Boolean(envToken);
  }

  const provider = model.provider?.toLowerCase() ?? "";
  const id = model.id?.toLowerCase() ?? "";

  if (
    provider.includes("openai-codex") ||
    provider.includes("codex") ||
    provider.includes("chatgpt") ||
    id.includes("codex")
  ) {
    return true;
  }

  if (
    envToken &&
    (provider.includes("openai") ||
      id.startsWith("gpt-") ||
      id.includes("openai"))
  ) {
    return true;
  }

  try {
    return provider.includes("openai") && ctx.modelRegistry.isUsingOAuth(model);
  } catch {
    return false;
  }
}

async function fetchOpenAISubscriptionUsage(
  ctx: ExtensionContext,
): Promise<OpenAISubscriptionSnapshot> {
  const { accessToken, accountId } = await loadOpenAICredentials(ctx);

  if (!accessToken) {
    return emptySubscriptionSnapshot({ code: "NO_CREDENTIALS" });
  }

  const { controller, clear } = createTimeoutController(
    SUBSCRIPTION_API_TIMEOUT_MS,
  );
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };

    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      return emptySubscriptionSnapshot({
        code: "HTTP_ERROR",
        httpStatus: res.status,
      });
    }

    const data = (await res.json()) as {
      rate_limit?: OpenAIRateLimit;
      additional_rate_limits?: OpenAIAdditionalRateLimit[];
    };
    const windows: RateWindow[] = [];
    addOpenAIRateWindows(windows, data.rate_limit);

    if (Array.isArray(data.additional_rate_limits)) {
      for (const entry of data.additional_rate_limits) {
        if (!isRecord(entry)) {
          continue;
        }

        const prefix =
          getNonEmptyString(entry.limit_name) ??
          getNonEmptyString(entry.metered_feature) ??
          "Additional";
        const rateLimit = isRecord(entry.rate_limit)
          ? (entry.rate_limit as OpenAIRateLimit)
          : undefined;
        addOpenAIRateWindows(windows, rateLimit, prefix);
      }
    }

    return { windows };
  } catch {
    return emptySubscriptionSnapshot({ code: "FETCH_FAILED" });
  } finally {
    clear();
  }
}

async function loadOpenAICredentials(
  ctx: ExtensionContext,
): Promise<OpenAICredentials> {
  const envAccessToken = firstEnv([
    "OPENAI_CODEX_OAUTH_TOKEN",
    "OPENAI_CODEX_ACCESS_TOKEN",
    "CODEX_OAUTH_TOKEN",
    "CODEX_ACCESS_TOKEN",
  ]);
  const envAccountId = firstEnv([
    "OPENAI_CODEX_ACCOUNT_ID",
    "CHATGPT_ACCOUNT_ID",
  ]);

  if (envAccessToken) {
    return {
      accessToken: envAccessToken,
      accountId:
        envAccountId ??
        loadOpenAIAccountIdFromDisk() ??
        extractAccountIdFromJwt(envAccessToken),
    };
  }

  const accessToken = await loadActiveOpenAIOAuthToken(ctx);

  return {
    accessToken,
    accountId:
      envAccountId ??
      loadOpenAIAccountIdFromDisk() ??
      (accessToken ? extractAccountIdFromJwt(accessToken) : undefined),
  };
}

async function loadActiveOpenAIOAuthToken(
  ctx: ExtensionContext,
): Promise<string | undefined> {
  if (!ctx.model) {
    return undefined;
  }

  try {
    if (!ctx.modelRegistry.isUsingOAuth(ctx.model)) {
      return undefined;
    }

    const token = await ctx.modelRegistry.getApiKeyForProvider(
      ctx.model.provider,
    );

    return token?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function loadOpenAIAccountIdFromDisk(): string | undefined {
  const piAuth = readJson(join(homedir(), ".pi", "agent", "auth.json"));
  const openAICodexEntry = isRecord(piAuth?.["openai-codex"])
    ? piAuth["openai-codex"]
    : undefined;
  const openAIEntry = isRecord(piAuth?.openai) ? piAuth.openai : undefined;
  const piAccountId =
    getRecordString(openAICodexEntry, [
      "accountId",
      "account_id",
      "chatgptAccountId",
      "chatgpt_account_id",
    ]) ??
    getRecordString(openAIEntry, [
      "accountId",
      "account_id",
      "chatgptAccountId",
      "chatgpt_account_id",
    ]);

  if (piAccountId) {
    return piAccountId;
  }

  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const codexAuth = readJson(join(codexHome, "auth.json"));
  const tokenEntry = isRecord(codexAuth?.tokens) ? codexAuth.tokens : undefined;

  return getRecordString(tokenEntry, ["account_id", "accountId"]);
}

function addOpenAIRateWindows(
  windows: RateWindow[],
  rateLimit: OpenAIRateLimit | undefined,
  prefix?: string,
): void {
  pushOpenAIWindow(windows, prefix, rateLimit?.primary_window, 18_000);
  pushOpenAIWindow(windows, prefix, rateLimit?.secondary_window, 604_800);
}

function pushOpenAIWindow(
  windows: RateWindow[],
  prefix: string | undefined,
  window: OpenAIRateWindow | undefined,
  fallbackWindowSeconds: number,
): void {
  if (!window) {
    return;
  }

  const resetDate = getOpenAIResetDate(window);
  const label = getWindowLabel(
    window.limit_window_seconds,
    fallbackWindowSeconds,
  );
  windows.push({
    label: prefix ? `${prefix} ${label}` : label,
    usedPercent: clamp(window.used_percent ?? 0, 0, 100),
    resetDescription: resetDate ? formatReset(resetDate) : undefined,
    resetAt: resetDate?.toISOString(),
  });
}

function getOpenAIResetDate(window: OpenAIRateWindow): Date | undefined {
  if (
    typeof window.reset_at === "number" &&
    Number.isFinite(window.reset_at) &&
    window.reset_at > 0
  ) {
    return new Date(window.reset_at * 1_000);
  }

  if (
    typeof window.reset_after_seconds === "number" &&
    Number.isFinite(window.reset_after_seconds) &&
    window.reset_after_seconds > 0
  ) {
    return new Date(Date.now() + window.reset_after_seconds * 1_000);
  }

  return undefined;
}

function getWindowLabel(
  windowSeconds?: number,
  fallbackWindowSeconds?: number,
): string {
  const safeWindowSeconds =
    typeof windowSeconds === "number" && windowSeconds > 0
      ? windowSeconds
      : typeof fallbackWindowSeconds === "number" && fallbackWindowSeconds > 0
        ? fallbackWindowSeconds
        : 0;

  if (!safeWindowSeconds) {
    return "0h";
  }

  const hours = Math.round(safeWindowSeconds / 3_600);

  if (hours >= 144) {
    return "Week";
  }

  if (hours >= 24) {
    return "Day";
  }

  return `${hours}h`;
}

function prioritizeWindowsForModel(
  windows: RateWindow[],
  model?: { id?: string } | null,
): RateWindow[] {
  if (!model?.id || windows.length <= 1) {
    return windows;
  }

  const modelTokens = normalizeTokens(model.id);

  if (modelTokens.length === 0) {
    return windows;
  }

  const matched: RateWindow[] = [];
  const rest: RateWindow[] = [];

  for (const window of windows) {
    const labelTokens = normalizeTokens(window.label);
    const isMatch =
      modelTokens.every((token) => labelTokens.includes(token)) &&
      modelTokens.length * 2 > labelTokens.length;

    if (isMatch) {
      matched.push(window);
    } else {
      rest.push(window);
    }
  }

  if (matched.length === 0 || matched.length === windows.length) {
    return windows;
  }

  return [...matched, ...rest];
}

function windowPriority(window: RateWindow): number {
  const label = formatSubscriptionLabel(window.label);

  if (label.endsWith("h")) {
    return 0;
  }

  if (label === "7d") {
    return 1;
  }

  if (label === "24h") {
    return 2;
  }

  return 4;
}

function formatSubscriptionLabel(label: string): string {
  const normalized = normalizeOpenAIWindowLabel(label);

  if (normalized === "Week") {
    return "7d";
  }

  if (normalized === "Day") {
    return "24h";
  }

  return normalized;
}

function normalizeOpenAIWindowLabel(label: string): string {
  const match = label.match(/(?:^| )(1h|\d+h|Day|Week)$/);

  return match?.[1] ?? label;
}

function formatWindowReset(window: RateWindow): string | undefined {
  if (window.resetAt) {
    const resetAt = new Date(window.resetAt);

    if (Number.isFinite(resetAt.getTime())) {
      return formatReset(resetAt);
    }
  }

  return window.resetDescription;
}

function formatSubscriptionPercent(value: number): string {
  return String(Math.round(clamp(value, 0, 100)));
}

function withFallbackForFetchFailure(
  snapshot: OpenAISubscriptionSnapshot,
  fallback: OpenAISubscriptionSnapshot | undefined,
): OpenAISubscriptionSnapshot {
  if (!snapshot.error) {
    return snapshot;
  }

  if (snapshot.error.code !== "NO_CREDENTIALS" && fallback?.windows.length) {
    return { ...fallback, error: snapshot.error };
  }

  return snapshot;
}

function emptySubscriptionSnapshot(
  error: OpenAISubscriptionError,
): OpenAISubscriptionSnapshot {
  return { windows: [], error };
}

function createTimeoutController(timeoutMs: number): {
  controller: AbortController;
  clear: () => void;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return { controller, clear: () => clearTimeout(timeoutId) };
}

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();

    if (value) {
      return value;
    }
  }

  return undefined;
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) {
      return undefined;
    }

    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function extractAccountIdFromJwt(token: string): string | undefined {
  const payload = decodeJwtPayload(token);

  return getRecordString(payload, [
    "account_id",
    "accountId",
    "chatgpt_account_id",
    "chatgptAccountId",
    "https://api.openai.com/auth/account_id",
    "https://api.openai.com/auth/chatgpt_account_id",
  ]);
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const payload = token.split(".")[1];

    if (!payload) {
      return undefined;
    }

    const padded = payload
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const parsed = JSON.parse(
      Buffer.from(padded, "base64").toString("utf-8"),
    ) as unknown;

    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getRecordString(record: unknown, keys: string[]): string | undefined {
  if (!isRecord(record)) {
    return undefined;
  }

  for (const key of keys) {
    const value = getNonEmptyString(record[key]);

    if (value) {
      return value;
    }
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function formatReset(date: Date): string {
  const diffMs = date.getTime() - Date.now();

  if (!Number.isFinite(diffMs) || diffMs < 0) {
    return "now";
  }

  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 60) {
    return `${diffMins}m`;
  }

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;

  if (hours < 24) {
    return mins > 0 ? `${hours}h${mins}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remHours = hours % 24;

  return remHours > 0 ? `${days}d${remHours}h` : `${days}d`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
