import assert from "node:assert/strict";
import test from "node:test";
import {
  convertForObsidianRender,
  findMathDelimiters,
  findTableCellSource,
  isInsideInlineCodeText,
  parseTableRow
} from "../src/parser";

test("finds inline and display delimiters", () => {
  assert.deepEqual(findMathDelimiters("A \\(x+1\\) B \\[y^2\\]"), [
    { from: 2, to: 9, source: "x+1", display: false },
    { from: 12, to: 19, source: "y^2", display: true }
  ]);
});

test("ignores escaped, empty, and multiline inline delimiters", () => {
  assert.deepEqual(findMathDelimiters("\\\\(no\\) \\(\\) \\(a\nb\\)"), []);
});

test("allows multiline display math", () => {
  assert.deepEqual(findMathDelimiters("\\[\na+b\n\\]"), [
    { from: 0, to: 9, source: "\na+b\n", display: true }
  ]);
});

test("converts delimiters for rendering without touching code", () => {
  const markdown = [
    "Inline \\(x\\).",
    "`literal \\(x\\)`",
    "```tex",
    "\\[not rendered\\]",
    "```",
    "\\[y\\]"
  ].join("\n");
  assert.equal(
    convertForObsidianRender(markdown),
    [
      "Inline $x$.",
      "`literal \\(x\\)`",
      "```tex",
      "\\[not rendered\\]",
      "```",
      "$$y$$"
    ].join("\n")
  );
});

test("parses markdown table rows into cell sources", () => {
  assert.deepEqual(parseTableRow("| a | b |"), ["a", "b"]);
  assert.deepEqual(parseTableRow(" | 字体类型 | LaTeX 命令 |"), [
    "字体类型",
    "LaTeX 命令"
  ]);
  assert.deepEqual(parseTableRow("| `a\\|b` | (x) |"), ["`a|b`", "(x)"]);
  assert.deepEqual(parseTableRow("| a | b"), ["a", "b"]);
  assert.equal(parseTableRow("plain text"), null);
});

test("maps rendered table cells back to their markdown source", () => {
  const lines = [
    "| 字体 | 效果 |",
    "| :--- | :--- |",
    "| 正体 | \\(\\mathrm{x}\\) |",
    "| 花体 | extra |"
  ];
  assert.equal(findTableCellSource(lines, 0, 1), "效果");
  assert.equal(findTableCellSource(lines, 1, 1), "\\(\\mathrm{x}\\)");
  assert.equal(findTableCellSource(lines, 2, 0), "花体");
  assert.equal(findTableCellSource(lines, 3, 0), null);
  assert.equal(findTableCellSource(lines, 1, 5), null);
  assert.equal(findTableCellSource([], 0, 0), null);
});

test("skips math that sits inside inline code", () => {
  const cell = "`\\(loss\\)` 和 \\(l\\)";
  const matches = findMathDelimiters(cell);
  assert.equal(matches.length, 2);
  assert.equal(isInsideInlineCodeText(cell, matches[0].from), true);
  assert.equal(isInsideInlineCodeText(cell, matches[1].from), false);
});
