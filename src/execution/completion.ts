import type { TurnRecord } from "../runtime/contracts.js";

export function sanitizeAssistantText(value: string): string {
  const withoutToolBlocks = value
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/^<function=.*$/gim, "")
    .replace(/^<tool_call>$/gim, "")
    .replace(/^<\/tool_call>$/gim, "");

  return withoutToolBlocks
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function findCompletionFailureReason(value: string): string | null {
  const normalized = value.toLowerCase();

  if (/\bremaining tasks?\b/.test(normalized)) {
    return "Assistant reported remaining tasks.";
  }
  if (/\bstill need(?:s)? to\b/.test(normalized)) {
    return "Assistant reported unfinished work.";
  }
  if (/\btodo\b/.test(normalized)) {
    return "Assistant reported unfinished work.";
  }
  if (/\bnot yet\b/.test(normalized)) {
    return "Assistant reported unfinished work.";
  }
  if (/\bincomplete\b/.test(normalized)) {
    return "Assistant reported unfinished work.";
  }

  return null;
}

export function findLatestToolFailureReason(turns: TurnRecord[]): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];

    if (turn?.kind !== "tool_result") {
      continue;
    }

    if (turn.error && turn.tool === "run_shell" && turn.error.includes("outside the workspace")) {
      return "Shell command was blocked because it writes outside the workspace.";
    }

    if (turn.tool === "apply_patch" || turn.tool === "run_shell") {
      return null;
    }
  }

  return null;
}
