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
    expect(text).toContain("- first item");
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
    expect(text).toContain("- item one");
    expect(text).toContain("  const x = 1;");
  });
});
