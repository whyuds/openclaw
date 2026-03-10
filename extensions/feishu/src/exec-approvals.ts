import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/feishu";
import {
  buildGatewayConnectionDetails,
  GatewayClient,
  resolveGatewayConnectionAuth,
  type EventFrame,
  type ExecApprovalDecision,
  type ExecApprovalRequest,
  type ExecApprovalResolved,
  logDebug,
  logError,
  normalizeAccountId,
  resolveAgentIdFromSessionKey,
  compileSafeRegex,
  testRegexWithBoundedInput,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  loadSessionStore,
  resolveStorePath,
} from "openclaw/plugin-sdk/feishu";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { sendCardFeishu, updateCardFeishu } from "./send.js";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

export type { ExecApprovalRequest, ExecApprovalResolved };

export type FeishuExecApprovalConfig = {
  enabled?: boolean;
  approvers?: string[];
  agentFilter?: string[];
  sessionFilter?: string[];
  cleanupAfterResolve?: boolean;
  target?: "dm" | "channel" | "both";
};

type PendingApproval = {
  messageId: string;
  chatId: string;
  timeoutId: NodeJS.Timeout;
};

function extractFeishuChatId(sessionKey?: string | null): string | null {
  if (!sessionKey) {
    return null;
  }
  const match = sessionKey.match(/feishu:(?:p2p|group):([^:]+)/);
  return match ? match[1] : null;
}

function resolveExecApprovalAccountId(params: {
  cfg: ClawdbotConfig;
  request: ExecApprovalRequest;
}): string | null {
  const sessionKey = params.request.request.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  try {
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const entry = store[sessionKey];
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const entryObj = entry as Record<string, unknown>;
    const origin = entryObj.origin as Record<string, unknown> | undefined;
    const channel = origin?.provider ?? entryObj.lastChannel;
    if (channel && channel !== "feishu") {
      return null;
    }
    const accountId = origin?.accountId ?? entryObj.lastAccountId;
    return typeof accountId === "string" && accountId.trim()
      ? accountId.trim()
      : null;
  } catch {
    return null;
  }
}

function formatCommandPreview(commandText: string, maxChars: number): string {
  const commandRaw =
    commandText.length > maxChars ? `${commandText.slice(0, maxChars)}...` : commandText;
  return commandRaw.replace(/`/g, "\\`");
}

function buildExecApprovalCard(params: {
  request: ExecApprovalRequest;
  resolved?: boolean;
  decision?: ExecApprovalDecision;
  resolvedBy?: string | null;
}): Record<string, unknown> {
  const { request, resolved, decision, resolvedBy } = params;
  const commandText = request.request.command;
  const commandPreview = formatCommandPreview(commandText, 1000);
  const expiresAtSeconds = Math.max(0, Math.floor(request.expiresAtMs / 1000));

  const elements: Record<string, unknown>[] = [];

  if (resolved && decision) {
    const decisionLabel =
      decision === "allow-once"
        ? "✅ Allowed (once)"
        : decision === "allow-always"
          ? "✅ Allowed (always)"
          : "❌ Denied";

    elements.push({
      tag: "markdown",
      content: `## Exec Approval: ${decisionLabel}`,
    });

    if (resolvedBy) {
      elements.push({
        tag: "markdown",
        content: `Resolved by: ${resolvedBy}`,
      });
    }
  } else {
    elements.push({
      tag: "markdown",
      content: "## ⚠️ Exec Approval Required",
    });
    elements.push({
      tag: "markdown",
      content: "A command needs your approval.",
    });
  }

  elements.push({
    tag: "markdown",
    content: `### Command\n\`\`\`\n${commandPreview}\n\`\`\``,
  });

  const metadataLines: string[] = [];
  if (request.request.cwd) {
    metadataLines.push(`- Working Directory: ${request.request.cwd}`);
  }
  if (request.request.host) {
    metadataLines.push(`- Host: ${request.request.host}`);
  }
  if (Array.isArray(request.request.envKeys) && request.request.envKeys.length > 0) {
    metadataLines.push(`- Env Overrides: ${request.request.envKeys.join(", ")}`);
  }
  if (request.request.agentId) {
    metadataLines.push(`- Agent: ${request.request.agentId}`);
  }

  if (metadataLines.length > 0) {
    elements.push({
      tag: "markdown",
      content: metadataLines.join("\n"),
    });
  }

  if (!resolved) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "Allow once" },
          type: "primary",
          value: { approvalId: request.id, decision: "allow-once" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "Always allow" },
          type: "primary",
          value: { approvalId: request.id, decision: "allow-always" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "Deny" },
          type: "danger",
          value: { approvalId: request.id, decision: "deny" },
        },
      ],
    });

    elements.push({
      tag: "markdown",
      content: `Expires in <at id=all></at>${expiresAtSeconds}s · ID: ${request.id}`,
    });
  } else {
    elements.push({
      tag: "markdown",
      content: `ID: ${request.id}`,
    });
  }

  return {
    config: {
      wide_screen_mode: true,
    },
    elements,
  };
}

function buildExpiredCard(params: { request: ExecApprovalRequest }): Record<string, unknown> {
  const { request } = params;
  const commandText = request.request.command;
  const commandPreview = formatCommandPreview(commandText, 500);

  return {
    config: {
      wide_screen_mode: true,
    },
    elements: [
      {
        tag: "markdown",
        content: "## ⏰ Exec Approval: Expired",
      },
      {
        tag: "markdown",
        content: "This approval request has expired.",
      },
      {
        tag: "markdown",
        content: `### Command\n\`\`\`\n${commandPreview}\n\`\`\``,
      },
      {
        tag: "markdown",
        content: `ID: ${request.id}`,
      },
    ],
  };
}

export type FeishuExecApprovalHandlerOpts = {
  account: ResolvedFeishuAccount;
  config: FeishuExecApprovalConfig;
  gatewayUrl?: string;
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
  onResolve?: (id: string, decision: ExecApprovalDecision) => Promise<void>;
};

export class FeishuExecApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private pending = new Map<string, PendingApproval>();
  private requestCache = new Map<string, ExecApprovalRequest>();
  private opts: FeishuExecApprovalHandlerOpts;
  private started = false;

  constructor(opts: FeishuExecApprovalHandlerOpts) {
    this.opts = opts;
  }

  shouldHandle(request: ExecApprovalRequest): boolean {
    const config = this.opts.config;
    if (!config.enabled) {
      return false;
    }
    if (!config.approvers || config.approvers.length === 0) {
      return false;
    }

    const requestAccountId = resolveExecApprovalAccountId({
      cfg: this.opts.cfg,
      request,
    });
    if (requestAccountId) {
      const handlerAccountId = normalizeAccountId(this.opts.account.accountId);
      if (normalizeAccountId(requestAccountId) !== handlerAccountId) {
        return false;
      }
    }

    if (config.agentFilter?.length) {
      if (!request.request.agentId) {
        return false;
      }
      if (!config.agentFilter.includes(request.request.agentId)) {
        return false;
      }
    }

    if (config.sessionFilter?.length) {
      const session = request.request.sessionKey;
      if (!session) {
        return false;
      }
      const matches = config.sessionFilter.some((p) => {
        if (session.includes(p)) {
          return true;
        }
        const regex = compileSafeRegex(p);
        return regex ? testRegexWithBoundedInput(regex, session) : false;
      });
      if (!matches) {
        return false;
      }
    }

    return true;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const config = this.opts.config;
    if (!config.enabled) {
      logDebug("feishu exec approvals: disabled");
      return;
    }

    if (!config.approvers || config.approvers.length === 0) {
      logDebug("feishu exec approvals: no approvers configured");
      return;
    }

    const { url: gatewayUrl } = buildGatewayConnectionDetails({
      config: this.opts.cfg,
      url: this.opts.gatewayUrl,
    });

    const auth = await resolveGatewayConnectionAuth({
      config: this.opts.cfg,
      env: process.env,
    });

    if (!auth.token) {
      logDebug("feishu exec approvals: no gateway token configured");
      return;
    }

    this.gatewayClient = new GatewayClient({
      url: gatewayUrl,
      token: auth.token,
      password: auth.password,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.approvals"],
      onEvent: (evt: EventFrame) => {
        this.handleGatewayEvent(evt);
      },
    });

    await this.gatewayClient.start();
    logDebug("feishu exec approvals: started");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;

    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
    }
    this.pending.clear();
    this.requestCache.clear();

    this.gatewayClient?.stop();
    this.gatewayClient = null;

    logDebug("feishu exec approvals: stopped");
  }

  private handleGatewayEvent(evt: EventFrame): void {
    if (evt.event === "exec.approval.requested") {
      const request = evt.payload as ExecApprovalRequest;
      void this.handleApprovalRequested(request);
    } else if (evt.event === "exec.approval.resolved") {
      const resolved = evt.payload as ExecApprovalResolved;
      void this.handleApprovalResolved(resolved);
    }
  }

  private async handleApprovalRequested(request: ExecApprovalRequest): Promise<void> {
    if (!this.shouldHandle(request)) {
      return;
    }

    logDebug(`feishu exec approvals: received request ${request.id}`);

    this.requestCache.set(request.id, request);

    const card = buildExecApprovalCard({ request });
    const target = this.opts.config.target ?? "dm";
    const sendToDm = target === "dm" || target === "both";
    const sendToChannel = target === "channel" || target === "both";
    let fallbackToDm = false;

    if (sendToChannel) {
      const chatId = extractFeishuChatId(request.request.sessionKey);
      if (chatId) {
        try {
          const result = await sendCardFeishu({
            cfg: this.opts.cfg,
            to: chatId,
            card,
            accountId: this.opts.account.accountId,
          });

          if (result.messageId) {
            const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
            const timeoutId = setTimeout(() => {
              void this.handleApprovalTimeout(request.id, "channel");
            }, timeoutMs);

            this.pending.set(`${request.id}:channel`, {
              messageId: result.messageId,
              chatId: result.chatId,
              timeoutId,
            });

            logDebug(`feishu exec approvals: sent approval ${request.id} to channel ${chatId}`);
          }
        } catch (err) {
          logError(`feishu exec approvals: failed to send to channel: ${String(err)}`);
        }
      } else {
        if (!sendToDm) {
          logError(
            `feishu exec approvals: target is "channel" but could not extract chat id from session key "${request.request.sessionKey ?? "(none)"}" — falling back to DM delivery for approval ${request.id}`,
          );
          fallbackToDm = true;
        } else {
          logDebug("feishu exec approvals: could not extract chat id from session key");
        }
      }
    }

    if (sendToDm || fallbackToDm) {
      const approvers = this.opts.config.approvers ?? [];

      for (const approver of approvers) {
        const userId = String(approver);
        try {
          const result = await sendCardFeishu({
            cfg: this.opts.cfg,
            to: userId,
            card,
            accountId: this.opts.account.accountId,
          });

          if (result.messageId) {
            const existingDm = this.pending.get(`${request.id}:dm`);
            if (existingDm) {
              clearTimeout(existingDm.timeoutId);
            }

            const timeoutMs = Math.max(0, request.expiresAtMs - Date.now());
            const timeoutId = setTimeout(() => {
              void this.handleApprovalTimeout(request.id, "dm");
            }, timeoutMs);

            this.pending.set(`${request.id}:dm`, {
              messageId: result.messageId,
              chatId: result.chatId,
              timeoutId,
            });

            logDebug(`feishu exec approvals: sent approval ${request.id} to user ${userId}`);
          }
        } catch (err) {
          logError(`feishu exec approvals: failed to notify user ${userId}: ${String(err)}`);
        }
      }
    }
  }

  private async handleApprovalResolved(resolved: ExecApprovalResolved): Promise<void> {
    const request = this.requestCache.get(resolved.id);
    this.requestCache.delete(resolved.id);

    if (!request) {
      return;
    }

    logDebug(`feishu exec approvals: resolved ${resolved.id} with ${resolved.decision}`);

    const card = buildExecApprovalCard({
      request,
      resolved: true,
      decision: resolved.decision,
      resolvedBy: resolved.resolvedBy,
    });

    for (const suffix of [":channel", ":dm", ""]) {
      const key = `${resolved.id}${suffix}`;
      const pending = this.pending.get(key);
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timeoutId);
      this.pending.delete(key);

      await this.finalizeMessage(pending.chatId, pending.messageId, card);
    }
  }

  private async handleApprovalTimeout(
    approvalId: string,
    source?: "channel" | "dm",
  ): Promise<void> {
    const key = source ? `${approvalId}:${source}` : approvalId;
    const pending = this.pending.get(key);
    if (!pending) {
      return;
    }

    this.pending.delete(key);

    const request = this.requestCache.get(approvalId);

    const hasOtherPending =
      this.pending.has(`${approvalId}:channel`) ||
      this.pending.has(`${approvalId}:dm`) ||
      this.pending.has(approvalId);
    if (!hasOtherPending) {
      this.requestCache.delete(approvalId);
    }

    if (!request) {
      return;
    }

    logDebug(`feishu exec approvals: timeout for ${approvalId} (${source ?? "default"})`);

    const card = buildExpiredCard({ request });
    await this.finalizeMessage(pending.chatId, pending.messageId, card);
  }

  private async finalizeMessage(
    chatId: string,
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    if (!this.opts.config.cleanupAfterResolve) {
      await this.updateMessage(messageId, card);
      return;
    }

    try {
      const account = resolveFeishuAccount({
        cfg: this.opts.cfg,
        accountId: this.opts.account.accountId,
      });
      const client = createFeishuClient(account);
      await client.im.message.delete({
        path: { message_id: messageId },
      });
    } catch (err) {
      logError(`feishu exec approvals: failed to delete message: ${String(err)}`);
      await this.updateMessage(messageId, card);
    }
  }

  private async updateMessage(
    messageId: string,
    card: Record<string, unknown>,
  ): Promise<void> {
    try {
      await updateCardFeishu({
        cfg: this.opts.cfg,
        messageId,
        card,
        accountId: this.opts.account.accountId,
      });
    } catch (err) {
      logError(`feishu exec approvals: failed to update message: ${String(err)}`);
    }
  }

  async resolveApproval(approvalId: string, decision: ExecApprovalDecision): Promise<boolean> {
    if (!this.gatewayClient) {
      logError("feishu exec approvals: gateway client not connected");
      return false;
    }

    logDebug(`feishu exec approvals: resolving ${approvalId} with ${decision}`);

    try {
      await this.gatewayClient.request("exec.approval.resolve", {
        id: approvalId,
        decision,
      });
      logDebug(`feishu exec approvals: resolved ${approvalId} successfully`);
      return true;
    } catch (err) {
      logError(`feishu exec approvals: resolve failed: ${String(err)}`);
      return false;
    }
  }

  getApprovers(): string[] {
    return this.opts.config.approvers ?? [];
  }

  isApprover(userId: string): boolean {
    const approvers = this.getApprovers();
    return approvers.some((id) => String(id) === userId);
  }

  getRequest(approvalId: string): ExecApprovalRequest | undefined {
    return this.requestCache.get(approvalId);
  }
}
