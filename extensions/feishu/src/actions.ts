import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { sendCardFeishu, sendMessageFeishu } from "./send.js";
import { sendMediaFeishu } from "./media.js";

export function createFeishuActions(providerId: string): ChannelMessageActionAdapter {
  return {
    listActions: () => ["send"],
    supportsCards: () => true,
    handleAction: async (ctx: ChannelMessageActionContext): Promise<AgentToolResult<unknown>> => {
      const { action, params: actionParams, cfg, accountId } = ctx;

      if (action === "send") {
        const to = readStringParam(actionParams, "to");
        if (!to) {
          throw new Error("Feishu send requires 'to' parameter.");
        }
        const content = readStringParam(actionParams, "message");
        const card = actionParams.card;
        const mediaUrl = readStringParam(actionParams, "media");
        const threadId = readStringParam(actionParams, "threadId");
        const replyTo = readStringParam(actionParams, "replyTo");

        if (!content && !card && !mediaUrl) {
          throw new Error("Feishu send requires message, card, or media.");
        }

        const account = resolveFeishuAccount({ cfg, accountId });

        if (card && typeof card === "object") {
          const result = await sendCardFeishu({
            cfg,
            to,
            card: card as Record<string, unknown>,
            accountId: account.accountId,
            replyToMessageId: threadId ?? replyTo ?? undefined,
          });
          return jsonResult({
            ok: true,
            messageId: result.messageId,
            chatId: result.chatId,
          });
        }

        if (mediaUrl) {
          const result = await sendMediaFeishu({
            cfg,
            to,
            mediaUrl,
            accountId: account.accountId,
            replyToMessageId: threadId ?? replyTo ?? undefined,
          });
          return jsonResult({
            ok: true,
            messageId: result.messageId,
            chatId: result.chatId,
          });
        }

        const result = await sendMessageFeishu({
          cfg,
          to,
          text: content ?? "",
          accountId: account.accountId,
          replyToMessageId: threadId ?? replyTo ?? undefined,
        });
        return jsonResult({
          ok: true,
          messageId: result.messageId,
          chatId: result.chatId,
        });
      }

      return jsonResult({ ok: false, error: `Unknown action: ${action}` });
    },
  };
}

function readStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return String(value);
  }
  return value.trim() || undefined;
}

function jsonResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}
