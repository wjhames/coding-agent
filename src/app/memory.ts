import type {
  Approval,
  Artifact,
  MemoryEntry,
  MemorySummary,
  Observation,
  PlanState,
  VerificationSummary
} from "../runtime/contracts.js";

export function deriveMemory(args: {
  approvals: Approval[];
  artifacts: Artifact[];
  changedFiles: string[];
  observations: Observation[];
  plan: PlanState | null;
  verification: VerificationSummary;
}): MemorySummary {
  return {
    artifacts: collectArtifactMemory(args.artifacts, args.changedFiles),
    decisions: collectDecisionMemory(args.approvals, args.verification),
    working: collectWorkingMemory(args.plan, args.changedFiles, args.observations)
  };
}

function collectWorkingMemory(
  plan: PlanState | null,
  changedFiles: string[],
  observations: Observation[]
): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  if (plan) {
    entries.push(
      createMemoryEntry({
        evidence: plan.items.map((item) => `${item.status}:${item.content}`),
        kind: "working",
        relevance: "high",
        summary: `Plan: ${plan.summary}`
      })
    );
  }

  if (changedFiles.length > 0) {
    entries.push(
      createMemoryEntry({
        evidence: changedFiles,
        kind: "working",
        relevance: "high",
        summary: `Working set includes ${changedFiles.join(", ")}`
      })
    );
  }

  for (const observation of observations.slice(-4)) {
    entries.push(
      createMemoryEntry({
        evidence: [
          observation.path ?? observation.query ?? observation.tool,
          observation.summary
        ].filter(Boolean) as string[],
        kind: "working",
        relevance: observation.tool === "run_shell" ? "high" : "medium",
        summary: observation.summary
      })
    );
  }

  return dedupeMemory(entries).slice(0, 6);
}

function collectDecisionMemory(
  approvals: Approval[],
  verification: VerificationSummary
): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  for (const approval of approvals) {
    if (approval.status === "pending") {
      continue;
    }

    entries.push(
      createMemoryEntry({
        evidence: [approval.summary, approval.command ?? approval.tool].filter(Boolean) as string[],
        kind: "decision",
        relevance: "high",
        summary: `Approval ${approval.status}: ${approval.summary}`
      })
    );
  }

  for (const run of verification.runs) {
    entries.push(
      createMemoryEntry({
        evidence: [run.command, run.stdout, run.stderr].filter(Boolean),
        kind: "decision",
        relevance: run.passed ? "medium" : "high",
        summary: `Verification ${run.passed ? "passed" : "failed"}: ${run.command}`
      })
    );
  }

  return dedupeMemory(entries).slice(0, 6);
}

function collectArtifactMemory(
  artifacts: Artifact[],
  changedFiles: string[]
): MemoryEntry[] {
  const entries = [
    ...artifacts.map((artifact) =>
      createMemoryEntry({
        evidence: [artifact.path, artifact.diff.slice(0, 200)],
        kind: "artifact",
        relevance: "medium",
        summary: `Diff recorded for ${artifact.path}`
      })
    ),
    ...changedFiles.map((path) =>
      createMemoryEntry({
        evidence: [path],
        kind: "artifact",
        relevance: "medium",
        summary: `Changed file: ${path}`
      })
    )
  ];

  return dedupeMemory(entries).slice(0, 8);
}

function createMemoryEntry(input: {
  evidence: string[];
  kind: "artifact" | "decision" | "working";
  relevance: "high" | "medium" | "low";
  summary: string;
}): MemoryEntry {
  return {
    createdAt: "derived",
    evidence: input.evidence,
    kind: input.kind,
    relevance: input.relevance,
    summary: input.summary
  };
}

function dedupeMemory(entries: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const deduped: MemoryEntry[] = [];

  for (const entry of entries) {
    const key = `${entry.kind}:${entry.summary}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(entry);
  }

  return deduped;
}
