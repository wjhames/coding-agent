import { randomUUID } from "node:crypto";
import type { Approval, PatchOperation, PendingAction } from "../runtime/contracts.js";
import type { ResolvedExecutionConfig } from "../config/load.js";

export type { PendingAction } from "../runtime/contracts.js";

export class ApprovalRequiredError extends Error {
  constructor(
    public readonly approval: Approval,
    public readonly action: PendingAction
  ) {
    super(approval.summary);
  }
}

export class ApprovalDeniedError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function enforceApproval(args: {
  actionClass: Approval["actionClass"];
  command?: string;
  config: ResolvedExecutionConfig;
  reason: string;
  summary: string;
  tool: "apply_patch" | "run_shell";
  action: PendingAction["action"];
  requiresApproval: boolean;
  toolCallId?: string | undefined;
}): Approval | null {
  if (!args.requiresApproval) {
    return null;
  }

  const approval = createApproval({
    actionClass: args.actionClass,
    command: args.command,
    reason: args.reason,
    summary: args.summary,
    tool: args.tool
  });
  const pendingAction = {
    action: args.action,
    approval,
    tool: args.tool,
    ...(args.toolCallId ? { toolCallId: args.toolCallId } : {})
  } as PendingAction;

  if (args.config.approvalPolicy === "never") {
    throw new ApprovalDeniedError(args.summary);
  }

  if (args.config.approvalPolicy === "prompt") {
    throw new ApprovalRequiredError(approval, pendingAction);
  }

  return {
    ...approval,
    status: "approved"
  };
}

export function createApproval(args: {
  actionClass: Approval["actionClass"];
  command?: string | undefined;
  reason: string;
  summary: string;
  tool: "apply_patch" | "run_shell";
}): Approval {
  return {
    actionClass: args.actionClass,
    command: args.command,
    id: randomUUID(),
    reason: args.reason,
    status: "pending",
    summary: args.summary,
    tool: args.tool
  };
}

export function classifyPatchAction(
  operations: PatchOperation[]
): Approval["actionClass"] {
  return operations.length > 0 ? "patch_write" : "read_only_tool";
}

export function classifyShellCommand(command: string): Approval["actionClass"] {
  if (isShellCommandDangerous(command)) {
    return "shell_dangerous";
  }

  if (isShellCommandNetworked(command)) {
    return "shell_networked";
  }

  return isShellCommandReadOnly(command) ? "shell_read_only" : "shell_side_effect";
}

export function isShellCommandDangerous(command: string): boolean {
  const lowered = command.toLowerCase();
  return [
    " rm ",
    " rm -",
    "git reset",
    "git clean",
    "chmod ",
    "chown ",
    "mkfs",
    "dd ",
    ":(){"
  ].some((token) => lowered.includes(token)) || lowered.startsWith("rm ");
}

export function isShellCommandNetworked(command: string): boolean {
  const lowered = command.toLowerCase();
  return ["curl ", "wget ", "npm install", "pnpm add", "yarn add", "pip install"].some(
    (token) => lowered.includes(token)
  );
}

export function isShellCommandReadOnly(command: string): boolean {
  const lowered = normalizeShellCommand(command);
  return [
    /^git status(?:\s|$)/,
    /^git diff(?:\s|$)/,
    /^pwd(?:\s|$)/,
    /^ls(?:\s|$)/,
    /^find(?:\s|$)/,
    /^rg(?:\s|$)/,
    /^cat(?:\s|$)/,
    /^sed\s+-n(?:\s|$)/,
    /^head(?:\s|$)/,
    /^tail(?:\s|$)/,
    /^wc(?:\s|$)/,
    /^stat(?:\s|$)/
  ].some((pattern) => pattern.test(lowered));
}

export function normalizeShellCommand(command: string): string {
  let normalized = command.trim();

  while (true) {
    const next = normalized
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "")
      .replace(/^set\s+-[A-Za-z]+\s*&&\s*/, "")
      .replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*/, "")
      .trim();

    if (next === normalized) {
      break;
    }

    normalized = next;
  }

  const primarySegment = normalized.split("|")[0]?.trim() ?? normalized;
  return primarySegment.replace(/\s+2>&1$/, "").trim().toLowerCase();
}
