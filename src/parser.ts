export type MathDelimiterMatch = {
  from: number;
  to: number;
  source: string;
  display: boolean;
};

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function findClosingDelimiter(text: string, from: number, close: string): number {
  for (let cursor = from; cursor <= text.length - close.length; cursor++) {
    if (text.startsWith(close, cursor) && !isEscaped(text, cursor)) return cursor;
  }
  return -1;
}

/**
 * Finds LaTeX paren/bracket math in plain text. Code spans and fenced code are
 * excluded by the caller because Reading View and Live Preview expose syntax
 * information differently.
 */
export function findMathDelimiters(text: string, offset = 0): MathDelimiterMatch[] {
  const matches: MathDelimiterMatch[] = [];

  for (let cursor = 0; cursor < text.length - 1; cursor++) {
    if (text[cursor] !== "\\" || isEscaped(text, cursor)) continue;

    const kind = text[cursor + 1];
    if (kind !== "(" && kind !== "[") continue;

    const display = kind === "[";
    const close = display ? "\\]" : "\\)";
    const closeAt = findClosingDelimiter(text, cursor + 2, close);
    if (closeAt === -1) continue;

    const source = text.slice(cursor + 2, closeAt);
    if (source.trim().length === 0 || (!display && source.includes("\n"))) continue;

    matches.push({
      from: offset + cursor,
      to: offset + closeAt + close.length,
      source,
      display
    });
    cursor = closeAt + close.length - 1;
  }

  return matches;
}

/**
 * Splits one Markdown table row into trimmed cell sources. Returns null when
 * the line is not a table row. Escaped pipes (`\|`) stay inside their cell.
 */
export function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  const cells: string[] = [];
  let current = "";
  let closed = false;

  for (let index = 1; index < trimmed.length; index++) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index++;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      closed = index === trimmed.length - 1;
      continue;
    }
    current += character;
    closed = false;
  }

  if (!closed) cells.push(current.trim());
  return cells;
}

/**
 * Maps a cell of a rendered table back to its Markdown source cell. The first
 * source line holds the header, the second line is the delimiter row, and the
 * remaining lines map one-to-one to the rendered body rows.
 */
export function findTableCellSource(
  tableLines: readonly string[],
  rowIndex: number,
  columnIndex: number
): string | null {
  if (rowIndex < 0 || columnIndex < 0 || tableLines.length === 0) return null;

  const header = parseTableRow(tableLines[0]);
  if (!header) return null;

  if (rowIndex === 0) return header[columnIndex] ?? null;

  const sourceRow = tableLines[rowIndex + 1];
  if (!sourceRow) return null;

  const cells = parseTableRow(sourceRow);
  return cells ? cells[columnIndex] ?? null : null;
}

/** True when the given offset in `text` falls inside an inline code span. */
export function isInsideInlineCodeText(text: string, position: number): boolean {
  const before = text.slice(0, position);
  const ticks = before.match(/`+/g) ?? [];
  return ticks.length % 2 === 1;
}

export type MathSourceToken = { from: number; to: number; className: string };

function isAsciiLetter(character: string): boolean {
  return /^[a-zA-Z]$/.test(character);
}

/**
 * Splits LaTeX source into runs that Obsidian's Markdown editor highlights
 * with the same classes it uses for native `$…$` math source.
 */
export function highlightMathSource(source: string): MathSourceToken[] {
  const tokens: MathSourceToken[] = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];

    if (character === "\\") {
      let end = index + 1;
      if (end < source.length && isAsciiLetter(source[end])) {
        while (end < source.length && isAsciiLetter(source[end])) end++;
      } else if (end < source.length) {
        end++;
      }
      tokens.push({ from: index, to: end, className: "cm-tag" });
      index = end;
      continue;
    }

    if (/[0-9]/.test(character)) {
      let end = index + 1;
      while (end < source.length && /[0-9.]/.test(source[end])) end++;
      tokens.push({ from: index, to: end, className: "cm-number" });
      index = end;
      continue;
    }

    if (isAsciiLetter(character)) {
      tokens.push({ from: index, to: index + 1, className: "cm-variable-2" });
      index++;
      continue;
    }

    if ("{}()[]".includes(character)) {
      tokens.push({ from: index, to: index + 1, className: "cm-bracket" });
      index++;
      continue;
    }

    if (character === "^" || character === "_") {
      tokens.push({ from: index, to: index + 1, className: "cm-tag" });
      index++;
      continue;
    }

    index++;
  }

  return tokens;
}

function convertPlainSegment(text: string): string {
  const matches = findMathDelimiters(text);
  if (matches.length === 0) return text;

  let converted = "";
  let cursor = 0;
  for (const match of matches) {
    converted += text.slice(cursor, match.from);
    converted += match.display ? `$$${match.source}$$` : `$${match.source}$`;
    cursor = match.to;
  }
  return converted + text.slice(cursor);
}

/** Converts only for an in-memory rendering pass; fenced and inline code stay literal. */
export function convertForObsidianRender(markdown: string): string {
  const fencedPattern = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;
  const inlineCodePattern = /(`+[^`\n]*?`+)/g;

  return markdown
    .split(fencedPattern)
    .map((block) => {
      if (block.startsWith("```") || block.startsWith("~~~")) return block;
      return block
        .split(inlineCodePattern)
        .map((piece) => (piece.startsWith("`") ? piece : convertPlainSegment(piece)))
        .join("");
    })
    .join("");
}
