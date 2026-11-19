import {
  editorLivePreviewField,
  finishRenderMath,
  loadMathJax,
  MarkdownView,
  type App,
  type MarkdownPostProcessorContext,
  Plugin,
  renderMath
} from "obsidian";
import { syntaxTree } from "@codemirror/language";
import { Prec, StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType
} from "@codemirror/view";
import {
  findMathDelimiters,
  findTableCellSource,
  highlightMathSource,
  isInsideInlineCodeText,
  type MathDelimiterMatch
} from "./parser";

const RENDER_MARKER = "data-latex-delimiter-renderer-section";

function renderFormula(source: string, display: boolean, blockHost = display): HTMLElement {
  const wrapper = blockHost ? createDiv() : createSpan();
  wrapper.className = blockHost
    ? "latex-delimiter-renderer latex-delimiter-renderer-block"
    : "latex-delimiter-renderer latex-delimiter-renderer-inline";

  const render = (): boolean => {
    try {
      wrapper.appendChild(renderMath(source, display));
      return true;
    } catch {
      return false;
    }
  };

  if (!render()) {
    // MathJax can still be starting up when a widget is created. Show the
    // source instead of throwing (a throwing widget breaks the editor update)
    // and retry once MathJax reports readiness.
    const fallback = display ? `\\[${source}\\]` : `\\(${source}\\)`;
    wrapper.textContent = fallback;
    void loadMathJax()
      .then(() => {
        if (!wrapper.isConnected) return undefined;
        wrapper.textContent = "";
        if (render()) return finishRenderMath();
        wrapper.textContent = fallback;
        return undefined;
      })
      .catch(() => undefined);
  }
  return wrapper;
}

type RenderedCharacter = { node: Text; offset: number };

function renderedCharacters(element: HTMLElement): {
  text: string;
  characters: RenderedCharacter[];
} {
  let text = "";
  const characters: RenderedCharacter[] = [];

  function visit(node: Node): void {
    if (node.instanceOf(Text)) {
      for (let offset = 0; offset < node.data.length; offset++) {
        text += node.data[offset];
        characters.push({ node, offset });
      }
      return;
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  }

  visit(element);
  return { text, characters };
}

function findOwningEditorView(app: App, element: HTMLElement): EditorView | null {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) continue;
    const editorView = (view.editor as unknown as { cm?: EditorView }).cm;
    if (editorView && editorView.contentDOM.contains(element)) return editorView;
  }
  return null;
}

/**
 * Live Preview tables are rendered as widgets, and Obsidian runs Markdown post
 * processors for each table cell without section information. Recover the raw
 * cell source from the owning editor by mapping the rendered table rows back
 * to the Markdown table lines.
 */
function resolveTableCellSourceText(app: App, element: HTMLElement): string | null {
  if (!element.classList.contains("table-cell-wrapper")) return null;

  const tableWidget = element.closest(".cm-table-widget");
  const cell = element.closest("td, th");
  const table = cell ? cell.closest("table") : null;
  if (!tableWidget || !cell || !table) return null;

  const editorView = findOwningEditorView(app, element);
  if (!editorView) return null;

  let tableStart: number;
  try {
    tableStart = editorView.posAtDOM(tableWidget);
  } catch {
    return null;
  }

  const row = cell.parentElement;
  const rows: HTMLElement[] = Array.from(table.querySelectorAll("tr"));
  const rowIndex = row ? rows.indexOf(row) : -1;
  const columnIndex = (cell as HTMLTableCellElement).cellIndex;
  if (rowIndex < 0 || columnIndex < 0) return null;

  const doc = editorView.state.doc;
  const startLine = doc.lineAt(tableStart);
  const tableLines: string[] = [];
  for (let number = startLine.number; number <= doc.lines; number++) {
    const lineText = doc.line(number).text;
    if (!lineText.trim().startsWith("|")) break;
    tableLines.push(lineText);
  }

  return findTableCellSource(tableLines, rowIndex, columnIndex);
}

const pendingTableCells = new Set<HTMLElement>();
let pendingTableCellsTimer: number | null = null;

function processPendingTableCells(app: App, retriesLeft: number): void {
  const cells = Array.from(pendingTableCells);
  pendingTableCells.clear();
  const stillDetached: HTMLElement[] = [];
  let rendered = false;

  for (const cell of cells) {
    if (!cell.isConnected) {
      stillDetached.push(cell);
      continue;
    }
    const source = resolveTableCellSourceText(app, cell);
    if (source === null) continue;
    if (renderMathInElement(cell, source, true)) rendered = true;
  }

  if (rendered) void finishRenderMath();

  if (stillDetached.length > 0 && retriesLeft > 0) {
    for (const cell of stillDetached) pendingTableCells.add(cell);
    pendingTableCellsTimer = window.setTimeout(() => {
      pendingTableCellsTimer = null;
      processPendingTableCells(app, retriesLeft - 1);
    }, 50);
  }
}

/**
 * Obsidian renders a Live Preview table widget and runs the cell post
 * processors before the widget is attached to the editor. The cell source can
 * only be resolved once the widget is connected, so retry after insertion.
 */
function scheduleTableCellProcessing(app: App, element: HTMLElement): void {
  pendingTableCells.add(element);
  if (pendingTableCellsTimer !== null) return;
  pendingTableCellsTimer = window.setTimeout(() => {
    pendingTableCellsTimer = null;
    processPendingTableCells(app, 20);
  }, 0);
}

function disposePendingTableCells(): void {
  pendingTableCells.clear();
  if (pendingTableCellsTimer !== null) {
    window.clearTimeout(pendingTableCellsTimer);
    pendingTableCellsTimer = null;
  }
}

function renderMathInElement(
  element: HTMLElement,
  source: string,
  inlineOnly: boolean
): boolean {
  if (element.closest(`[${RENDER_MARKER}]`)) return false;

  let matches = findMathDelimiters(source);
  if (inlineOnly) {
    matches = matches.filter((match) => !isInsideInlineCodeText(source, match.from));
  }
  if (matches.length === 0) return false;

  const rendered = renderedCharacters(element);
  const replacements: Array<{
    from: number;
    to: number;
    match: MathDelimiterMatch;
  }> = [];

  for (const match of matches) {
    const opening = match.display ? "[" : "(";
    const closing = match.display ? "]" : ")";
    const visibleSource = `${opening}${match.source}${closing}`;
    let from = rendered.text.indexOf(visibleSource);
    while (
      from !== -1 &&
      replacements.some(
        (replacement) =>
          from < replacement.to && from + visibleSource.length > replacement.from
      )
    ) {
      from = rendered.text.indexOf(visibleSource, from + 1);
    }
    if (from !== -1) {
      replacements.push({ from, to: from + visibleSource.length, match });
    }
  }

  if (replacements.length === 0) return false;

  element.setAttribute(RENDER_MARKER, "");
  replacements.sort((left, right) => right.from - left.from);
  for (const replacement of replacements) {
    const first = rendered.characters[replacement.from];
    const last = rendered.characters[replacement.to - 1];
    if (!first || !last) continue;

    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    range.deleteContents();
    range.insertNode(
      renderFormula(
        replacement.match.source,
        replacement.match.display,
        inlineOnly ? false : replacement.match.display
      )
    );
  }
  return true;
}

async function renderRenderedElement(
  app: App,
  element: HTMLElement,
  context: MarkdownPostProcessorContext
): Promise<void> {
  if (element.closest(`[${RENDER_MARKER}]`)) return;

  if (element.classList.contains("table-cell-wrapper")) {
    if (!element.isConnected) {
      scheduleTableCellProcessing(app, element);
      return;
    }
    const cellSource = resolveTableCellSourceText(app, element);
    if (cellSource !== null && renderMathInElement(element, cellSource, true)) {
      await finishRenderMath();
    }
    return;
  }

  const section = context.getSectionInfo(element);
  if (section && renderMathInElement(element, section.text, false)) {
    await finishRenderMath();
  }
}

function rangeTouchesSelection(state: EditorState, match: MathDelimiterMatch): boolean {
  return state.selection.ranges.some((range) => {
    if (range.empty) {
      return range.from > match.from && range.from < match.to;
    }
    return range.from < match.to && range.to > match.from;
  });
}

function isInsideInlineCode(state: EditorState, position: number): boolean {
  const line = state.doc.lineAt(position);
  return isInsideInlineCodeText(line.text, position - line.from);
}

function fencedCodeRanges(text: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  const fence = /^(?: {0,3})(`{3,}|~{3,}).*$/gm;
  let open: { character: string; length: number; from: number } | null = null;
  let match: RegExpExecArray | null;

  while ((match = fence.exec(text)) !== null) {
    const marker = match[1];
    if (!open) {
      open = { character: marker[0], length: marker.length, from: match.index };
    } else if (marker[0] === open.character && marker.length >= open.length) {
      ranges.push({ from: open.from, to: fence.lastIndex });
      open = null;
    }
  }
  if (open) ranges.push({ from: open.from, to: text.length });
  return ranges;
}

function overlapsRange(
  match: MathDelimiterMatch,
  ranges: Array<{ from: number; to: number }>
): boolean {
  return ranges.some((range) => match.from < range.to && match.to > range.from);
}

class MathWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly display: boolean,
    private readonly block: boolean,
    private readonly revealPosition: number
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      this.source === other.source &&
      this.display === other.display &&
      this.block === other.block &&
      this.revealPosition === other.revealPosition
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const element = renderFormula(this.source, this.display, this.block);
    element.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({
        selection: { anchor: this.revealPosition },
        scrollIntoView: true
      });
      view.focus();
    });
    void finishRenderMath();
    return element;
  }

  ignoreEvent(event: Event): boolean {
    return event.type === "mousedown";
  }
}

class LiteralMarkerWidget extends WidgetType {
  constructor(private readonly marker: string) {
    super();
  }

  eq(other: LiteralMarkerWidget): boolean {
    return this.marker === other.marker;
  }

  toDOM(): HTMLElement {
    const element = createSpan();
    element.className = "latex-delimiter-renderer-source-marker";
    element.textContent = this.marker;
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function markdownFormattingMarkersInMath(
  state: EditorState,
  match: MathDelimiterMatch
): Array<{ to: number; text: string }> {
  const markers: Array<{ to: number; text: string }> = [];

  syntaxTree(state).iterate({
    from: match.from,
    to: match.to,
    enter(node) {
      if (
        (node.name.includes("formatting-em") ||
          node.name.includes("formatting-strong")) &&
        node.from >= match.from &&
        node.to <= match.to
      ) {
        markers.push({
          to: node.to,
          text: state.doc.sliceString(node.from, node.to)
        });
      }
      return true;
    }
  });

  return markers;
}

function emphasisSpillsFromMath(
  state: EditorState,
  match: MathDelimiterMatch
): Array<{ from: number; to: number }> {
  const spills: Array<{ from: number; to: number }> = [];
  const textAfterMatch = state.doc.sliceString(match.to);
  const paragraphBreak = /\n[\t ]*\n/.exec(textAfterMatch);
  const paragraphEnd = paragraphBreak
    ? match.to + paragraphBreak.index
    : state.doc.length;
  const emphasisMarkers: number[] = [];
  const strongMarkers: number[] = [];

  syntaxTree(state).iterate({
    from: match.from,
    to: paragraphEnd,
    enter(node) {
      if (node.name.includes("formatting-em")) emphasisMarkers.push(node.from);
      if (node.name.includes("formatting-strong")) strongMarkers.push(node.from);
      return true;
    }
  });

  for (const markers of [emphasisMarkers, strongMarkers]) {
    const markersInsideMath = markers.filter((position) => position < match.to);
    if (markersInsideMath.length % 2 === 0) continue;

    const closingMarker = markers.find((position) => position >= match.to);
    const spillEnd = closingMarker ?? paragraphEnd;
    if (spillEnd > match.to) spills.push({ from: match.to, to: spillEnd });
  }

  return spills;
}

function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;

  const text = state.doc.toString();
  const codeRanges = fencedCodeRanges(text);
  const ranges: ReturnType<Decoration["range"]>[] = [];

  for (const match of findMathDelimiters(text)) {
    if (
      overlapsRange(match, codeRanges) ||
      isInsideInlineCode(state, match.from)
    ) {
      continue;
    }

    for (const spill of emphasisSpillsFromMath(state, match)) {
      ranges.push(
        Decoration.mark({ class: "latex-delimiter-renderer-emphasis-spill" }).range(
          spill.from,
          spill.to
        )
      );
    }

    if (rangeTouchesSelection(state, match)) {
      ranges.push(
        Decoration.mark({ class: "latex-delimiter-renderer-source" }).range(
          match.from,
          match.to
        )
      );
      // Reuse the syntax highlighting Obsidian applies to native `$…$` math,
      // so the revealed source keeps the same colors and italics.
      ranges.push(
        Decoration.mark({ class: "cm-math cm-keyword" }).range(
          match.from,
          match.from + 2
        ),
        Decoration.mark({ class: "cm-math cm-keyword" }).range(
          match.to - 2,
          match.to
        )
      );
      const sourceFrom = match.from + 2;
      const sourceTo = match.to - 2;
      if (sourceTo > sourceFrom) {
        ranges.push(Decoration.mark({ class: "cm-math" }).range(sourceFrom, sourceTo));
        for (const token of highlightMathSource(match.source)) {
          ranges.push(
            Decoration.mark({ class: `cm-math ${token.className}` }).range(
              sourceFrom + token.from,
              sourceFrom + token.to
            )
          );
        }
      }
      for (const marker of markdownFormattingMarkersInMath(state, match)) {
        ranges.push(
          Decoration.widget({
            widget: new LiteralMarkerWidget(marker.text),
            side: -1
          }).range(marker.to)
        );
      }
      continue;
    }

    const startLine = state.doc.lineAt(match.from);
    const endLine = state.doc.lineAt(match.to);
    const crossesLines = startLine.number !== endLine.number;
    const isWholeLineBlock =
      match.display && match.from === startLine.from && match.to === endLine.to;

    if (crossesLines && !isWholeLineBlock) continue;

    ranges.push(
      Decoration.replace({
        widget: new MathWidget(
          match.source,
          match.display,
          isWholeLineBlock,
          match.from + 2
        ),
        block: isWholeLineBlock
      }).range(match.from, match.to)
    );
  }
  return Decoration.set(ranges, true);
}

const livePreviewExtension = StateField.define<DecorationSet>({
  create: buildLivePreviewDecorations,
  update(decorations, transaction) {
    const livePreviewChanged =
      transaction.startState.field(editorLivePreviewField, false) !==
      transaction.state.field(editorLivePreviewField, false);
    const selectionChanged = !transaction.startState.selection.eq(transaction.state.selection);
    if (transaction.docChanged || livePreviewChanged || selectionChanged) {
      return buildLivePreviewDecorations(transaction.state);
    }
    return decorations;
  },
  provide: (field) => EditorView.decorations.from(field)
});

export default class LatexDelimiterRenderer extends Plugin {
  private tableRenderTimer: number | null = null;

  async onload(): Promise<void> {
    await loadMathJax();

    this.registerMarkdownPostProcessor((element, context) =>
      renderRenderedElement(this.app, element, context)
    );
    // Obsidian's Live Preview marker decorations cover the same ranges as our
    // widgets. Without the highest precedence they can replace a formula with
    // an empty marker widget, which renders as a blank gap until the line is
    // re-rendered (for example after clicking into it).
    this.registerEditorExtension(Prec.highest(livePreviewExtension));

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.updateOptions();
      this.scheduleTableRender();
    });
    // Tables rendered before this plugin finished loading never reach our post
    // processor, so refresh the tables that are already on screen.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.scheduleTableRender())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.scheduleTableRender())
    );
  }

  onunload(): void {
    disposePendingTableCells();
    if (this.tableRenderTimer !== null) {
      window.clearTimeout(this.tableRenderTimer);
      this.tableRenderTimer = null;
    }
  }

  private scheduleTableRender(): void {
    if (this.tableRenderTimer !== null) window.clearTimeout(this.tableRenderTimer);
    this.tableRenderTimer = window.setTimeout(() => {
      this.tableRenderTimer = null;
      void this.renderOpenTableCells();
    }, 150);
  }

  private async renderOpenTableCells(): Promise<void> {
    let rendered = false;
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) continue;
      const editorView = (view.editor as unknown as { cm?: EditorView }).cm;
      const content = editorView ? editorView.contentDOM : null;
      if (!content) continue;

      for (const cell of Array.from(
        content.querySelectorAll<HTMLElement>(".table-cell-wrapper")
      )) {
        if (cell.closest(`[${RENDER_MARKER}]`)) continue;
        const source = resolveTableCellSourceText(this.app, cell);
        if (source === null) continue;
        if (renderMathInElement(cell, source, true)) rendered = true;
      }
    }
    if (rendered) await finishRenderMath();
  }
}
