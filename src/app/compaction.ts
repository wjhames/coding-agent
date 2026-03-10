import type { CompactionSummary, VerificationSummary } from "../cli/output.js";
import type { SessionEvent } from "../session/events.js";

export function deriveCompaction(args: {
  changedFiles: string[];
  events: SessionEvent[];
  observations: Array<{ summary: string }>;
  verification: VerificationSummary;
}): CompactionSummary {
  const meaningfulEvents = args.events.filter(
    (event) => event.type !== "compaction_updated" && event.type !== "memory_updated"
  );

  return {
    changedFilesSummary:
      args.changedFiles.length > 0
        ? `Changed files: ${args.changedFiles.join(", ")}`
        : null,
    eventSummary:
      meaningfulEvents.length > 8
        ? `Recent event flow: ${meaningfulEvents
            .slice(-8)
            .map((event) => event.type)
            .join(" -> ")}`
        : null,
    observationSummary:
      args.observations.length > 6
        ? `Earlier observations: ${args.observations
            .slice(0, -4)
            .map((observation) => observation.summary)
            .join(" | ")}`
        : null,
    verificationSummary: summarizeVerification(args.verification)
  };
}

function summarizeVerification(verification: VerificationSummary): string | null {
  if (verification.runs.length === 0) {
    return null;
  }

  return verification.runs
    .map((run) => `${run.passed ? "pass" : "fail"}:${run.command}`)
    .join(" | ");
}
