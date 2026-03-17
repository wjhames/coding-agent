export interface MarkdownRenderSpan {
  backgroundColor?: string | undefined;
  bold?: boolean | undefined;
  color?: string | undefined;
  dimColor?: boolean | undefined;
  text: string;
}

export interface MarkdownRenderLine {
  backgroundColor?: string | undefined;
  bold?: boolean | undefined;
  color?: string | undefined;
  dimColor?: boolean | undefined;
  segments?: MarkdownRenderSpan[] | undefined;
  text: string;
}

const BLANK_RENDER_LINE = " ";
const MIN_TABLE_COLUMN_WIDTH = 3;
const STREAMING_TAIL_LINE_COUNT = 8;

export function renderStreamingMarkdown(text: string, width: number): MarkdownRenderLine[] {
  const lines = text.split("\n");
  const stableCount = Math.max(0, lines.length - STREAMING_TAIL_LINE_COUNT);
  const completeLineCount = Math.max(0, lines.length - 1);
  const output: MarkdownRenderLine[] = [];
  let inCodeFence = false;

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";
    if (!inCodeFence && index + 1 < completeLineCount) {
      const tableBlock = parseTableBlock(lines, index, completeLineCount);
      if (tableBlock) {
        const renderedTable = renderTableBlock(tableBlock, width);
        if (renderedTable) {
          output.push(...renderedTable);
          index = tableBlock.nextIndex;
          continue;
        }
      }
    }

    const stable = index < stableCount;
    const rendered = renderStreamingLine(line, width, {
      inCodeFence,
      stable
    });
    output.push(...rendered.lines);
    inCodeFence = rendered.inCodeFence;
    index += 1;
  }

  return trimTrailingBlankLines(output);
}

export function renderFinalMarkdown(text: string, width: number): MarkdownRenderLine[] {
  const lines = text.split("\n");
  const output: MarkdownRenderLine[] = [];
  let inCodeFence = false;

  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? "";

    if (line.trim().startsWith("```")) {
      inCodeFence = !inCodeFence;
      output.push(codeFenceDivider(width));
      index += 1;
      continue;
    }

    if (inCodeFence) {
      output.push(...renderCodeLine(line, width));
      index += 1;
      continue;
    }

    if (/^\s*$/.test(line)) {
      pushBlankLine(output);
      index += 1;
      continue;
    }

    const tableBlock = parseTableBlock(lines, index, lines.length);
    if (tableBlock) {
      const renderedTable = renderTableBlock(tableBlock, width);
      if (renderedTable) {
        output.push(...renderedTable);
        index = tableBlock.nextIndex;
        continue;
      }
    }

    if (/^\s*---+\s*$/.test(line) || /^\s*\*\*\*+\s*$/.test(line)) {
      output.push({
        dimColor: true,
        text: "─".repeat(Math.max(12, Math.min(width, 40)))
      });
      index += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      if (output.length > 0 && output.at(-1)?.text.trim().length !== 0) {
        pushBlankLine(output);
      }
      output.push(...wrapInlineTokens([{ bold: true, text: headingMatch[2] ?? "" }], width));
      pushBlankLine(output);
      index += 1;
      continue;
    }

    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      output.push(...renderQuoteLine(quoteMatch[1] ?? "", width));
      index += 1;
      continue;
    }

    const bulletMatch = line.match(/^(\s*)([-*])\s+(.*)$/);
    if (bulletMatch) {
      output.push(...renderPrefixedLine(bulletMatch[3] ?? "", width, "• ", "  "));
      index += 1;
      continue;
    }

    const numberedMatch = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);
    if (numberedMatch) {
      const prefix = `${numberedMatch[2]} `;
      output.push(
        ...renderPrefixedLine(numberedMatch[3] ?? "", width, prefix, " ".repeat(prefix.length))
      );
      index += 1;
      continue;
    }

    output.push(...renderParagraphLine(line, width));
    index += 1;
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
      lines: [
        ...wrapInlineTokens([{ bold: true, text: headingMatch[2] ?? "" }], width),
        { text: BLANK_RENDER_LINE }
      ]
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
      lines: renderPrefixedLine(bulletMatch[3] ?? "", width, "• ", "  ")
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
  const tokens = stable ? tokenizeInlineMarkdown(line) : [{ text: line }];
  return wrapInlineTokens(tokens, width);
}

function renderQuoteLine(text: string, width: number): MarkdownRenderLine[] {
  return wrapInlineTokens(tokenizeInlineMarkdown(text), Math.max(8, width - 2), {
    firstPrefix: {
      dimColor: true,
      text: "> "
    },
    restPrefix: {
      dimColor: true,
      text: "> "
    }
  }).map((line) => ({
    ...line,
    dimColor: true
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
  return wrapInlineTokens(tokenizeInlineMarkdown(text), width, {
    firstPrefix: { text: firstPrefix },
    restPrefix: { text: restPrefix }
  });
}

function codeFenceDivider(width: number): MarkdownRenderLine {
  return {
    dimColor: true,
    text: "─".repeat(Math.max(12, Math.min(width, 40)))
  };
}

interface ParsedTableBlock {
  alignments: TableAlignment[];
  header: string[];
  nextIndex: number;
  rows: string[][];
}

type TableAlignment = "center" | "left" | "right";

function parseTableBlock(
  lines: string[],
  startIndex: number,
  limit: number
): ParsedTableBlock | null {
  if (startIndex + 1 >= limit) {
    return null;
  }

  const header = parseTableRow(lines[startIndex] ?? "");
  if (!header || header.length < 2) {
    return null;
  }

  const separator = parseSeparatorRow(lines[startIndex + 1] ?? "", header.length);
  if (!separator) {
    return null;
  }

  const rows: string[][] = [];
  let nextIndex = startIndex + 2;

  while (nextIndex < limit) {
    const line = lines[nextIndex] ?? "";
    if (/^\s*$/.test(line) || line.trim().startsWith("```")) {
      break;
    }

    const row = parseTableRow(line);
    if (!row) {
      break;
    }

    rows.push(normalizeTableRow(row, header.length));
    nextIndex += 1;
  }

  return {
    alignments: separator,
    header: normalizeTableRow(header, header.length),
    nextIndex,
    rows
  };
}

function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return null;
  }

  const cells = splitTableCells(trimmed);
  if (cells.length < 2) {
    return null;
  }

  return cells.map((cell) => cell.trim());
}

function parseSeparatorRow(
  line: string,
  expectedColumns: number
): TableAlignment[] | null {
  const cells = splitTableCells(line.trim());
  if (cells.length !== expectedColumns) {
    return null;
  }

  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const token = cell.trim();
    if (!/^:?-{3,}:?$/.test(token)) {
      return null;
    }

    alignments.push(
      token.startsWith(":") && token.endsWith(":")
        ? "center"
        : token.endsWith(":")
          ? "right"
          : "left"
    );
  }

  return alignments;
}

function splitTableCells(line: string): string[] {
  let source = line;
  if (source.startsWith("|")) {
    source = source.slice(1);
  }
  if (source.endsWith("|")) {
    source = source.slice(0, -1);
  }

  const cells: string[] = [];
  let current = "";
  let escape = false;
  let inCode = false;
  let linkLabelDepth = 0;
  let linkDestinationDepth = 0;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (char === "`") {
      inCode = !inCode;
      current += char;
      continue;
    }

    if (!inCode) {
      if (char === "[") {
        linkLabelDepth += 1;
      } else if (char === "]" && linkLabelDepth > 0) {
        linkLabelDepth -= 1;
      } else if (char === "(") {
        linkDestinationDepth += 1;
      } else if (char === ")" && linkDestinationDepth > 0) {
        linkDestinationDepth -= 1;
      } else if (char === "|" && linkLabelDepth === 0 && linkDestinationDepth === 0) {
        cells.push(current);
        current = "";
        continue;
      }
    }

    current += char;
  }

  cells.push(current);
  return cells;
}

function normalizeTableRow(row: string[], expectedColumns: number): string[] {
  if (row.length === expectedColumns) {
    return row;
  }

  if (row.length < expectedColumns) {
    return [...row, ...Array.from({ length: expectedColumns - row.length }, () => "")];
  }

  return [
    ...row.slice(0, expectedColumns - 1),
    row.slice(expectedColumns - 1).join(" | ")
  ];
}

function renderTableBlock(
  table: ParsedTableBlock,
  width: number
): MarkdownRenderLine[] | null {
  const columnWidths = resolveTableColumnWidths(table, width);
  if (!columnWidths) {
    return null;
  }

  const output: MarkdownRenderLine[] = [];
  output.push(...renderTableVisualRow(table.header, columnWidths, table.alignments));
  output.push(renderTableDividerRow(columnWidths));
  for (const row of table.rows) {
    output.push(...renderTableVisualRow(row, columnWidths, table.alignments));
  }

  return output;
}

function resolveTableColumnWidths(
  table: ParsedTableBlock,
  width: number
): number[] | null {
  const columnCount = table.header.length;
  const availableContentWidth = width - (1 + columnCount * 3);
  if (availableContentWidth < columnCount * MIN_TABLE_COLUMN_WIDTH) {
    return null;
  }

  const desiredWidths = table.header.map((_, columnIndex) =>
    Math.max(
      MIN_TABLE_COLUMN_WIDTH,
      maxTableCellLength(table, columnIndex)
    )
  );
  const widths = [...desiredWidths];

  while (widths.reduce((sum, current) => sum + current, 0) > availableContentWidth) {
    const index = widestColumnIndex(widths);
    const currentWidth = widths[index];
    if (currentWidth === undefined || currentWidth <= MIN_TABLE_COLUMN_WIDTH) {
      break;
    }
    widths[index] = currentWidth - 1;
  }

  return widths;
}

function maxTableCellLength(
  table: ParsedTableBlock,
  columnIndex: number
): number {
  const cells = [
    table.header[columnIndex] ?? "",
    ...table.rows.map((row) => row[columnIndex] ?? "")
  ];

  return Math.max(
    ...cells.map((cell) =>
      tokenizeInlineMarkdown(cell)
        .map((segment) => segment.text)
        .join("").length
    )
  );
}

function widestColumnIndex(widths: number[]): number {
  let widest = 0;
  for (let index = 1; index < widths.length; index += 1) {
    if (widths[index]! > widths[widest]!) {
      widest = index;
    }
  }
  return widest;
}

function renderTableVisualRow(
  cells: string[],
  widths: number[],
  alignments: TableAlignment[]
): MarkdownRenderLine[] {
  const renderedCells = cells.map((cell, index) =>
    renderTableCell(cell, widths[index] ?? MIN_TABLE_COLUMN_WIDTH, alignments[index] ?? "left")
  );
  const rowHeight = Math.max(...renderedCells.map((cell) => cell.length));
  const lines: MarkdownRenderLine[] = [];

  for (let rowIndex = 0; rowIndex < rowHeight; rowIndex += 1) {
    const segments: MarkdownRenderSpan[] = [{ text: "| " }];
    for (let columnIndex = 0; columnIndex < renderedCells.length; columnIndex += 1) {
      const line = renderedCells[columnIndex]![rowIndex] ?? blankAlignedLine(widths[columnIndex] ?? MIN_TABLE_COLUMN_WIDTH);
      segments.push(...cloneSegments(line.segments ?? [{ text: line.text }]));
      segments.push({
        text: columnIndex === renderedCells.length - 1 ? " |" : " | "
      });
    }

    lines.push(buildLine(segments));
  }

  return lines;
}

function renderTableDividerRow(widths: number[]): MarkdownRenderLine {
  const text = `|-${widths.map((width) => "-".repeat(width)).join("-|-")}-|`;
  return {
    dimColor: true,
    text
  };
}

function renderTableCell(
  text: string,
  width: number,
  alignment: TableAlignment
): MarkdownRenderLine[] {
  const lines = wrapInlineTokens(tokenizeInlineMarkdown(text), width);
  return lines.map((line) => alignRenderLine(line, width, alignment));
}

function blankAlignedLine(width: number): MarkdownRenderLine {
  return {
    segments: [{ text: " ".repeat(width) }],
    text: " ".repeat(width)
  };
}

function alignRenderLine(
  line: MarkdownRenderLine,
  width: number,
  alignment: TableAlignment
): MarkdownRenderLine {
  const lineLength = line.text.length;
  if (lineLength >= width) {
    return line;
  }

  const remaining = width - lineLength;
  const leftPad =
    alignment === "right"
      ? remaining
      : alignment === "center"
        ? Math.floor(remaining / 2)
        : 0;
  const rightPad = remaining - leftPad;
  const segments: MarkdownRenderSpan[] = [];

  if (leftPad > 0) {
    segments.push({ text: " ".repeat(leftPad) });
  }
  segments.push(...cloneSegments(line.segments ?? [{ text: line.text }]));
  if (rightPad > 0) {
    segments.push({ text: " ".repeat(rightPad) });
  }

  return buildLine(segments);
}

function tokenizeInlineMarkdown(
  line: string,
  inheritedStyle: Omit<MarkdownRenderSpan, "text"> = {}
): MarkdownRenderSpan[] {
  const tokens: MarkdownRenderSpan[] = [];
  let index = 0;

  const pushText = (text: string, style?: Omit<MarkdownRenderSpan, "text">) => {
    if (text.length === 0) {
      return;
    }

    const mergedStyle = mergeSpanStyle(inheritedStyle, style);
    const previous = tokens.at(-1);
    if (
      previous &&
      previous.bold === mergedStyle.bold &&
      previous.color === mergedStyle.color &&
      previous.dimColor === mergedStyle.dimColor &&
      previous.backgroundColor === mergedStyle.backgroundColor
    ) {
      previous.text += text;
      return;
    }

    tokens.push({
      ...mergedStyle,
      text
    });
  };

  while (index < line.length) {
    const slice = line.slice(index);
    const linkMatch = slice.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      tokens.push(...tokenizeInlineMarkdown(linkMatch[1] ?? "", inheritedStyle));
      pushText(` (${linkMatch[2]})`, {
        dimColor: true
      });
      index += linkMatch[0].length;
      continue;
    }

    if (slice.startsWith("**")) {
      const close = line.indexOf("**", index + 2);
      if (close !== -1) {
        tokens.push(
          ...tokenizeInlineMarkdown(line.slice(index + 2, close), {
            ...inheritedStyle,
            bold: true
          })
        );
        index = close + 2;
        continue;
      }
    }

    if (slice.startsWith("__")) {
      const close = line.indexOf("__", index + 2);
      if (close !== -1) {
        tokens.push(
          ...tokenizeInlineMarkdown(line.slice(index + 2, close), {
            ...inheritedStyle,
            bold: true
          })
        );
        index = close + 2;
        continue;
      }
    }

    if (slice.startsWith("`")) {
      const close = line.indexOf("`", index + 1);
      if (close !== -1) {
        pushText(line.slice(index + 1, close), {
          backgroundColor: "#2b2f36",
          color: "#ffd479"
        });
        index = close + 1;
        continue;
      }
    }

    pushText(line[index] ?? "");
    index += 1;
  }

  return tokens.length > 0 ? tokens : [{ text: line }];
}

function mergeSpanStyle(
  base: Omit<MarkdownRenderSpan, "text">,
  next?: Omit<MarkdownRenderSpan, "text">
): Omit<MarkdownRenderSpan, "text"> {
  return {
    ...base,
    ...(next ?? {})
  };
}

function wrapInlineTokens(
  tokens: MarkdownRenderSpan[],
  width: number,
  prefixes?: {
    firstPrefix: MarkdownRenderSpan;
    restPrefix: MarkdownRenderSpan;
  }
): MarkdownRenderLine[] {
  const firstPrefix = prefixes?.firstPrefix;
  const restPrefix = prefixes?.restPrefix ?? firstPrefix;
  const lines: MarkdownRenderLine[] = [];
  let current = firstPrefix ? [cloneSpan(firstPrefix)] : [];
  let currentLength = firstPrefix?.text.length ?? 0;
  let isFirstLine = true;

  const pushCurrent = () => {
    lines.push(buildLine(current));
    current = restPrefix ? [cloneSpan(restPrefix)] : [];
    currentLength = restPrefix?.text.length ?? 0;
    isFirstLine = false;
  };

  for (const token of tokens) {
    for (const part of splitPreservingWhitespace(token.text)) {
      if (part.length === 0) {
        continue;
      }

      let remaining = part;
      while (remaining.length > 0) {
        const available = Math.max(1, width - currentLength);
        const whitespaceOnly = /^\s+$/.test(remaining);

        if (whitespaceOnly && currentLength === (isFirstLine ? firstPrefix?.text.length ?? 0 : restPrefix?.text.length ?? 0)) {
          remaining = "";
          continue;
        }

        if (remaining.length <= available) {
          appendSpan(current, {
            ...token,
            text: remaining
          });
          currentLength += remaining.length;
          remaining = "";
          continue;
        }

        if (whitespaceOnly) {
          pushCurrent();
          remaining = "";
          continue;
        }

        if (currentLength > (isFirstLine ? firstPrefix?.text.length ?? 0 : restPrefix?.text.length ?? 0)) {
          pushCurrent();
          continue;
        }

        appendSpan(current, {
          ...token,
          text: remaining.slice(0, available)
        });
        currentLength += available;
        remaining = remaining.slice(available);
        if (remaining.length > 0) {
          pushCurrent();
        }
      }
    }
  }

  lines.push(buildLine(current));
  return lines;
}

function splitPreservingWhitespace(text: string): string[] {
  return text.split(/(\s+)/).filter((part) => part.length > 0);
}

function appendSpan(target: MarkdownRenderSpan[], next: MarkdownRenderSpan): void {
  if (next.text.length === 0) {
    return;
  }

  const previous = target.at(-1);
  if (
    previous &&
    previous.bold === next.bold &&
    previous.color === next.color &&
    previous.dimColor === next.dimColor &&
    previous.backgroundColor === next.backgroundColor
  ) {
    previous.text += next.text;
    return;
  }

  target.push(next);
}

function buildLine(segments: MarkdownRenderSpan[]): MarkdownRenderLine {
  return {
    segments,
    text: segments.map((segment) => segment.text).join("")
  };
}

function cloneSpan(span: MarkdownRenderSpan): MarkdownRenderSpan {
  return { ...span };
}

function cloneSegments(segments: MarkdownRenderSpan[]): MarkdownRenderSpan[] {
  return segments.map((segment) => cloneSpan(segment));
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
