export interface MarkdownRenderLine {
  backgroundColor?: string | undefined;
  bold?: boolean | undefined;
  color?: string | undefined;
  dimColor?: boolean | undefined;
  text: string;
}

const BLANK_RENDER_LINE = " ";
const STREAMING_TAIL_LINE_COUNT = 8;

export function renderStreamingMarkdown(text: string, width: number): MarkdownRenderLine[] {
  const lines = text.split("\n");
  const stableCount = Math.max(0, lines.length - STREAMING_TAIL_LINE_COUNT);
  const output: MarkdownRenderLine[] = [];
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const stable = index < stableCount;
    const rendered = renderStreamingLine(line, width, {
      inCodeFence,
      stable
    });
    output.push(...rendered.lines);
    inCodeFence = rendered.inCodeFence;
  }

  return trimTrailingBlankLines(output);
}

export function renderFinalMarkdown(text: string, width: number): MarkdownRenderLine[] {
  const lines = text.split("\n");
  const output: MarkdownRenderLine[] = [];
  let inCodeFence = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      output.push(codeFenceDivider(width));
      continue;
    }

    if (inCodeFence) {
      output.push(...renderCodeLine(line, width));
      continue;
    }

    if (/^\s*$/.test(line)) {
      pushBlankLine(output);
      continue;
    }

    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      output.push({
        dimColor: true,
        text: "─".repeat(Math.max(12, Math.min(width, 40)))
      });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      if (output.length > 0 && output.at(-1)?.text.trim().length !== 0) {
        pushBlankLine(output);
      }
      output.push(
        ...wrapForRender(headingMatch[2] ?? "", width).map((item) => ({
          bold: true,
          text: item
        }))
      );
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      output.push(...renderQuoteLine(quoteMatch[1] ?? "", width));
      continue;
    }

    const bulletMatch = line.match(/^(\s*)([-*])\s+(.*)$/);
    if (bulletMatch) {
      output.push(...renderPrefixedLine(bulletMatch[3] ?? "", width, `${bulletMatch[2]} `, "  "));
      continue;
    }

    const numberedMatch = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);
    if (numberedMatch) {
      const prefix = `${numberedMatch[2]} `;
      output.push(
        ...renderPrefixedLine(numberedMatch[3] ?? "", width, prefix, " ".repeat(prefix.length))
      );
      continue;
    }

    output.push(...renderParagraphLine(line, width));
  }

  return trimTrailingBlankLines(output);
}

function renderStreamingLine(
  line: string,
  width: number,
  state: {
    inCodeFence: boolean;
    stable: boolean;
  }
): {
  inCodeFence: boolean;
  lines: MarkdownRenderLine[];
} {
  if (line.trim().startsWith("```")) {
    return {
      inCodeFence: !state.inCodeFence,
      lines: [codeFenceDivider(width)]
    };
  }

  if (state.inCodeFence) {
    return {
      inCodeFence: true,
      lines: renderCodeLine(line, width)
    };
  }

  if (/^\s*$/.test(line)) {
    return {
      inCodeFence: false,
      lines: [{ text: BLANK_RENDER_LINE }]
    };
  }

  const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
  if (headingMatch) {
    return {
      inCodeFence: false,
      lines: wrapForRender(headingMatch[2] ?? "", width).map((item) => ({
        bold: true,
        text: item
      }))
    };
  }

  const quoteMatch = line.match(/^>\s?(.*)$/);
  if (quoteMatch) {
    return {
      inCodeFence: false,
      lines: renderQuoteLine(quoteMatch[1] ?? "", width)
    };
  }

  const bulletMatch = line.match(/^(\s*)([-*])\s+(.*)$/);
  if (bulletMatch) {
    return {
      inCodeFence: false,
      lines: renderPrefixedLine(bulletMatch[3] ?? "", width, `${bulletMatch[2]} `, "  ")
    };
  }

  const numberedMatch = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);
  if (numberedMatch) {
    const prefix = `${numberedMatch[2]} `;
    return {
      inCodeFence: false,
      lines: renderPrefixedLine(numberedMatch[3] ?? "", width, prefix, " ".repeat(prefix.length))
    };
  }

  return {
    inCodeFence: false,
    lines: renderParagraphLine(line, width, state.stable)
  };
}

function renderParagraphLine(
  line: string,
  width: number,
  stable = true
): MarkdownRenderLine[] {
  const normalized = stable ? normalizeInlineMarkdown(line) : line;
  return wrapForRender(normalized, width).map((item) => ({
    text: item
  }));
}

function renderQuoteLine(text: string, width: number): MarkdownRenderLine[] {
  return wrapForRender(text, Math.max(8, width - 2)).map((item) => ({
    dimColor: true,
    text: `> ${item}`
  }));
}

function renderCodeLine(text: string, width: number): MarkdownRenderLine[] {
  return wrapForRender(text.length === 0 ? " " : text, Math.max(8, width - 2)).map((item) => ({
    color: "#c7d4ff",
    text: `  ${item}`
  }));
}

function renderPrefixedLine(
  text: string,
  width: number,
  firstPrefix: string,
  restPrefix: string
): MarkdownRenderLine[] {
  const firstWidth = Math.max(8, width - firstPrefix.length);
  const restWidth = Math.max(8, width - restPrefix.length);
  const wrapped = wrapForRender(text, firstWidth);
  const output: MarkdownRenderLine[] = [];

  wrapped.forEach((line, index) => {
    const prefix = index === 0 ? firstPrefix : restPrefix;
    const available = index === 0 ? firstWidth : restWidth;
    const chunks = index === 0 ? [line] : wrapForRender(line, available);

    chunks.forEach((chunk) => {
      output.push({
        text: `${prefix}${chunk}`
      });
    });
  });

  return output;
}

function codeFenceDivider(width: number): MarkdownRenderLine {
  return {
    dimColor: true,
    text: "─".repeat(Math.max(12, Math.min(width, 40)))
  };
}

function normalizeInlineMarkdown(line: string): string {
  return line
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");
}

function wrapForRender(text: string, width: number): string[] {
  const source = text.length > 0 ? text : " ";
  const logicalLines = source.split("\n");
  const output: string[] = [];

  for (const line of logicalLines) {
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

    output.push(remaining.length > 0 ? remaining : " ");
  }

  return output;
}

function pushBlankLine(lines: MarkdownRenderLine[]): void {
  if (lines.at(-1)?.text.trim().length === 0) {
    return;
  }

  lines.push({ text: BLANK_RENDER_LINE });
}

function trimTrailingBlankLines(lines: MarkdownRenderLine[]): MarkdownRenderLine[] {
  const next = [...lines];
  while (next.at(-1)?.text.trim().length === 0) {
    next.pop();
  }
  return next;
}
