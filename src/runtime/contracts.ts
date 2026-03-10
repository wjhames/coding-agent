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
  summary: z.string(),
  items: z.array(planItemSchema)
});
export const repoContextSchema = z.object({
  guidanceFiles: z.array(z.string()),
  isGitRepo: z.boolean(),
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
  approval: approvalSchema,
  action: z.object({
    operations: z.array(patchOperationSchema)
  }),
  tool: z.literal("apply_patch")
});
export const pendingShellSchema = z.object({
  approval: approvalSchema,
  action: z.object({
    command: z.string(),
    justification: z.string().optional()
  }),
  tool: z.literal("run_shell")
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
export const memoryEntrySchema = z.object({
  createdAt: z.string(),
  evidence: z.array(z.string()),
  kind: z.enum(["artifact", "decision", "working"]),
  relevance: z.enum(["high", "medium", "low"]),
  summary: z.string()
});
export const memorySummarySchema = z.object({
  artifacts: z.array(memoryEntrySchema),
  decisions: z.array(memoryEntrySchema),
  working: z.array(memoryEntrySchema)
});
export const compactionSummarySchema = z.object({
  changedFilesSummary: z.string().nullable(),
  eventSummary: z.string().nullable(),
  observationSummary: z.string().nullable(),
  verificationSummary: z.string().nullable()
});
export const sessionModeSchema = z.enum(["interactive", "exec"]);
export const sessionStatusSchema = z.enum(["completed", "failed", "paused"]);
export const sessionConfigSchema = z
  .object({
    approvalPolicy: z.enum(["auto", "prompt", "never"]).optional(),
    baseUrl: z.string().url().optional(),
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
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemorySummary = z.infer<typeof memorySummarySchema>;
export type CompactionSummary = z.infer<typeof compactionSummarySchema>;
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
  compaction: CompactionSummary;
  eventCount: number;
  guidance: GuidanceSummary;
  lastEventAt: string | null;
  memory: MemorySummary;
  verification: VerificationSummary;
  exitCode: 0 | 1 | 2;
  nextActions: string[];
  observations: Observation[];
  pendingApproval: PendingApprovalInfo | null;
  plan: PlanState | null;
  repoContext: RepoContextSummary;
  resumeCommand: string | null;
  sessionId: string | null;
  status: SessionStatus;
  summary: string;
  resumedFrom?: string | null;
}

export interface CommandError {
  error: string;
  message: string;
  exitCode: 1 | 2;
  sessionId?: string | null;
}
