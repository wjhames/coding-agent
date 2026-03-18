export const failureKinds = [
  "completion_false_negative",
  "completion_false_positive",
  "context_drift",
  "destructive_recovery_loop",
  "missing_deliverable",
  "resume_state_loss",
  "session_persistence_breakage",
  "summary_contamination",
  "tool_output_visibility",
  "tool_result_accounting",
  "ui_feedback_gap",
  "unsafe_repeat_side_effect",
  "verification_stale"
] as const;

export type FailureKind = (typeof failureKinds)[number];

export interface FailureRecord {
  details: string;
  kind: FailureKind;
}
