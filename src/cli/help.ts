export function renderRootHelp(): string {
  return [
    "coding-agent",
    "",
    "Usage:",
    "  coding-agent [flags]",
    "  coding-agent doctor [flags]",
    "  coding-agent exec [prompt] [flags]",
    "  coding-agent resume [session-id] [flags]",
    "  coding-agent sessions [flags]",
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
    "  --verbose",
    "",
    "Examples:",
    "  coding-agent exec \"fix the failing test\" --json",
    "  coding-agent resume",
    "  coding-agent sessions --json",
    "  coding-agent doctor --json"
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

export function renderDoctorHelp(): string {
  return [
    "coding-agent doctor",
    "",
    "Usage:",
    "  coding-agent doctor [flags]",
    "",
    "Flags:",
    "  -p, --profile <PROFILE>",
    "  --json",
    "  -h, --help"
  ].join("\n");
}

export function renderSessionsHelp(): string {
  return [
    "coding-agent sessions",
    "",
    "Usage:",
    "  coding-agent sessions [flags]",
    "",
    "Flags:",
    "  --json",
    "  -h, --help"
  ].join("\n");
}
