import {
  editorLivePreviewField,
  finishRenderMath,
  loadMathJax,
  MarkdownRenderChild,
  MarkdownRenderer,
  type MarkdownPostProcessorContext,
  Plugin,
  renderMath
} from "obsidian";
import { RangeSetBuilder, StateField, type EditorState } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType
} from "@codemirror/view";
import {
  convertForObsidianRender,
  findMathDelimiters,
  type MathDelimiterMatch
} from "./parser";

const READING_RENDER_MARKER = "data-latex-delimiter-renderer-section";

function renderFormula(source: string, display: boolean, blockHost = display): HTMLElement {
  const wrapper = blockHost ? createDiv() : createSpan();
  wrapper.className = blockHost
    ? "latex-delimiter-renderer latex-delimiter-renderer-block"
    : "latex-delimiter-renderer latex-delimiter-renderer-inline";
  wrapper.appendChild(renderMath(source, display));
  return wrapper;
}

async function renderReadingView(
  plugin: Plugin,
  element: HTMLElement,
  context: MarkdownPostProcessorContext
): Promise<void> {
  if (element.closest(`[${READING_RENDER_MARKER}]`)) return;

  const section = context.getSectionInfo(element);
  if (!section) return;
  const converted = convertForObsidianRender(section.text);
  if (converted === section.text) return;

  element.setAttribute(READING_RENDER_MARKER, "");
  element.replaceChildren();
  const child = new MarkdownRenderChild(element);
  context.addChild(child);
  await MarkdownRenderer.render(
    plugin.app,
    converted,
    element,
    context.sourcePath,
    child
  );
  await finishRenderMath();
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
  const before = line.text.slice(0, position - line.from);
  const ticks = before.match(/`+/g) ?? [];
  return ticks.length % 2 === 1;
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
    private readonly block: boolean
  ) {
    super();
  }

  eq(other: MathWidget): boolean {
    return (
      this.source === other.source &&
      this.display === other.display &&
      this.block === other.block
    );
  }

  toDOM(): HTMLElement {
    const element = renderFormula(this.source, this.display, this.block);
    void finishRenderMath();
    return element;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  if (!state.field(editorLivePreviewField, false)) return Decoration.none;

  const text = state.doc.toString();
  const codeRanges = fencedCodeRanges(text);
  const builder = new RangeSetBuilder<Decoration>();

  for (const match of findMathDelimiters(text)) {
    if (
      rangeTouchesSelection(state, match) ||
      overlapsRange(match, codeRanges) ||
      isInsideInlineCode(state, match.from)
    ) {
      continue;
    }

    const startLine = state.doc.lineAt(match.from);
    const endLine = state.doc.lineAt(match.to);
    const crossesLines = startLine.number !== endLine.number;
    const isWholeLineBlock =
      match.display && match.from === startLine.from && match.to === endLine.to;

    if (crossesLines && !isWholeLineBlock) continue;

    builder.add(
      match.from,
      match.to,
      Decoration.replace({
        widget: new MathWidget(match.source, match.display, isWholeLineBlock),
        block: isWholeLineBlock
      })
    );
  }
  return builder.finish();
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
  async onload(): Promise<void> {
    await loadMathJax();

    this.registerMarkdownPostProcessor((element, context) =>
      renderReadingView(this, element, context)
    );
    this.registerEditorExtension(livePreviewExtension);

    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.updateOptions();
    });
  }
}
