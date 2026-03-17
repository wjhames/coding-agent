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
