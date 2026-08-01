import assert from "node:assert/strict";
import test from "node:test";
import { convertForObsidianRender, findMathDelimiters } from "../src/parser";

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
