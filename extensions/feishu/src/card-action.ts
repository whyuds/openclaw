import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import type { ExecApprovalDecision } from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { handleFeishuMessage, type FeishuMessageEvent } from "./bot.js";
import type { FeishuExecApprovalHandler } from "./exec-approvals.js";

export type FeishuCardActionEvent = {
  operator: {
    open_id: string;
    user_id: string;
    union_id: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag: string;
  };
  context: {
    open_id: string;
    user_id: string;
    chat_id: string;
  };
};

function parseExecApprovalValue(value: Record<string, unknown>): {
  approvalId: string;
  decision: ExecApprovalDecision;
} | null {
  const approvalId = typeof value.approvalId === "string" ? value.approvalId.trim() : null;
  const decision = typeof value.decision === "string" ? value.decision : null;

  if (!approvalId || !decision) {
    return null;
  }

  if (decision !== "allow-once" && decision !== "allow-always" && decision !== "deny") {
    return null;
  }

  return { approvalId, decision };
}

export type FeishuCardActionContext = {
  execApprovalHandler?: FeishuExecApprovalHandler;
};

export async function handleFeishuCardAction(params: {
  cfg: ClawdbotConfig;
  event: FeishuCardActionEvent;
  botOpenId?: string;
  runtime?: RuntimeEnv;
  accountId?: string;
  context?: FeishuCardActionContext;
}): Promise<void> {
  const { cfg, event, runtime, accountId, context } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  const log = runtime?.log ?? console.log;

  const actionValue = event.action.value;

  if (actionValue && typeof actionValue === "object") {
    const approvalData = parseExecApprovalValue(actionValue);
    if (approvalData && context?.execApprovalHandler) {
      const handler = context.execApprovalHandler;
      const userId = event.operator.open_id;

      if (!handler.isApprover(userId)) {
        log(
          `feishu[${account.accountId}]: unauthorized approval attempt from ${userId} for ${approvalData.approvalId}`,
        );
        return;
      }

      log(
        `feishu[${account.accountId}]: handling exec approval ${approvalData.approvalId} decision ${approvalData.decision} from ${userId}`,
      );

      await handler.resolveApproval(approvalData.approvalId, approvalData.decision);
      return;
    }
  }

  let content = "";
  if (typeof actionValue === "object" && actionValue !== null) {
    if ("text" in actionValue && typeof actionValue.text === "string") {
      content = actionValue.text;
    } else if ("command" in actionValue && typeof actionValue.command === "string") {
      content = actionValue.command;
    } else {
      content = JSON.stringify(actionValue);
    }
  } else {
    content = String(actionValue);
  }

  const messageEvent: FeishuMessageEvent = {
    sender: {
      sender_id: {
        open_id: event.operator.open_id,
        user_id: event.operator.user_id,
        union_id: event.operator.union_id,
      },
    },
    message: {
      message_id: `card-action-${event.token}`,
      chat_id: event.context.chat_id || event.operator.open_id,
      chat_type: event.context.chat_id ? "group" : "p2p",
      message_type: "text",
      content: JSON.stringify({ text: content }),
    },
  };

  log(
    `feishu[${account.accountId}]: handling card action from ${event.operator.open_id}: ${content}`,
  );

  await handleFeishuMessage({
    cfg,
    event: messageEvent,
    botOpenId: params.botOpenId,
    runtime,
    accountId,
  });
}
