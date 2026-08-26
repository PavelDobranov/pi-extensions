import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIG_FILE_NAME = "pi-statusline.json";

export type SectionName =
  "cwd" | "git" | "session" | "subscription" | "status" | "context" | "model";

export interface StatuslineConfig {
  left: SectionName[];
  right: SectionName[];
  openaiSubscription: {
    enabled: boolean;
    showResetTimes: boolean;
  };
}

interface StatuslineConfigOverride {
  left?: SectionName[];
  right?: SectionName[];
  openaiSubscription?: {
    enabled?: boolean;
    showResetTimes?: boolean;
  };
}

export const DEFAULT_CONFIG: StatuslineConfig = {
  left: ["cwd", "git", "session", "status"],
  right: ["context", "model"],
  openaiSubscription: { enabled: false, showResetTimes: false },
};

const VALID_SECTIONS = new Set<SectionName>([
  "cwd",
  "git",
  "session",
  "subscription",
  "status",
  "context",
  "model",
]);

export function loadStatuslineConfig(ctx: ExtensionContext): StatuslineConfig {
  let config = applyConfigOverride(
    DEFAULT_CONFIG,
    readStatuslineConfigOverride(getGlobalConfigPath()),
  );

  if (ctx.isProjectTrusted()) {
    config = applyConfigOverride(
      config,
      readStatuslineConfigOverride(getProjectConfigPath(ctx.cwd)),
    );
  }

  return config;
}

export function configEnablesOpenAISubscription(
  config: StatuslineConfig,
): boolean {
  return (
    config.openaiSubscription.enabled &&
    (config.left.includes("subscription") ||
      config.right.includes("subscription"))
  );
}

function getGlobalConfigPath(): string {
  return join(getAgentDir(), CONFIG_FILE_NAME);
}

function getProjectConfigPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

function readStatuslineConfigOverride(
  path: string,
): StatuslineConfigOverride | undefined {
  try {
    if (!existsSync(path)) {
      return undefined;
    }

    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;

    if (!isRecord(parsed)) {
      return undefined;
    }

    const left = readSectionList(parsed.left);
    const right = readSectionList(parsed.right);
    const openaiSubscription = readOpenAISubscriptionOverride(
      parsed.openaiSubscription,
    );

    return {
      ...(left ? { left } : {}),
      ...(right ? { right } : {}),
      ...(openaiSubscription ? { openaiSubscription } : {}),
    };
  } catch {
    return undefined;
  }
}

function readSectionList(value: unknown): SectionName[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const sections: SectionName[] = [];
  const seen = new Set<SectionName>();

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const section = item.trim() as SectionName;

    if (!VALID_SECTIONS.has(section) || seen.has(section)) {
      continue;
    }

    seen.add(section);
    sections.push(section);
  }

  return sections;
}

function readOpenAISubscriptionOverride(
  value: unknown,
): StatuslineConfigOverride["openaiSubscription"] {
  if (typeof value === "boolean") {
    return { enabled: value };
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const override: NonNullable<StatuslineConfigOverride["openaiSubscription"]> =
    {};

  if (typeof value.enabled === "boolean") {
    override.enabled = value.enabled;
  }

  if (typeof value.showResetTimes === "boolean") {
    override.showResetTimes = value.showResetTimes;
  }

  return Object.keys(override).length > 0 ? override : undefined;
}

function applyConfigOverride(
  base: StatuslineConfig,
  override: StatuslineConfigOverride | undefined,
): StatuslineConfig {
  if (!override) {
    return cloneConfig(base);
  }

  return {
    left: override.left ? [...override.left] : [...base.left],
    right: override.right ? [...override.right] : [...base.right],
    openaiSubscription: {
      enabled:
        override.openaiSubscription?.enabled ?? base.openaiSubscription.enabled,
      showResetTimes:
        override.openaiSubscription?.showResetTimes ??
        base.openaiSubscription.showResetTimes,
    },
  };
}

function cloneConfig(config: StatuslineConfig): StatuslineConfig {
  return {
    left: [...config.left],
    right: [...config.right],
    openaiSubscription: { ...config.openaiSubscription },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
