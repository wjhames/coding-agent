import type { InteractiveState, TranscriptEntry } from "./state.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const USER_BG = "\x1b[48;5;236m";
const USER_FG = "\x1b[38;5;255m";
const DETAIL_BG = "\x1b[48;5;235m";

export function renderInteractiveScreen(args: {
  columns: number;
  rows: number;
  state: InteractiveState;
}): string {
  const width = Math.max(args.columns, 80);
  const height = Math.max(args.rows, 20);
  const footer = renderFooter(args.state, width);
  const transcriptHeight = Math.max(6, height - footer.length);
  const transcript = renderTranscript(args.state, width, transcriptHeight);
  const screen = [...transcript, ...footer];

  if (args.state.mode === "details") {
    return overlayDetails(padToHeight(screen, height, width), args.state, width).join("\n");
  }

  return padToHeight(screen, height, width).join("\n");
}

function renderTranscript(state: InteractiveState, width: number, height: number): string[] {
  const blocks = state.transcript.flatMap((entry, index) =>
    renderEntry(entry, {
      selected: index === state.selectedTranscriptIndex,
      width
    })
  );
  const maxStart = Math.max(0, blocks.length - height);
  const start = Math.max(0, maxStart - state.transcriptScroll);
  return padToHeight(blocks.slice(start, start + height), height, width);
}

function renderEntry(
  entry: TranscriptEntry,
  args: {
    selected: boolean;
    width: number;
  }
): string[] {
  const bodyWidth = args.width - 2;
  const lines = wrapText(entry.body, bodyWidth);

  if (entry.kind === "user") {
    return lines.map((line) => colorBlock(` ${padText(line, bodyWidth)} `, `${USER_BG}${USER_FG}`));
  }

  const prefix = entryPrefix(entry.kind, args.selected);
  const wrapped = lines.map((line, index) => {
    const lead = index === 0 ? prefix : "  ";
    return truncateAnsi(`${lead}${line}`, args.width);
  });

  return wrapped;
}

function renderFooter(state: InteractiveState, width: number): string[] {
  const inputLine =
    state.mode === "running"
      ? `${DIM}>${RESET} ${state.input.length > 0 ? state.input : ""}`
      : `> ${state.input}`;
  const statusBits = [
    `status:${statusColor(state.runtimeStatus)}${state.runtimeStatus}${RESET}`,
    state.profileName ? `profile:${state.profileName}` : null,
    state.doctor?.model ? `model:${state.doctor.model}` : null,
    state.currentRun ? "agent:active" : "agent:ready",
    state.transcriptScroll > 0 ? `scroll:+${state.transcriptScroll}` : null
  ].filter(Boolean);
  const hintLine =
    state.mode === "approval"
      ? "Up/Down choose  Enter confirm  Esc cancel"
      : "Enter submit  Up/Down scroll  d details  Ctrl+C quit";

  return [
    "-".repeat(width),
    truncateAnsi(inputLine, width),
    truncateAnsi(`${DIM}${statusBits.join("  ")}${RESET}`, width),
    truncateAnsi(state.footerMessage ?? hintLine, width)
  ];
}

function overlayDetails(baseLines: string[], state: InteractiveState, width: number): string[] {
  const entry = state.transcript[state.selectedTranscriptIndex];
  const detail = entry?.detail ?? entry?.body ?? "No details.";
  const overlayWidth = Math.max(48, Math.floor(width * 0.8));
  const overlayHeight = Math.min(16, baseLines.length - 4);
  const left = Math.floor((width - overlayWidth) / 2);
  const top = Math.max(1, Math.floor((baseLines.length - overlayHeight) / 2));
  const body = wrapText(detail, overlayWidth - 4).slice(
    state.detailScroll,
    state.detailScroll + overlayHeight - 3
  );
  const lines = [
    `${BOLD}Details${RESET}`,
    ...body,
    `${DIM}Esc close  Up/Down scroll${RESET}`
  ];

  for (let index = 0; index < overlayHeight; index += 1) {
    const content = lines[index] ?? "";
    baseLines[top + index] = `${" ".repeat(left)}${colorBlock(padText(content, overlayWidth), DETAIL_BG)}`;
  }

  return baseLines;
}

function entryPrefix(kind: TranscriptEntry["kind"], _selected: boolean): string {
  const marker = " ";
  switch (kind) {
    case "assistant":
      return `${marker} `;
    case "approval":
      return `${marker}${YELLOW}!${RESET} `;
    case "plan":
      return `${marker}${CYAN}~${RESET} `;
    case "status":
      return `${marker}${DIM}.${RESET} `;
    case "system":
      return `${marker}${DIM}:${RESET} `;
    case "tool":
      return `${marker}${CYAN}>${RESET} `;
    case "verification":
      return `${marker}${YELLOW}*${RESET} `;
    case "user":
      return `${marker} `;
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

function wrapText(text: string, width: number): string[] {
  const source = text.length > 0 ? text : " ";
  const lines = source.split("\n");
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
    output.push(remaining);
  }

  return output;
}

function padText(text: string, width: number): string {
  const raw = stripAnsi(text);
  if (raw.length >= width) {
    return truncateAnsi(text, width);
  }
  return `${text}${" ".repeat(width - raw.length)}`;
}

function colorBlock(text: string, color: string): string {
  return `${color}${text}${RESET}`;
}

function padToHeight(lines: string[], height: number, width: number): string[] {
  return [
    ...lines,
    ...Array.from({ length: Math.max(0, height - lines.length) }, () => "".padEnd(width, " "))
  ];
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
