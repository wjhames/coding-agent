import { randomUUID } from "node:crypto";
import type { Approval } from "../cli/output.js";
import type { ResolvedExecutionConfig } from "../config/load.js";

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

export type PendingAction =
  | {
      approval: Approval;
      action: {
        operations: Array<
          | {
              newText: string;
              oldText: string;
              path: string;
              type: "replace";
            }
          | {
              content: string;
              path: string;
              type: "create";
            }
          | {
              path: string;
              type: "delete";
            }
        >;
      };
      tool: "apply_patch";
    }
  | {
      approval: Approval;
      action: {
        command: string;
        justification?: string | undefined;
      };
      tool: "run_shell";
    };

export function enforceApproval(args: {
  command?: string;
  config: ResolvedExecutionConfig;
  reason: string;
  summary: string;
  tool: "apply_patch" | "run_shell";
  action: PendingAction["action"];
  requiresApproval: boolean;
}): Approval | null {
  if (!args.requiresApproval) {
    return null;
  }

  const approval = createApproval({
    command: args.command,
    reason: args.reason,
    summary: args.summary,
    tool: args.tool
  });
  const pendingAction = {
    action: args.action,
    approval,
    tool: args.tool
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
  command?: string | undefined;
  reason: string;
  summary: string;
  tool: "apply_patch" | "run_shell";
}): Approval {
  return {
    command: args.command,
    id: randomUUID(),
    reason: args.reason,
    status: "pending",
    summary: args.summary,
    tool: args.tool
  };
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
