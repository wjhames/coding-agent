import { describe, expect, it } from "vitest";
import { renderFinalMarkdown, renderStreamingMarkdown } from "../../src/interactive/markdown.js";

describe("interactive markdown", () => {
  it("renders settled headings, bullets, and quotes cleanly", () => {
    const lines = renderFinalMarkdown(
      "# Overview\n- first item\n1. numbered item\n> quoted line",
      60
    );
    const text = lines.map((line) => line.text);

    expect(text).toContain("Overview");
    expect(text).toContain("• first item");
    expect(text).toContain("1. numbered item");
    expect(text).toContain("> quoted line");
  });

  it("renders fenced code blocks with separators", () => {
    const lines = renderFinalMarkdown("```ts\nconst value = 1;\n```", 60);
    const text = lines.map((line) => line.text);

    expect(text[0]).toMatch(/^─+$/);
    expect(text).toContain("  const value = 1;");
    expect(text.at(-1)).toMatch(/^─+$/);
  });

  it("keeps streaming markdown conservative while normalizing stable inline markdown", () => {
    const lines = renderStreamingMarkdown(
      "Paragraph with **bold** text\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n- item one\n```js\nconst x = 1;",
      60
    );
    const text = lines.map((line) => line.text);

    expect(text).toContain("Paragraph with bold text");
    expect(text).toContain("• item one");
    expect(text).toContain("  const x = 1;");
  });

  it("renders a table shell in streaming mode as soon as the header and separator are complete", () => {
    const lines = renderStreamingMarkdown("| Name | Value |\n| --- | --- |\n", 80);
    const text = lines.map((line) => line.text);

    expect(text).toEqual(["| Name | Value |", "|------|-------|"]);
  });

  it("appends completed streaming rows while keeping the incomplete trailing row outside the table", () => {
    const lines = renderStreamingMarkdown(
      "| Name | Value |\n| --- | --- |\n| alpha | 1 |\npartial **tail",
      80
    );
    const text = lines.map((line) => line.text);

    expect(text).toContain("| alpha | 1     |");
    expect(text.at(-1)).toBe("partial **tail");
  });

  it("keeps code fences from entering streaming table mode", () => {
    const lines = renderStreamingMarkdown("```md\n| Name | Value |\n| --- | --- |\n", 80);
    const text = lines.map((line) => line.text);

    expect(text[0]).toMatch(/^─+$/);
    expect(text).toContain("  | Name | Value |");
    expect(text).toContain("  | --- | --- |");
    expect(text).not.toContain("|------|-------|");
  });

  it("renders inline bold and code as styled segments", () => {
    const lines = renderFinalMarkdown("Use **bold** and `code` here.", 60);
    const line = lines.find((item) => item.text.includes("Use bold and code here."));

    expect(line?.segments?.some((segment) => segment.bold && segment.text === "bold")).toBe(true);
    expect(
      line?.segments?.some(
        (segment) => segment.backgroundColor === "#2b2f36" && segment.text === "code"
      )
    ).toBe(true);
  });

  it("renders nested inline code inside bold list items", () => {
    const lines = renderFinalMarkdown(
      "1. **Unused `patchOperationSchema` export in `src/tools/apply-patch.ts`**",
      120
    );
    const line = lines.find((item) => item.text.includes("Unused patchOperationSchema export"));

    expect(line?.text).not.toContain("**");
    expect(line?.text).not.toContain("`");
    expect(line?.segments?.some((segment) => segment.bold && segment.text.includes("Unused "))).toBe(
      true
    );
    expect(
      line?.segments?.some(
        (segment) =>
          segment.backgroundColor === "#2b2f36" && segment.text === "patchOperationSchema"
      )
    ).toBe(true);
  });

  it("renders settled tables as aligned rows", () => {
    const lines = renderFinalMarkdown(
      "| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n| beta | 22 |",
      80
    );
    const text = lines.map((line) => line.text);

    expect(text).toContain("| Name  | Value |");
    expect(text).toContain("| alpha |     1 |");
    expect(text).toContain("| beta  |    22 |");
    expect(text).toContain("|-------|-------|");
  });

  it("wraps long table cells onto multiple lines instead of truncating", () => {
    const lines = renderFinalMarkdown(
      "| Column | Notes |\n| --- | --- |\n| left | this cell should wrap across multiple visual lines in the table renderer |",
      42
    );
    const text = lines.map((line) => line.text);

    expect(text.some((line) => line.includes("| left"))).toBe(true);
    expect(text.some((line) => line.includes("this cell"))).toBe(true);
    expect(text.some((line) => line.includes("multiple"))).toBe(true);
    expect(text.some((line) => line.includes("renderer"))).toBe(true);
  });

  it("keeps malformed table candidates as plain paragraph text", () => {
    const lines = renderFinalMarkdown(
      "| Name | Value |\n| nope | nope |\n| alpha | 1 |",
      80
    );
    const text = lines.map((line) => line.text);

    expect(text).toContain("| Name | Value |");
    expect(text).toContain("| nope | nope |");
    expect(text).not.toContain("|-------|");
  });
});
