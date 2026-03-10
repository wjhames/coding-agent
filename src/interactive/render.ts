import type { InteractiveState, TranscriptEntry } from "./state.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const INVERSE = "\x1b[7m";

export function renderInteractiveScreen(args: {
  columns: number;
  rows: number;
  state: InteractiveState;
}): string {
  const width = Math.max(args.columns, 80);
  const height = Math.max(args.rows, 24);
  const headerLines = renderHeader(args.state, width);
  const footerLines = renderFooter(args.state, width);
  const availableHeight = Math.max(8, height - headerLines.length - footerLines.length);
  const sideBySide = width >= 110;
  const sideWidth = sideBySide ? 38 : width;
  const mainWidth = sideBySide ? width - sideWidth - 1 : width;
  const mainHeight = sideBySide ? availableHeight : Math.max(8, availableHeight - 10);
  const sideHeight = availableHeight - mainHeight;
  const transcriptLines = renderTranscript(args.state, mainWidth, mainHeight);
  const sidebarLines = renderSidebar(args.state, sideWidth, sideBySide ? availableHeight : sideHeight);

  const bodyLines = sideBySide
    ? joinColumns(transcriptLines, sidebarLines, mainWidth, sideWidth)
    : [...transcriptLines, ...padLines(sidebarLines, sideHeight, sideWidth)];

  const screen = [...headerLines, ...bodyLines, ...footerLines];
  const finalLines = screen.slice(0, height);

  if (args.state.mode === "details") {
    return overlayDetails({
      baseLines: padLines(finalLines, height, width),
      state: args.state,
      width
    }).join("\n");
  }

  return padLines(finalLines, height, width).join("\n");
}

function renderHeader(state: InteractiveState, width: number): string[] {
  const sessionLabel = state.sessionId ?? "pending";
  const model = state.doctor?.model ?? "unknown";
  const profile = state.profileName ?? state.doctor?.defaultProfile ?? "default";
  const line1 = `${BOLD}coding-agent${RESET}  ${DIM}${state.cwd}${RESET}`;
  const line2 = [
    `session:${sessionLabel}`,
    `profile:${profile}`,
    `model:${model}`,
    `status:${statusColor(state.runtimeStatus)}${state.runtimeStatus}${RESET}`
  ].join("  ");

  return [truncateAnsi(line1, width), truncateAnsi(line2, width), "-".repeat(width)];
}

function renderFooter(state: InteractiveState, width: number): string[] {
  const hints =
    state.mode === "approval"
      ? "Up/Down choose  Enter confirm  Esc cancel details"
      : "Enter submit/resume  Tab focus  Up/Down navigate  d details  a/p/v jump  Ctrl+C quit";
  const message = state.footerMessage ?? hints;
  const prompt =
    state.mode === "running"
      ? `${DIM}Running... tool activity will appear above.${RESET}`
      : `> ${state.input || ""}`;

  return ["-".repeat(width), truncateAnsi(message, width), truncateAnsi(prompt, width)];
}

function renderTranscript(state: InteractiveState, width: number, height: number): string[] {
  const lines: string[] = [];
  const entries = state.transcript;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const selected = state.focus === "transcript" && index === state.selectedTranscriptIndex;
    const prefix = selected ? `${INVERSE}>${RESET} ` : "  ";
    const title = `${entryTitleColor(entry.kind)}${entry.title}${RESET}`;
    const wrappedBody = wrapText(entry.body, width - 4);
    lines.push(truncateAnsi(`${prefix}${title}`, width));
    for (const line of wrappedBody.slice(0, 4)) {
      lines.push(truncateAnsi(`    ${line}`, width));
    }
  }

  return trimFromEnd(lines, height, width);
}

function renderSidebar(state: InteractiveState, width: number, height: number): string[] {
  const sections = [
    renderSection(
      state,
      "plan",
      "Plan",
      state.plan
        ? state.plan.items.map((item) => `[${item.status}] ${item.content}`)
        : ["No plan yet."]
    ),
    renderSection(
      state,
      "working",
      "Working Set",
      state.changedFiles.length > 0 ? state.changedFiles : ["No changed files."]
    ),
    renderSection(
      state,
      "verification",
      "Verification",
      state.verification
        ? [
            `status: ${state.verification.status}`,
            ...state.verification.selectedCommands.map((command) => `run: ${command}`),
            ...state.verification.skippedCommands.map(
              (item) => `skip: ${item.command} (${item.reason})`
            )
          ]
        : ["No verification yet."]
    ),
    renderSection(
      state,
      "approval",
      "Pending Approval",
      state.pendingApproval
        ? [
            `tool: ${state.pendingApproval.tool}`,
            `class: ${state.pendingApproval.actionClass}`,
            state.pendingApproval.command
              ? `cmd: ${state.pendingApproval.command}`
              : `ops: ${state.pendingApproval.operationCount ?? 0}`,
            state.pendingApproval.summary,
            state.mode === "approval"
              ? `${state.approvalChoiceIndex === 0 ? ">" : " "} Approve once`
              : "  Approve once",
            state.mode === "approval"
              ? `${state.approvalChoiceIndex === 1 ? ">" : " "} Deny`
              : "  Deny"
          ]
        : ["No approval pending."]
    ),
    renderSection(
      state,
      "sessions",
      "Recent Sessions",
      state.recentSessions.length > 0
        ? state.recentSessions.slice(0, 5).map((session, index) =>
            `${state.focus === "input" && state.input.length === 0 && index === state.selectedSessionIndex ? ">" : " "} ${session.id.slice(0, 8)} ${session.status}`
          )
        : ["No recent sessions."]
    )
  ];

  return trimFromEnd(sections.flat(), height, width);
}

function renderSection(
  state: InteractiveState,
  section: InteractiveState["selectedSidebarSection"],
  title: string,
  lines: string[]
): string[] {
  const heading =
    state.selectedSidebarSection === section
      ? `${INVERSE}${title}${RESET}`
      : `${BOLD}${title}${RESET}`;
  return [
    heading,
    ...lines.flatMap((line) => wrapText(line, 36).map((wrapped) => `  ${wrapped}`)),
    ""
  ];
}

function overlayDetails(args: {
  baseLines: string[];
  state: InteractiveState;
  width: number;
}): string[] {
  const entry = args.state.transcript[args.state.selectedTranscriptIndex];
  const body = entry?.detail ?? entry?.body ?? "No details.";
  const overlayWidth = Math.max(40, Math.floor(args.width * 0.75));
  const left = Math.max(0, Math.floor((args.width - overlayWidth) / 2));
  const boxHeight = Math.min(12, args.baseLines.length - 4);
  const top = Math.max(2, args.baseLines.length - boxHeight - 3);
  const wrapped = wrapText(body, overlayWidth - 4);
  const visible = wrapped.slice(args.state.detailScroll, args.state.detailScroll + boxHeight - 3);
  const box = [
    `${BOLD}Details${RESET}`,
    ...visible,
    `${DIM}Esc close  Up/Down scroll${RESET}`
  ];

  for (let row = 0; row < boxHeight; row += 1) {
    const content = box[row] ?? "";
    const line = `${" ".repeat(left)}${INVERSE}${padRight(content, overlayWidth)}${RESET}`;
    args.baseLines[top + row] = line;
  }

  return args.baseLines;
}

function joinColumns(left: string[], right: string[], leftWidth: number, rightWidth: number): string[] {
  const height = Math.max(left.length, right.length);
  const lines: string[] = [];

  for (let index = 0; index < height; index += 1) {
    lines.push(
      `${padRight(left[index] ?? "", leftWidth)} ${padRight(right[index] ?? "", rightWidth)}`
    );
  }

  return lines;
}

function trimFromEnd(lines: string[], height: number, width: number): string[] {
  return padLines(lines.slice(Math.max(0, lines.length - height)), height, width);
}

function padLines(lines: string[], height: number, width: number): string[] {
  return [...lines, ...Array.from({ length: Math.max(0, height - lines.length) }, () => "".padEnd(width, " "))];
}

function wrapText(text: string, width: number): string[] {
  const lines = text.split("\n");
  const output: string[] = [];

  for (const line of lines) {
    if (line.length <= width) {
      output.push(line);
      continue;
    }

    let remaining = line;
    while (remaining.length > width) {
      output.push(remaining.slice(0, width));
      remaining = remaining.slice(width);
    }
    if (remaining.length > 0) {
      output.push(remaining);
    }
  }

  return output;
}

function padRight(text: string, width: number): string {
  const rawLength = stripAnsi(text).length;
  if (rawLength >= width) {
    return truncateAnsi(text, width);
  }
  return `${text}${" ".repeat(width - rawLength)}`;
}

function truncateAnsi(text: string, width: number): string {
  const raw = stripAnsi(text);
  if (raw.length <= width) {
    return text;
  }
  return raw.slice(0, Math.max(0, width - 3)) + "...";
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function entryTitleColor(kind: TranscriptEntry["kind"]): string {
  switch (kind) {
    case "assistant":
      return GREEN;
    case "approval":
      return YELLOW;
    case "plan":
      return CYAN;
    case "verification":
      return YELLOW;
    case "status":
      return DIM;
    case "tool":
      return CYAN;
    case "user":
      return BOLD;
    case "system":
      return DIM;
  }
}

function statusColor(status: InteractiveState["runtimeStatus"]): string {
  if (status === "completed") {
    return GREEN;
  }
  if (status === "failed" || status === "paused") {
    return RED;
  }
  if (status === "verifying") {
    return YELLOW;
  }
  return CYAN;
}
