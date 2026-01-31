import path from "node:path";

import type { OpenClawConfig } from "../config/config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";

export function resolveMediaLocalRoots(cfg: OpenClawConfig): string[] {
  const roots = new Set<string>();
  roots.add(path.join(resolveConfigDir(), "media"));

  for (const agentId of listAgentIds(cfg)) {
    roots.add(resolveAgentWorkspaceDir(cfg, agentId));
    const sandboxRoot = resolveSandboxConfigForAgent(cfg, agentId).workspaceRoot;
    if (sandboxRoot) {
      roots.add(resolveUserPath(sandboxRoot));
    }
  }

  return Array.from(roots);
}
