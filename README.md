# LaTeX Delimiter Renderer

An Obsidian plugin that renders standard LaTeX `\(…\)` and `\[…\]` math delimiters alongside Obsidian's native `$…$` and `$$…$$` syntax—without rewriting your Markdown files.

## Features

- Renders `\(x + 1\)` as inline math.
- Renders `\[x + 1\]` as display math, including multiline equations.
- Works in Live Preview and Reading View.
- Reveals the original delimiters while the cursor is inside a formula.
- Leaves inline code and fenced code blocks untouched.
- Uses Obsidian's bundled MathJax renderer and works offline.

## Usage

Write math using either LaTeX delimiter style:

```text
Inline: \( E = mc^2 \)

Display:
\[
E = mc^2
\]
```

Rendering is automatic. There are no commands or per-note settings.

## Installation

### Community Plugins

Once accepted into the Obsidian Community Plugins directory, search for **LaTeX Delimiter Renderer** under **Settings → Community plugins → Browse**.

### BRAT

1. Install the BRAT community plugin.
2. Choose **Add beta plugin**.
3. Enter `https://github.com/BurgerAndreas/latex-delimiter-renderer`.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release and place them in:

```text
<vault>/.obsidian/plugins/latex-delimiter-renderer/
```

Reload Obsidian, then enable **LaTeX Delimiter Renderer** under Community plugins.

## Limitations

- Multiline `\(…\)` expressions remain unrendered because inline editor decorations cannot safely span lines.
- In Live Preview, multiline `\[…\]` expressions must occupy complete lines.
- Reading View temporarily re-renders affected Markdown sections in memory. The source file is never modified.

## Privacy and security

This plugin:

- does not access the network;
- does not collect analytics or telemetry;
- does not require an account or payment;
- does not read or write files outside Obsidian's normal rendering process;
- does not modify note contents.

## Development

```bash
npm install
npm run check
```

The production bundle is written to `main.js`.

## License

[MIT](LICENSE)
