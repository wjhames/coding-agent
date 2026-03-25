import { z } from "zod";

export const toolNameSchema = z.enum([
  "apply_patch",
  "list_files",
  "read_file",
  "run_shell",
  "search_files",
  "write_plan"
]);
export const observationToolSchema = z.enum([
  "apply_patch",
  "list_files",
  "read_file",
  "run_shell",
  "search_files"
]);
export const planItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.enum(["pending", "in_progress", "completed"])
});
export const planStateSchema = z.object({
  items: z.array(planItemSchema),
  summary: z.string()
});
export const repoContextSchema = z.object({
  guidanceFiles: z.array(z.string()),
  isGitRepo: z.boolean(),
  packageScripts: z.record(z.string(), z.string()).default({}),
  topLevelEntries: z.array(z.string())
});
export const observationSchema = z.object({
  excerpt: z.string(),
  path: z.string().optional(),
  query: z.string().optional(),
  summary: z.string(),
  tool: observationToolSchema
});
export const artifactSchema = z.object({
  diff: z.string(),
  kind: z.literal("diff"),
  path: z.string()
});
export const approvalSchema = z
  .object({
    actionClass: z
      .enum([
        "read_only_tool",
        "patch_write",
        "shell_dangerous",
        "shell_networked",
        "shell_read_only",
        "shell_side_effect"
      ])
      .optional(),
    command: z.string().optional(),
    id: z.string(),
    reason: z.string(),
    status: z.enum(["approved", "pending", "rejected"]),
    summary: z.string(),
    tool: z.enum(["apply_patch", "run_shell"])
  })
  .transform((value) => ({
    ...value,
    actionClass:
      value.actionClass ?? (value.tool === "apply_patch" ? "patch_write" : "shell_side_effect")
  }));
export const patchReplaceSchema = z.object({
  newText: z.string(),
  oldText: z.string(),
  path: z.string(),
  type: z.literal("replace")
});
export const patchCreateSchema = z.object({
  content: z.string(),
  path: z.string(),
  type: z.literal("create")
});
export const patchDeleteSchema = z.object({
  path: z.string(),
  type: z.literal("delete")
});
export const patchOperationSchema = z.discriminatedUnion("type", [
  patchReplaceSchema,
  patchCreateSchema,
  patchDeleteSchema
]);
export const pendingPatchSchema = z.object({
  action: z.object({
    operations: z.array(patchOperationSchema)
  }),
  approval: approvalSchema,
  tool: z.literal("apply_patch"),
  toolCallId: z.string().optional()
});
export const pendingShellSchema = z.object({
  action: z.object({
    command: z.string(),
    justification: z.string().optional()
  }),
  approval: approvalSchema,
  tool: z.literal("run_shell"),
  toolCallId: z.string().optional()
});
export const pendingActionSchema = z.union([pendingPatchSchema, pendingShellSchema]);
export const verificationRunSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  passed: z.boolean(),
  stderr: z.string(),
  stdout: z.string()
});
export const verificationSkippedSchema = z.object({
  command: z.string(),
  reason: z.string()
});
export const verificationSchema = z
  .object({
    commands: z.array(z.string()),
    inferred: z.boolean(),
    notRunReason: z.string().nullable().optional(),
    passed: z.boolean(),
    ran: z.boolean().optional(),
    runs: z.array(verificationRunSchema),
    selectedCommands: z.array(z.string()).optional(),
    skippedCommands: z.array(verificationSkippedSchema).optional(),
    status: z.enum(["failed", "not_run", "passed"]).optional()
  })
  .transform((value) => ({
    ...value,
    notRunReason: value.notRunReason ?? null,
    ran: value.ran ?? value.runs.length > 0,
    selectedCommands: value.selectedCommands ?? value.commands,
    skippedCommands: value.skippedCommands ?? [],
    status:
      value.status ??
      (value.runs.length === 0 ? "not_run" : value.passed ? "passed" : "failed")
  }));
export const guidanceSourceSchema = z.object({
  path: z.string(),
  priority: z.number().int(),
  source: z.enum(["home", "repo", "task"])
});
export const guidanceSummarySchema = z.object({
  activeRules: z.array(z.string()),
  sources: z.array(guidanceSourceSchema)
});
export const turnTextSchema = z.object({
  at: z.string(),
  id: z.string(),
  kind: z.enum(["assistant", "system_note", "user"]),
  text: z.string()
});
export const turnToolCallSchema = z.object({
  at: z.string(),
  id: z.string(),
  inputArguments: z.string().optional(),
  inputSummary: z.string(),
  kind: z.literal("tool_call"),
  tool: toolNameSchema,
  toolCallId: z.string().optional()
});
export const turnToolResultSchema = z.object({
  at: z.string(),
  changedFiles: z.array(z.string()),
  content: z.string().optional(),
  error: z.string().nullable(),
  id: z.string(),
  kind: z.literal("tool_result"),
  paths: z.array(z.string()),
  summary: z.string(),
  tool: toolNameSchema,
  toolCallId: z.string().optional()
});
export const turnRecordSchema = z.discriminatedUnion("kind", [
  turnTextSchema,
  turnToolCallSchema,
  turnToolResultSchema
]);
export const workingSetEntrySchema = z.object({
  path: z.string(),
  pinned: z.boolean(),
  reason: z.string(),
  score: z.number(),
  source: z.enum(["changed", "explicit", "guidance", "read", "search", "verification"])
});
export const contextSnippetSchema = z.object({
  endLine: z.number().int().positive(),
  excerpt: z.string(),
  path: z.string(),
  reason: z.string(),
  startLine: z.number().int().positive()
});
export const contextSectionUsageSchema = z.object({
  name: z.string(),
  tokens: z.number().int().nonnegative()
});
export const contextBudgetSchema = z.object({
  contextWindowTokens: z.number().int().positive().nullable(),
  droppedSections: z.array(z.string()),
  inputTokens: z.number().int().nonnegative(),
  outputReserveTokens: z.number().int().nonnegative(),
  remainingTokens: z.number().int().nonnegative().nullable(),
  sections: z.array(contextSectionUsageSchema),
  usedPercent: z.number().int().min(0).max(100).nullable()
});
export const contextSnapshotSchema = z.object({
  budget: contextBudgetSchema,
  historySummary: z.string().nullable(),
  recentTurnCount: z.number().int().nonnegative(),
  snippets: z.array(contextSnippetSchema),
  workingSet: z.array(workingSetEntrySchema)
});
export const executionSnapshotSchema = z.object({
  approvals: z.array(approvalSchema),
  artifacts: z.array(artifactSchema),
  changedFiles: z.array(z.string()),
  nextActions: z.array(z.string()),
  observations: z.array(observationSchema),
  pendingAction: pendingActionSchema.nullable(),
  plan: planStateSchema.nullable(),
  verification: verificationSchema
});
export const sessionModeSchema = z.enum(["interactive", "exec"]);
export const sessionStatusSchema = z.enum(["completed", "failed", "paused", "running"]);
export const sessionConfigSchema = z
  .object({
    approvalPolicy: z.enum(["auto", "prompt", "never"]).optional(),
    baseUrl: z.string().url().optional(),
    contextWindowTokens: z.number().int().positive().optional(),
    maxSteps: z.number().int().positive().optional(),
    model: z.string().optional(),
    networkEgress: z.boolean().optional(),
    profileName: z.string().optional(),
    timeout: z.string().optional()
  })
  .strict();

export type ToolName = z.infer<typeof toolNameSchema>;
export type ObservationToolName = z.infer<typeof observationToolSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type PlanState = z.infer<typeof planStateSchema>;
export type RepoContextSummary = z.infer<typeof repoContextSchema>;
export type Observation = z.infer<typeof observationSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type PatchOperation = z.infer<typeof patchOperationSchema>;
export type PendingAction = z.infer<typeof pendingActionSchema>;
export type VerificationRun = z.infer<typeof verificationRunSchema>;
export type VerificationSkipped = z.infer<typeof verificationSkippedSchema>;
export type VerificationSummary = z.infer<typeof verificationSchema>;
export type GuidanceSource = z.infer<typeof guidanceSourceSchema>;
export type GuidanceSummary = z.infer<typeof guidanceSummarySchema>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export type WorkingSetEntry = z.infer<typeof workingSetEntrySchema>;
export type ContextSnippet = z.infer<typeof contextSnippetSchema>;
export type ContextSectionUsage = z.infer<typeof contextSectionUsageSchema>;
export type ContextBudget = z.infer<typeof contextBudgetSchema>;
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;
export type ExecutionSnapshot = z.infer<typeof executionSnapshotSchema>;
export type SessionMode = z.infer<typeof sessionModeSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type SessionConfig = z.infer<typeof sessionConfigSchema>;

export interface PendingApprovalInfo {
  actionClass: Approval["actionClass"];
  command?: string | undefined;
  operationCount?: number | undefined;
  reason: string;
  summary: string;
  tool: "apply_patch" | "run_shell";
}

export interface CommandResult {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: string[];
  context: ContextSnapshot;
  exitCode: 0 | 1 | 2;
  guidance: GuidanceSummary;
  nextActions: string[];
  observations: Observation[];
  pendingApproval: PendingApprovalInfo | null;
  plan: PlanState | null;
  repoContext: RepoContextSummary;
  resumeCommand: string | null;
  resumedFrom?: string | null;
  sessionId: string | null;
  status: SessionStatus;
  summary: string;
  turnCount: number;
  verification: VerificationSummary;
}

export interface CommandError {
  error: string;
  exitCode: 1 | 2;
  message: string;
  sessionId?: string | null;
}

export type RuntimeEvent =
  | {
      at: string;
      detail?: string | undefined;
      status:
        | "completed"
        | "editing"
        | "failed"
        | "idle"
        | "paused"
        | "planning"
        | "reading"
        | "resuming"
        | "verifying";
      type: "status";
    }
  | {
      at: string;
      context: ContextSnapshot;
      type: "context_updated";
    }
  | {
      at: string;
      plan: PlanState | null;
      type: "plan_updated";
    }
  | {
      at: string;
      inputSummary: string;
      tool: ToolName;
      type: "tool_called";
    }
  | {
      artifacts?: Artifact[] | undefined;
      at: string;
      changedFiles?: string[] | undefined;
      error?: string | undefined;
      observation?: Observation | undefined;
      tool: ToolName;
      type: "tool_result";
    }
  | {
      approval: Approval;
      at: string;
      pendingAction: PendingAction;
      type: "approval_requested";
    }
  | {
      approvalId: string;
      at: string;
      status: "approved" | "rejected";
      type: "approval_resolved";
    }
  | {
      at: string;
      commands: string[];
      type: "verification_started";
    }
  | {
      at: string;
      type: "verification_completed";
      verification: VerificationSummary;
    }
  | {
      at: string;
      delta: string;
      type: "assistant_delta";
    }
  | {
      at: string;
      text: string;
      type: "assistant_message";
    }
  | {
      at: string;
      result: CommandResult;
      type: "run_finished";
    };

export interface RuntimeObserver {
  onEvent: (event: RuntimeEvent) => void;
}
