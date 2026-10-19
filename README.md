# Draw.AI

**Chat with AI and watch your draw.io diagrams change live in VS Code.** Select or lasso shapes and say what to change, scribble on the canvas, paste a whiteboard photo, or point it at your code. Every AI edit stays pending until you keep it.

> **Unofficial.** Draw.AI is an independent fork of [hediet/vscode-drawio](https://github.com/hediet/vscode-drawio) (GPL-3.0). It is not affiliated with or endorsed by JGraph Ltd, the makers of draw.io / diagrams.net.

## Getting Started

1. Open or create a diagram: any `.drawio`, `.drawio.svg` or `.drawio.png` file, or **Draw.io: New Draw.io Diagram**.
2. Open the **Draw.AI** chat: the ✦ button in the editor title bar, or **Draw.AI: Open AI Chat**.
3. Pick a model. GitHub Copilot models work as soon as you are signed in to Copilot. For Anthropic or any OpenAI-compatible endpoint (OpenAI, Azure OpenAI, OpenRouter, a local server), run **Draw.AI: Set API Key**.
4. Describe a change. To change only part of the diagram, select shapes first, or press `Alt+L` and draw around them.

In the diagram: `Alt+K` asks the AI about the selection inline, `Alt+L` starts the lasso, `Alt+M` starts markup.

## Where You Can Use It

| Surface | How |
| --- | --- |
| Chat panel | The **Draw.AI** view; works with Copilot, Anthropic and OpenAI-compatible models |
| Copilot Chat | `@drawio` with `/selection`, `/layout`, `/style`, `/explain`, `/review`, `/sketch` |
| Copilot agent mode | The `drawio_*` tools (reference them with `#drawio-…`) |
| Claude Code and Codex | **Draw.AI: Connect Claude Code / Codex…** installs Draw.AI's plugin (skills and the `drawio_*` tools); see [below](#claude-code-and-codex) |
| Other agents | Cursor and other MCP clients through **Draw.AI: Set Up MCP Server for External Agents…** |

## AI Features

-   **Scope edits to part of the diagram**: select cells, or use the lasso (`Draw.AI: Lasso Select for AI`) to circle a region, then ask about just that.
-   **Review before apply**: AI edits appear immediately but are held as pending changes: added cells are outlined green, changed ones amber, and removed ones are shown as red ghosts. Keep or revert them all from the review bar in the editor, the strip in the chat panel, the `@drawio` response buttons, or the `Draw.AI: Accept AI Changes` / `Reject AI Changes` commands. You can also keep or revert a single cell from its context menu. A whole review is one undo step. Turn this off with `drawio-ai.reviewChanges`.
-   **Mark up the diagram** (`Alt+M`, **✎ Markup** in the chat panel, or the context menu): draw arrows (connect / flow / move), scribble strike-throughs (remove), and pin notes to shapes or empty spots, then **Send to AI**. All marks become one request; they are overlays and never touch the diagram itself.
-   **Sketch or screenshot → diagram**: paste, drop or attach (🖼) images in the chat panel, attach them to `@drawio /sketch` in Copilot Chat, right-click an image file → **Diagram from Sketch or Screenshot…**, or right-click an image inside a diagram → **✦ Convert image to diagram**. The AI rebuilds it with real, editable shapes (needs a model with vision).
-   **Code → diagram**: right-click a folder or source file → **Draw.AI: Diagram from Code…** and pick module dependencies, a class diagram, a database ERD or an infrastructure diagram. Supports TypeScript/JavaScript, Python, Java, C#, Kotlin, Go, SQL DDL, Prisma, Terraform, docker-compose and Kubernetes YAML. Generated shapes are code-linked: with Code Link enabled, double-click one to jump to its source.
-   **Review / lint** (`Draw.AI: Review Diagram (Lint)`, **✓ Review** in the chat panel, or `@drawio /review`): finds dangling or duplicate connectors, overlaps, almost-aligned shapes, unlabeled or disconnected shapes, tiny text and design-template violations. Moving through the list highlights the shapes; pick the issues to fix and the AI fixes them as pending changes.
-   **Design templates**: `Draw.AI: Create Design Template…` turns example diagrams (`.drawio`, `.drawio.svg`), shape libraries (`.xml`), style guides (Markdown, text, Word `.docx`, PDF) and reference images into a template. Its palette, fonts, shape per role and connector style are extracted, and you choose what lint enforces. The template lives in the repository (`.drawio-ai/templates/<id>/template.json`, an editable `rules.md`, and copies of the sources), so it is shared through git. The AI follows the active template and flags anything that breaks it. Switch templates with `Draw.AI: Select Design Template…` or the ◆ chip in the chat panel (setting `drawio-ai.template`; a repository with a single template uses it automatically).
-   **Saved chats**: each diagram keeps its chat panel conversation across VS Code restarts. **New AI Chat** starts over.
-   **Live code links**: shapes linked to code (by **Diagram from Code…** or **Link Code with Selected Node**) remember what the code looked like. When it moves, changes or disappears, the shape gets a badge; click it to re-point the link, let the AI update the shape, open the code or remove the link. **Draw.AI: Check Code Links** lists every stale link, and the AI can refresh code-derived diagrams with the `drawio_code_links` tool.
-   **Export from chat**: ask for a Visio, SVG or PNG file ("export this as Visio to docs/architecture.vsdx") and the AI writes it into the workspace with the `drawio_export` tool. It only writes inside the workspace (never through symbolic links), asks you before replacing an earlier export, and never replaces a diagram.
-   **External agents (MCP)**: turn on the local MCP server and Claude Code, Codex, Cursor and other MCP clients can read and edit your diagrams with the same tools, including review mode and your design template. It listens on `127.0.0.1` only and requires a secret token.

## Privacy

-   Nothing is sent anywhere until you ask the AI something. Then the relevant diagram content, plus any images or code analysis you attach, goes to the model provider you picked.
-   API keys are kept in VS Code's secret storage.
-   Saved chats stay on your machine in VS Code's extension storage (`drawio-ai.persistChat`). Design templates are plain files in your repository.
-   The MCP server is off by default (`drawio-ai.mcp.enabled`). While it runs, each VS Code window records its port, token, folders and open diagrams in a file only your user account can read (`~/.drawio-ai/instances/`), so the Claude Code / Codex plugin can find it (`drawio-ai.mcp.discovery`).
-   An agent can only open diagrams inside your workspace folders, or ones you already have open, and never through symbolic links.
-   Exports, including Visio files, are made inside VS Code. Nothing is uploaded.

## Main Settings

| Setting | Default | |
| --- | --- | --- |
| `drawio-ai.provider` | `vscode-lm` | Default provider for the chat panel |
| `drawio-ai.reviewChanges` | `true` | Hold AI edits as pending changes |
| `drawio-ai.template` | (auto) | Active design template id, or `none` |
| `drawio-ai.persistChat` | `true` | Restore chat panel conversations per diagram |
| `drawio-ai.checkCodeLinks` | `true` | Badge shapes whose linked code changed |
| `drawio-ai.mcp.enabled` / `.port` | `false` / `47821` | Local MCP server for external agents |
| `drawio-ai.mcp.discovery` | `true` | Let connected Claude Code / Codex find each VS Code window without a copied token |
| `drawio-ai.maxToolRounds` | `16` | Tool calls per request before the AI pauses |

## Claude Code and Codex

Draw.AI's diagram tools also work from Claude Code and Codex, whether you run them in VS Code's terminal, in their own VS Code panels, or elsewhere on the same computer. Edits appear live in the Draw.AI editor, held for review like any other AI edit.

1. Run **Draw.AI: Connect Claude Code / Codex…** (also in the MCP status bar item's menu).
2. Pick the agents. Draw.AI shows the exact commands it will run, turns on its MCP server if needed, and installs its plugin:
    - Claude Code: `claude plugin marketplace add ~/.drawio-ai/agent-plugin` and `claude plugin install draw-ai@draw-ai`
    - Codex: `codex plugin marketplace add ~/.drawio-ai/agent-plugin` and `codex plugin add draw-ai@draw-ai`
3. Start a new Claude Code or Codex session and ask for a diagram, for example "draw our checkout flow in docs/checkout.drawio".

The plugin adds:

-   **Skills** that teach the agent how to build, review and code-link diagrams well. The same skills are offered to Copilot in VS Code.
-   **The `drawio_*` tools**, through a small bridge that runs on VS Code's own runtime (no Node.js needed). It finds the VS Code window that has the diagram, so several windows work at once and no token has to be copied.

Agents name a diagram with `file` (for example `docs/architecture.drawio`): it opens beside your work without taking keyboard focus, so you can watch. `drawio_list_diagrams`, `drawio_search_diagrams` and `drawio_create` find and make diagrams. Without `file`, the tools act on the diagram you have open.

Run the Connect command again after updating Draw.AI to update the plugin, and **Draw.AI: Disconnect Claude Code / Codex…** to remove it. Everything stays on your machine: the bridge only talks to Draw.AI's MCP server on `127.0.0.1`.

## Export to Microsoft Visio

**Draw.io: Export to Visio (.vsdx)…**, **File → Export as Visio (.vsdx)…** in the diagram, or `.vsdx` in **Draw.io: Export To...** saves every page as a Visio file. The AI can do the same with `drawio_export`, optionally for the current page only.

What carries over:

-   Every page, with its name and size. Visible layers, including locked ones.
-   Shapes as editable Visio shapes, drawn from draw.io's own rendering, so built-in shapes, stencils and vendor icons (AWS, Cisco, ...) keep their outlines. Icons painted in several colors become small groups, one shape per color.
-   Text with its font, size, color, bold/italic/underline, alignment and bullet lists.
-   Connectors as Visio dynamic connectors glued to their shapes, with arrowheads, dashes and labels.
-   Containers, groups and tables as Visio groups.
-   Images, embedded in the file (SVG images are converted to PNG).
-   Custom properties as Shape Data, links as hyperlinks and tooltips as ScreenTips.

Not exported: hidden layers (you are told which), LaTeX math, and curved connector routing (connectors keep their waypoints as straight segments; Visio may re-route them when you move shapes). Gradients and opacity are approximated.

The exporter is based on the VSDX exporter that draw.io shipped until v24.7.17 (Copyright JGraph Ltd, Apache License 2.0), updated for current draw.io.

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

-   Michael Curtis, [MichaelDanCurtis](https://github.com/MichaelDanCurtis) on Github (Draw.AI)
-   Henning Dieterichs, [hediet](https://github.com/hediet) on Github (author of the original Draw.io Integration extension)
-   Vincent Rouillé, [Speedy37](https://github.com/Speedy37) on Github

## See Also / Similar Extensions

-   [Draw.io](https://app.diagrams.net/) - This extension relies on the giant work of Draw.io. Their embedding feature enables this extension! This extension bundles a recent version of Draw.io.
-   [vscode-drawio](https://github.com/eightHundreds/vscode-drawio) by eightHundreds.
