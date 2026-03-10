export function renderRootHelp(): string {
  return [
    "coding-agent",
    "",
    "Usage:",
    "  coding-agent [flags]",
    "  coding-agent exec [prompt] [flags]",
    "  coding-agent resume [session-id] [flags]",
    "",
    "Global flags:",
    "  -C, --cwd <DIR>",
    "  -p, --profile <PROFILE>",
    "  --json",
    "  -h, --help",
    "",
    "Execution flags:",
    "  --approval-policy <MODE>",
    "  --timeout <DURATION>",
    "  --max-steps <N>",
    "  --model <MODEL>",
    "  --base-url <URL>",
    "  --output <FILE>",
    "  --quiet",
    "  --verbose"
  ].join("\n");
}

export function renderExecHelp(): string {
  return [
    "coding-agent exec",
    "",
    "Usage:",
    "  coding-agent exec [prompt] [flags]",
    "",
    "Flags:",
    "  -C, --cwd <DIR>",
    "  -p, --profile <PROFILE>",
    "  --json",
    "  --approval-policy <MODE>",
    "  --timeout <DURATION>",
    "  --max-steps <N>",
    "  --model <MODEL>",
    "  --base-url <URL>",
    "  --output <FILE>",
    "  --quiet",
    "  --verbose",
    "  -h, --help"
  ].join("\n");
}

export function renderResumeHelp(): string {
  return [
    "coding-agent resume",
    "",
    "Usage:",
    "  coding-agent resume [session-id] [flags]",
    "",
    "Flags:",
    "  -C, --cwd <DIR>",
    "  -p, --profile <PROFILE>",
    "  --json",
    "  --output <FILE>",
    "  --quiet",
    "  --verbose",
    "  -h, --help"
  ].join("\n");
}
