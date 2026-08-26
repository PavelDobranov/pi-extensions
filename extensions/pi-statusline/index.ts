import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  configEnablesOpenAISubscription,
  loadStatuslineConfig,
} from "./config.ts";
import { PiStatuslineFooter } from "./footer.ts";
import {
  createOpenAISubscriptionController,
  type OpenAISubscriptionRefreshOptions,
} from "./openai-usage.ts";

/**
 * Statusline footer.
 *
 * Rendering is handled by footer.ts, configuration by config.ts, and the optional
 * OpenAI subscription integration by openai-usage.ts.
 */

const SUBSCRIPTION_REFRESH_TIMER_MS = 60_000;

export default function piStatusline(pi: ExtensionAPI): void {
  let footer: PiStatuslineFooter | undefined;
  let subscriptionTimer: ReturnType<typeof setInterval> | undefined;
  const subscription = createOpenAISubscriptionController(requestRender);

  function install(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
      return;
    }
    ctx.ui.setFooter((tui, theme, footerData) => {
      footer = new PiStatuslineFooter(
        pi,
        ctx,
        tui,
        theme,
        footerData,
        subscription.state,
      );

      return footer;
    });
  }

  function requestRender(): void {
    footer?.invalidate();
  }

  function refreshGit(): void {
    footer?.refreshGit();
  }

  function isSubscriptionRefreshEnabled(ctx: ExtensionContext): boolean {
    if (ctx.mode !== "tui") {
      return false;
    }

    return (
      footer?.isOpenAISubscriptionEnabled() ??
      configEnablesOpenAISubscription(loadStatuslineConfig(ctx))
    );
  }

  function refreshSubscription(
    ctx: ExtensionContext,
    options?: OpenAISubscriptionRefreshOptions,
  ): void {
    if (!isSubscriptionRefreshEnabled(ctx)) {
      clearSubscriptionTimer();
      subscription.clear();

      return;
    }
    void subscription.refresh(ctx, options).catch(() => requestRender());
  }

  function startSubscriptionTimer(ctx: ExtensionContext): void {
    clearSubscriptionTimer();

    if (!isSubscriptionRefreshEnabled(ctx)) {
      return;
    }
    subscriptionTimer = setInterval(
      () => refreshSubscription(ctx),
      SUBSCRIPTION_REFRESH_TIMER_MS,
    );
  }

  function clearSubscriptionTimer(): void {
    if (!subscriptionTimer) {
      return;
    }
    clearInterval(subscriptionTimer);
    subscriptionTimer = undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    install(ctx);
    startSubscriptionTimer(ctx);
    refreshSubscription(ctx, { allowStaleCache: true });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearSubscriptionTimer();
    subscription.clear();

    if (ctx.mode === "tui") {
      ctx.ui.setFooter(undefined);
    }
    footer = undefined;
  });

  pi.on("turn_end", async (_event, ctx) => {
    refreshSubscription(ctx);
    refreshGit();
    requestRender();
  });
  pi.on("tool_execution_end", async () => {
    refreshGit();
    requestRender();
  });
  pi.on("message_end", async () => requestRender());
  pi.on("model_select", async (_event, ctx) => {
    refreshSubscription(ctx, { force: true, resetProvider: true });
    requestRender();
  });
  pi.on("thinking_level_select", async () => requestRender());
  pi.on("session_compact", async () => requestRender());
  pi.on("session_tree", async () => requestRender());

  pi.registerCommand("pi-statusline", {
    description: "Refresh the project-local statusline footer config",
    handler: async (args, ctx) => {
      const command = args.trim();

      if (command !== "refresh") {
        ctx.ui.notify("Usage: /pi-statusline refresh", "warning");

        return;
      }

      if (!footer && ctx.mode === "tui") {
        install(ctx);
      }
      footer?.reloadConfig();

      if (isSubscriptionRefreshEnabled(ctx)) {
        startSubscriptionTimer(ctx);
        refreshSubscription(ctx, { force: true, allowStaleCache: true });
      } else {
        clearSubscriptionTimer();
        subscription.clear();
      }
      requestRender();
      ctx.ui.notify("pi-statusline refreshed.", "info");
    },
  });
}
