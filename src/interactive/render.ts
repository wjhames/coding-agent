import {
  renderFinalMarkdown,
  renderStreamingMarkdown,
  type MarkdownRenderLine as RenderLine
} from "./markdown.js";
import type { PendingApprovalInfo } from "../runtime/contracts.js";
import type { BlockTone, InteractiveModel, TranscriptBlock } from "./state.js";

const CONTEXT_BUDGET_CHARS = 18_000;
const BLANK_RENDER_LINE = " ";
const LIVE_EDGE_BOTTOM_ALIGN_THRESHOLD = 0.75;

export function buildViewportLines(args: {
  columns: number;
  model: InteractiveModel;
  rows: number;
}): RenderLine[] {
  const width = Math.max(40, args.columns);
  const full = buildFullRenderLines(args.model, width);
  const visibleHeight = Math.max(6, args.rows);
  const start = Math.max(0, full.length - visibleHeight - args.model.scrollOffset);
  const end = Math.min(full.length, start + visibleHeight);
  const viewport = full.slice(start, end);
  const shouldBottomAlign =
    viewport.length < visibleHeight &&
    args.model.blocks.length > 0 &&
    args.model.scrollOffset === 0 &&
    full.length >= Math.ceil(visibleHeight * LIVE_EDGE_BOTTOM_ALIGN_THRESHOLD);

  return shouldBottomAlign
    ? padViewportTop(viewport, visibleHeight)
    : viewport;
}

export function reconcileViewportScroll(
  current: InteractiveModel,
  next: InteractiveModel,
  columns: number
): InteractiveModel {
  if (current.scrollOffset === 0 || next.scrollOffset !== current.scrollOffset) {
    return next;
  }

  const width = Math.max(40, columns);
  const delta = buildFullRenderLines(next, width).length - buildFullRenderLines(current, width).length;
  if (delta <= 0) {
    return next;
  }

  return {
    ...next,
    scrollOffset: current.scrollOffset + delta
  };
}

export function estimateContextLeftPercent(state: InteractiveModel): number {
  const used = [
    state.blocks.flatMap((block) => block.lines).join("\n"),
    state.input,
    state.plan?.summary ?? "",
    state.verification?.runs.map((run) => run.command).join("\n") ?? ""
  ].join("\n").length;

  return Math.max(1, Math.min(99, Math.round((1 - used / CONTEXT_BUDGET_CHARS) * 100)));
}

function buildFullRenderLines(model: InteractiveModel, width: number): RenderLine[] {
  const transcriptLines = compactBlankLines(renderTranscriptBlocks(model, width));
  const liveStatusLines = renderLiveStatus(model, width);
  const composerLines = renderComposer(
    model,
    width,
    transcriptLines.length > 0 || liveStatusLines.length > 0
  );
  return [...transcriptLines, ...liveStatusLines, ...composerLines];
}

function renderTranscriptBlocks(model: InteractiveModel, width: number): RenderLine[] {
  const rendered: RenderLine[] = [];

  model.blocks.forEach((block, index) => {
    const previous = index > 0 ? model.blocks[index - 1] : null;
    if (previous && shouldInsertPhaseSeparator(previous, block)) {
      rendered.push(
        {
          dimColor: true,
          text: "─".repeat(Math.max(18, Math.min(width, 56)))
        },
        { text: BLANK_RENDER_LINE }
      );
    }

    rendered.push(
      ...renderBlock(block, {
        approvalChoiceIndex: model.approvalChoiceIndex,
        pendingApproval: model.pendingApproval,
        width
      })
    );
  });

  return rendered;
}

function renderBlock(
  block: TranscriptBlock,
  args: {
    approvalChoiceIndex: number;
    pendingApproval: PendingApprovalInfo | null;
    width: number;
  }
): RenderLine[] {
  if (block.kind === "user") {
    return [
      ...wrapForRender(block.lines.join("\n"), args.width - 4).map((line) => ({
        backgroundColor: block.queued ? "#26292d" : "#2f3338",
        color: block.queued ? "#b8bec5" : "#f5f5f5",
        text: ` ${padLine(block.queued && line === block.lines[0] ? `Queued: ${line}` : line, args.width - 2)} `
      })),
      { text: BLANK_RENDER_LINE }
    ];
  }

  if (block.kind === "assistant") {
    return renderAssistantBlock(block, args.width);
  }

  if (block.kind === "system") {
    return [
      ...wrapForRender(block.lines.join("\n"), args.width).map((line) => ({
        dimColor: block.tone === "dim",
        text: line
      })),
      { text: BLANK_RENDER_LINE }
    ];
  }

  if (block.kind === "approval") {
    const options =
      args.pendingApproval && block.id === findLastApprovalId(block.id, args.pendingApproval)
        ? [
            args.approvalChoiceIndex === 0 ? "[Approve once]" : " Approve once ",
            args.approvalChoiceIndex === 1 ? "[Reject]" : " Reject "
          ].join("  ")
        : null;
    return renderApprovalBlock(block, args.width, options);
  }

  return renderLabeledBlock(block, args.width, activityTitle(block), []);
}

function renderLabeledBlock(
  block: TranscriptBlock,
  width: number,
  title: string,
  trailingLines: string[]
): RenderLine[] {
  const lines: RenderLine[] = [
    {
      bold: true,
      color: toneColor(block.tone),
      text: `• ${title}`
    } as RenderLine
  ];

  for (const rawLine of [...block.lines, ...trailingLines]) {
    for (const line of wrapForRender(rawLine, width - 2)) {
      lines.push({
        color: toneColor(block.tone),
        dimColor: block.tone === "dim",
        text: `  ${line}`
      });
    }
  }

  lines.push({ text: BLANK_RENDER_LINE });
  return lines;
}

function renderApprovalBlock(
  block: TranscriptBlock,
  width: number,
  options: string | null
): RenderLine[] {
  const lines: RenderLine[] = [
    {
      bold: true,
      color: "yellow",
      text: "• Approval needed"
    }
  ];

  for (const rawLine of [...block.lines, ...(options ? [options] : [])]) {
    for (const line of wrapForRender(rawLine, width - 4)) {
      lines.push({
        backgroundColor: "#332500",
        color: "#f7d774",
        text: ` ${padLine(line, width - 2)} `
      });
    }
  }

  lines.push({ text: BLANK_RENDER_LINE });
  return lines;
}

function renderAssistantBlock(block: TranscriptBlock, width: number): RenderLine[] {
  const text = block.lines.join("\n");
  const rendered = block.streaming
    ? renderStreamingMarkdown(text, width)
    : renderFinalMarkdown(text, width);
  return [...rendered, { text: BLANK_RENDER_LINE }];
}

function renderComposer(state: InteractiveModel, width: number, hasTranscript: boolean): RenderLine[] {
  const placeholder =
    state.pendingApproval !== null && state.input.length === 0
      ? "Type to queue the next prompt. Enter approves the selected action."
      : state.queuedPrompts.length > 0 && state.input.length === 0
        ? `Queue next prompt (${state.queuedPrompts.length} waiting)`
      : state.recentSessions.length > 0 && state.blocks.length === 0 && state.input.length === 0
        ? "Type a task. Press Enter on empty input to resume the latest session."
        : "Type a task";
  const inputBody = state.input.length > 0 ? state.input : placeholder;
  const inputLines = wrapForRender(inputBody, width - 10);

  const rendered = [
    {
      backgroundColor: "#25282d",
      text: " ".repeat(width)
    },
    ...inputLines.map((line, index) => ({
      backgroundColor: "#25282d",
      color: state.input.length > 0 ? "#f5f5f5" : "#9aa1a8",
      text: `    ${padLine(index === inputLines.length - 1 ? `${line}${state.input.length > 0 ? "█" : ""}` : line, width - 8)}    `
    })),
    {
      backgroundColor: "#25282d",
      text: " ".repeat(width)
    },
    {
      dimColor: true,
      text: `${state.doctor?.model ?? state.profileName ?? "model"} - ${estimateContextLeftPercent(
        state
      )}% context left - ${state.cwd}`
    }
  ];

  return hasTranscript ? [{ text: BLANK_RENDER_LINE }, ...rendered] : rendered;
}

function renderLiveStatus(state: InteractiveModel, width: number): RenderLine[] {
  if (!state.liveStatusLabel && state.queuedPrompts.length === 0) {
    return [];
  }

  const lines = [
    state.liveStatusLabel ?? "Working",
    ...(state.queuedPrompts.length > 0
      ? [`Queue: ${state.queuedPrompts.length} waiting`]
      : [])
  ];

  return [
    { text: BLANK_RENDER_LINE },
    {
      bold: true,
      color: "#8ec5ff",
      text: "• Working"
    },
    ...lines.flatMap((line) =>
      wrapForRender(line, width - 2).map((wrapped) => ({
        color: "#8ec5ff",
        dimColor: line.startsWith("Queue:"),
        text: `  ${wrapped}`
      }))
    )
  ];
}

function compactBlankLines(lines: RenderLine[]): RenderLine[] {
  const compacted: RenderLine[] = [];

  for (const line of lines) {
    const isBlank = line.text.trim().length === 0;
    const previous = compacted.at(-1);
    if (isBlank && previous && previous.text.trim().length === 0) {
      continue;
    }
    compacted.push(isBlank ? { ...line, text: BLANK_RENDER_LINE } : line);
  }

  while (compacted.at(-1)?.text.trim().length === 0) {
    compacted.pop();
  }

  return compacted;
}

function padViewportTop(lines: RenderLine[], height: number): RenderLine[] {
  if (lines.length >= height) {
    return lines;
  }

  return [
    ...Array.from({ length: height - lines.length }, () => ({ text: BLANK_RENDER_LINE })),
    ...lines
  ];
}

function activityTitle(block: TranscriptBlock): string {
  if (block.bucket === "verification") {
    return block.tone === "warning" ? "Verification failed" : block.tone === "success" ? "Verification passed" : "Verification";
  }
  if (block.bucket === "plan") {
    return "Plan update";
  }
  if (block.bucket === "command") {
    return block.lines.length > 1 ? `Ran ${block.lines.length} commands` : "Ran command";
  }
  if (block.bucket === "edit") {
    return block.lines.length > 1 ? `Edited ${block.lines.length - 1} files` : "Edited";
  }
  return block.lines.length > 1 ? `Explored ${block.lines.length} items` : "Explored";
}

function shouldInsertPhaseSeparator(previous: TranscriptBlock, next: TranscriptBlock): boolean {
  const previousPhase = blockPhase(previous);
  const nextPhase = blockPhase(next);

  return (
    previousPhase !== null &&
    nextPhase !== null &&
    previousPhase !== nextPhase &&
    previousPhase === "tooling" &&
    nextPhase === "assistant"
  );
}

function blockPhase(block: TranscriptBlock): "assistant" | "tooling" | null {
  if (block.kind === "assistant") {
    return "assistant";
  }

  if (block.kind === "activity" || block.kind === "approval") {
    return "tooling";
  }

  return null;
}

function findLastApprovalId(id: string, pendingApproval: PendingApprovalInfo): string {
  void pendingApproval;
  return id;
}

function wrapForRender(text: string, width: number): string[] {
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
      const candidate = remaining.slice(0, width + 1);
      const breakAt = candidate.lastIndexOf(" ");
      const splitAt = breakAt > Math.floor(width * 0.5) ? breakAt : width;
      output.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    if (remaining.length > 0) {
      output.push(remaining);
    }
  }

  return output;
}

function padLine(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : `${text}${" ".repeat(width - text.length)}`;
}

function toneColor(tone: BlockTone): string | undefined {
  if (tone === "warning") {
    return "yellow";
  }
  if (tone === "success") {
    return "green";
  }
  if (tone === "dim") {
    return "#9aa1a8";
  }
  return undefined;
}
