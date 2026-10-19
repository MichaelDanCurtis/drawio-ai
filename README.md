# Draw.io AI

**Chat with AI and watch your draw.io diagrams change live in VS Code.** Select or lasso shapes and say what to change, scribble on the canvas, paste a whiteboard photo, or point it at your code. Every AI edit stays pending until you keep it.

> **Unofficial.** Draw.io AI is an independent fork of [hediet/vscode-drawio](https://github.com/hediet/vscode-drawio) (GPL-3.0). It is not affiliated with or endorsed by JGraph Ltd, the makers of draw.io / diagrams.net.

## Getting Started

1. Open or create a diagram: any `.drawio`, `.drawio.svg` or `.drawio.png` file, or **Draw.io: New Draw.io Diagram**.
2. Open the **Draw.io AI** chat: the ✦ button in the editor title bar, or **Draw.io AI: Open AI Chat**.
3. Pick a model. GitHub Copilot models work as soon as you are signed in to Copilot. For Anthropic or any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, OpenRouter, a local server), run **Draw.io AI: Set API Key**.
4. Describe a change. To change only part of the diagram, select shapes first, or press `Alt+L` and draw around them.

In the diagram: `Alt+K` asks the AI about the selection inline, `Alt+L` starts the lasso, `Alt+M` starts markup.

## Where You Can Use It

| Surface | How |
| --- | --- |
| Chat panel | The **Draw.io AI** view; works with Copilot, Anthropic and OpenAI-compatible models |
| Copilot Chat | `@drawio` with `/selection`, `/layout`, `/style`, `/explain`, `/review`, `/sketch` |
| Copilot agent mode | The `drawio_*` tools (reference them with `#drawio-…`) |
| Other agents | Claude Code, Cursor and other MCP clients through **Draw.io AI: Set Up MCP Server for External Agents…** |

## AI Features

-   **Scope edits to part of the diagram**: select cells, or use the lasso (`Draw.io AI: Lasso Select for AI`) to circle a region, then ask about just that.
-   **Review before apply**: AI edits appear immediately but are held as pending changes: added cells are outlined green, changed ones amber, and removed ones are shown as red ghosts. Keep or revert them all from the review bar in the editor, the strip in the chat panel, the `@drawio` response buttons, or the `Draw.io AI: Accept AI Changes` / `Reject AI Changes` commands. You can also keep or revert a single cell from its context menu. A whole review is one undo step. Turn this off with `drawio-ai.reviewChanges`.
-   **Mark up the diagram** (`Alt+M`, **✎ Markup** in the chat panel, or the context menu): draw arrows (connect / flow / move), scribble strike-throughs (remove), and pin notes to shapes or empty spots, then **Send to AI**. All marks become one request; they are overlays and never touch the diagram itself.
-   **Sketch or screenshot → diagram**: paste, drop or attach (🖼) images in the chat panel, attach them to `@drawio /sketch` in Copilot Chat, right-click an image file → **Diagram from Sketch or Screenshot…**, or right-click an image inside a diagram → **✦ Convert image to diagram**. The AI rebuilds it with real, editable shapes (needs a model with vision).
-   **Code → diagram**: right-click a folder or source file → **Draw.io AI: Diagram from Code…** and pick module dependencies, a class diagram, a database ERD or an infrastructure diagram. Supports TypeScript/JavaScript, Python, Java, C#, Kotlin, Go, SQL DDL, Prisma, Terraform, docker-compose and Kubernetes YAML. Generated shapes are code-linked: with Code Link enabled, double-click one to jump to its source.
-   **Review / lint** (`Draw.io AI: Review Diagram (Lint)`, **✓ Review** in the chat panel, or `@drawio /review`): finds dangling or duplicate connectors, overlaps, almost-aligned shapes, unlabeled or disconnected shapes, tiny text and design-template violations. Moving through the list highlights the shapes; pick the issues to fix and the AI fixes them as pending changes.
-   **Design templates**: `Draw.io AI: Create Design Template…` turns example diagrams (`.drawio`, `.drawio.svg`), shape libraries (`.xml`), style guides (Markdown, text, Word `.docx`, PDF) and reference images into a template. Its palette, fonts, shape per role and connector style are extracted, and you choose what lint enforces. The template lives in the repository (`.drawio-ai/templates/<id>/template.json`, an editable `rules.md`, and copies of the sources), so it is shared through git. The AI follows the active template and flags anything that breaks it. Switch templates with `Draw.io AI: Select Design Template…` or the ◆ chip in the chat panel (setting `drawio-ai.template`; a repository with a single template uses it automatically).
-   **Saved chats**: each diagram keeps its chat panel conversation across VS Code restarts. **New AI Chat** starts over.
-   **Live code links**: shapes linked to code (by **Diagram from Code…** or **Link Code with Selected Node**) remember what the code looked like. When it moves, changes or disappears, the shape gets a badge; click it to re-point the link, let the AI update the shape, open the code or remove the link. **Draw.io AI: Check Code Links** lists every stale link, and the AI can refresh code-derived diagrams with the `drawio_code_links` tool.
-   **External agents (MCP)**: turn on the local MCP server and Claude Code, Cursor and other MCP clients can read and edit the open diagram with the same tools, including review mode and your design template. It listens on `127.0.0.1` only and requires a secret token.

## Privacy

-   Nothing is sent anywhere until you ask the AI something. Then the relevant diagram content, plus any images or code analysis you attach, goes to the model provider you picked.
-   API keys are kept in VS Code's secret storage.
-   Saved chats stay on your machine in VS Code's extension storage (`drawio-ai.persistChat`). Design templates are plain files in your repository.
-   The MCP server is off by default (`drawio-ai.mcp.enabled`).

## Main Settings

| Setting | Default | |
| --- | --- | --- |
| `drawio-ai.provider` | `vscode-lm` | Default provider for the chat panel |
| `drawio-ai.reviewChanges` | `true` | Hold AI edits as pending changes |
| `drawio-ai.template` | (auto) | Active design template id, or `none` |
| `drawio-ai.persistChat` | `true` | Restore chat panel conversations per diagram |
| `drawio-ai.checkCodeLinks` | `true` | Badge shapes whose linked code changed |
| `drawio-ai.mcp.enabled` / `.port` | `false` / `47821` | Local MCP server for external agents |
| `drawio-ai.maxToolRounds` | `16` | Tool calls per request before the AI pauses |

## Draw.io Editor Features

These come from [hediet/vscode-drawio](https://github.com/hediet/vscode-drawio):

-   Edit `.drawio`, `.dio`, `.drawio.svg` or `.drawio.png` files in the Draw.io editor.
    -   To create a new diagram, simply create an empty `*.drawio`, `*.drawio.svg` or `*.drawio.png` file and open it.
    -   `.drawio.svg` are valid `.svg` files that can be embedded in Github readme files! No export needed.
    -   `.drawio.png` are valid `.png` files! No export needed. You should use `.svg` though whenever possible - they look much better!
    -   To convert between different formats, use the `Draw.io: Convert To...` command.
-   `.drawio` files are plain XML: they diff cleanly in git, and AI assistants can read, edit and review diagram changes like any other code.
-   Uses an offline version of Draw.io by default.
-   Multiple Draw.io themes are available.
-   Use Liveshare to collaboratively edit a diagram with others.
-   Nodes/edges can be linked with code spans.

![](./docs/demo.gif)

## Editing .drawio.svg/.drawio.png Files

You can directly edit and save `.drawio.svg` and `.drawio.png` files.
These files are perfectly valid svg/png-images that contain an embedded Draw.io diagram.
Whenever you edit such a file, the svg/png part of that file is kept up to date.

![](./docs/drawio-png.gif)

If you want readable diffs, for your reviewers and your AI tools alike, prefer `.drawio` over `.drawio.png` diagrams.

## Collaboratively Edit Or Present Diagrams

With version 1.0 of this extension, extensive support for [VS Code Liveshare](https://visualstudio.microsoft.com/de/services/live-share/) has been added. You can now edit or present your Draw.io diagrams remotely, while seeing each participant's cursor and selection! This can be used for discussing, reviewing or brainstorming diagrams.
With Draw.io's freehand drawing tool and integrated LaTeX support, this extension becomes an advanced whiteboard solution that can be used for remote code interviews!

![](./docs/liveshare-demo.gif)

_Internally, this extension synchronizes Draw.io diagrams with text documents.
These text documents are shared by Liveshare. As Liveshare has no understanding of the text, modification conflicts might occur on simultaneous modifications._

## Code Link Feature

In the status bar, you can enable or disable the code link feature.
If it is enabled and you double click on a node whose label starts with `#`,
you will perform a workspace search for a symbol matching the rest of the label.

If you have a node labeled `#MyClass` and a class of name `MyClass`, you will jump to its source if you double click the node!

**Please note that you have to open at least one file of the project that contains the symbol.**
Otherwise, VS Code will not consider this project when searching for symbols.
This file itself does not have to contain the symbol though.

_TIP_: If you open the draw.io editor to the right side (i.e. the second editor column) and navigate to a symbol,
the diagram will stay visible.

![](./docs/demo-code-link.gif)

## Themes

<details>
    <summary><b>Available Draw.io Themes</b></summary>
    <!-- Please use HTML syntax here so that it works for Github and mkdocs -->
    <ul>
        <li><p>Theme "atlas"</p><img src="docs/theme-atlas.png" alt="atlas" width="800"></li>
        <li><p>Theme "Kennedy"</p><img src="docs/theme-Kennedy.png" alt="Kennedy" width="800"></li>
        <li><p>Theme "min"</p><img src="docs/theme-min.png" alt="min" width="800"</li>
        <li><p>Theme "dark"</p><img src="docs/theme-dark.png" alt="dark" width="800"></li>
    </ul>
</details>

## Associate `.svg` Files With The Draw.io Editor

By default, this extension only handles `*.drawio.svg` files.
Add this to your VS Code `settings.json` file if you want to associate it with `.svg` files:

```json
"workbench.editorAssociations": {
    "*.svg": "drawio-ai-text",
}
```

You won't be able to edit arbitrary SVG files though - only those that have been created with Draw.io or this extension!

## Light and Dark `.drawio.svg` Files

By default, `.drawio.svg` files are saved with light colors, whatever theme the editor uses.
Set `drawio-ai.svgAppearance` to `auto` to make them adapt to the color scheme of the page that shows them, for example a README on GitHub in dark mode, or to `dark` to always save them with dark colors.
The setting applies the next time a diagram is saved. Add it to the workspace settings so that everyone on a team saves the same file.

## Inline Diagrams in VS Code's Markdown Editor (Experimental, Insiders only)

VS Code Insiders ships an experimental WYSIWYG Markdown editor (`View: Reopen Editor With... > Markdown Editor`).
In that editor, every fenced code block tagged `drawio` is replaced by a live, resizable Draw.io editor:

````markdown
```drawio
<mxfile>...</mxfile>
```
````

Edits are written straight back into the fenced block, so the Markdown file stays the single source of truth and undo/redo, dirty state and hot exit keep working.
The block attributes of the inline editor are honored: `locked` makes a block read-only and `height=N` fixes its height, e.g. ```` ```drawio locked height=300 ````.
The Markdown editor's own lock toggle also puts the diagrams into read-only mode.

Notes:

-   VS Code's contribution point for this is experimental and only exists in Insiders builds; in stable VS Code (and in the regular Markdown preview) the fence is shown as text or rendered by the preview plugin as before.
-   Dynamic providers only run in trusted workspaces.
-   Settings that are baked into the editor (theme, appearance, custom libraries, fonts, ...) apply the next time the Markdown editor is opened.
-   Draw.io plugins are not loaded into the inline editors.

## Editing the Diagram and its XML Side by Side

You can open the same `*.drawio` file with the Draw.io editor and as xml file.
They are synchronized, so you can switch between them as you like it.
This is super practical if you want to use find/replace to rename text or other features of VS Code to speed up your diagram creation/edit process.
Use the `View: Reopen Editor With...` command to toggle between the text or the Draw.io editor. You can open multiple editors for the same file.
This does not make much sense for SVG files though, as the draw.io diagram is stored in its metadata.

The same goes for AI assistants: the file is a visual diagram for you and plain text for your agent.
When an agent edits the XML, the change shows up in the open diagram right away, and in a pull request it can read the diff of a diagram (an added node, a changed connection, a new label) and act on it just like it would on code.

![](./docs/drawio-xml.gif)

## Contributors

-   Michael Curtis, [MichaelDanCurtis](https://github.com/MichaelDanCurtis) on Github (Draw.io AI)
-   Henning Dieterichs, [hediet](https://github.com/hediet) on Github (author of the original Draw.io Integration extension)
-   Vincent Rouillé, [Speedy37](https://github.com/Speedy37) on Github

## See Also / Similar Extensions

-   [Draw.io](https://app.diagrams.net/) - This extension relies on the giant work of Draw.io. Their embedding feature enables this extension! This extension bundles a recent version of Draw.io.
-   [vscode-drawio](https://github.com/eightHundreds/vscode-drawio) by eightHundreds.
