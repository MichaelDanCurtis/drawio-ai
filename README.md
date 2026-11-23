# Draw.AI

**Chat with AI and watch your draw.io diagrams change live in VS Code.** Select or lasso shapes and say what to change, scribble on the canvas, paste a whiteboard photo, or point it at your code. Every AI edit stays pending until you keep it.

> **Unofficial.** Draw.AI is an independent fork of [hediet/vscode-drawio](https://github.com/hediet/vscode-drawio) (GPL-3.0). It is not affiliated with or endorsed by JGraph Ltd, the makers of draw.io / diagrams.net.

## Getting Started

1. Open or create a diagram: any `.drawio`, `.drawio.svg` or `.drawio.png` file, or **Draw.io: New Draw.io Diagram**.
2. Open the chat: the ✦ button in the editor title bar, or **Draw.AI: Open Draw.AI in Chat**. This is VS Code's own chat with the **Draw.AI** agent chosen. It uses the model you pick in the chat (GitHub Copilot, or any other chat model extension).
3. Describe a change. The AI's edits appear in the diagram and stay pending until you keep or revert them with the review bar in the editor. To change only part of the diagram, select shapes first, or press `Alt+L` and draw around them.

In the diagram: `Alt+K` asks the AI about the selection inline, `Alt+L` starts the lasso, `Alt+M` starts markup.

## Where You Can Use It

| Surface | How |
| --- | --- |
| VS Code chat, **Draw.AI** agent | The default. Requests from the diagram (`Alt+K`, lasso, markup, lint fixes, ...) open here with the **Draw.AI** agent chosen and the selection described; images and code analyses travel with the request. Or pick **Draw.AI** in the chat's agent picker and type. Needs VS Code 1.142 or later: older versions keep using `@drawio`. Keep or revert its pending changes with the buttons in the diagram's title bar |
| VS Code chat, `@drawio` | Only with VS Code's Local chat runtime, which is removed in February 2027 (the Copilot runtime does not run chat participants). Set `drawio-ai.chat.target` to `participant` to send diagram requests to it. `@drawio` has `/selection`, `/layout`, `/style`, `/explain`, `/review`, `/sketch`, and its answers end with action buttons |
| VS Code chat, Agent mode | The `drawio_*` tools appear under Draw.AI in **Configure Tools** (reference one with `#drawio-…`). Instructions shipped with the extension tell the agent to change `.drawio` files with these tools, not by rewriting their XML |
| Claude Code and Codex | **Draw.AI: Connect Claude Code / Codex…** installs Draw.AI's plugin (skills and the `drawio_*` tools); see [below](#claude-code-and-codex) |
| Other agents | Cursor and other MCP clients through **Draw.AI: Set Up MCP Server for External Agents…** |

The diagram's own buttons and menus (lasso, markup, Ask AI, Convert image, the review bar, design templates) work the same whichever chat you use. Pick a design template with **Draw.AI: Select Design Template…** (also in the diagram's `…` menu); the AI reads it with `drawio_get_template`.

## AI Features

-   **Scope edits to part of the diagram**: select cells, or use the lasso (`Draw.AI: Lasso Select for AI`) to circle a region, then ask about just that.
-   **Review before apply**: AI edits appear immediately but are held as pending changes: added cells are outlined green, changed ones amber, and removed ones are shown as red ghosts. Keep or revert them all from the review bar in the editor, the `@drawio` answer buttons, or the `Draw.AI: Accept AI Changes` / `Reject AI Changes` commands. You can also keep or revert a single cell from its context menu. Pending changes stay with their page while you look at another one: the review bar counts what waits on other pages, and accepting or rejecting everything covers every page. The changes on one page are one undo step. Turn this off with `drawio-ai.reviewChanges`.
-   **Pages and layers**: the AI lists, adds, renames, duplicates, reorders, deletes and switches pages (`drawio_pages`), reads any page without leaving the one you are on, and adds, renames, hides, locks and fills layers. Page changes are part of the review: rejecting removes the pages the AI added (unless you have drawn on them) and undoes its renames and moves. Deleting a page with your content on it always asks you first. Each page change is one undo step.
-   **Mark up the diagram** (`Alt+M`, **Mark Up** under a `@drawio` answer, or the context menu): draw arrows (connect / flow / move), scribble strike-throughs (remove), and pin notes to shapes or empty spots, then **Send to AI**. All marks become one request; they are overlays and never touch the diagram itself.
-   **Sketch or screenshot → diagram**: attach them to `@drawio /sketch` in VS Code's chat, right-click an image file → **Diagram from Sketch or Screenshot…**, or right-click an image inside a diagram → **✦ Convert image to diagram**. The AI rebuilds it with real, editable shapes (needs a model with vision).
-   **Code → diagram**: right-click a folder or source file → **Draw.AI: Diagram from Code…** and pick module dependencies, a class diagram, a database ERD or an infrastructure diagram. Supports TypeScript/JavaScript, Python, Java, C#, Kotlin, Go, SQL DDL, Prisma, Terraform, docker-compose and Kubernetes YAML. Generated shapes are code-linked: with Code Link enabled, double-click one to jump to its source.
-   **Review / lint** (`Draw.AI: Review Diagram (Lint)`, **Review** under a `@drawio` answer, or `@drawio /review`): finds dangling or duplicate connectors, overlaps, almost-aligned shapes, unlabeled or disconnected shapes, tiny text and design-template violations. Moving through the list highlights the shapes; pick the issues to fix and the AI fixes them as pending changes.
-   **Design templates**: `Draw.AI: Create Design Template…` turns example diagrams (`.drawio`, `.drawio.svg`), shape libraries (`.xml`), style guides (Markdown, text, Word `.docx`, PDF) and reference images into a template. Its palette, fonts, shape per role and connector style are extracted, and you choose what lint enforces. The template lives in the repository (`.drawio-ai/templates/<id>/template.json`, an editable `rules.md`, and copies of the sources), so it is shared through git. The AI follows the active template and flags anything that breaks it. Switch templates with `Draw.AI: Select Design Template…` (setting `drawio-ai.template`; a repository with a single template uses it automatically).
-   **Live code links**: shapes linked to code (by **Diagram from Code…** or **Link Code with Selected Node**) remember what the code looked like. When it moves, changes or disappears, the shape gets a badge; click it to re-point the link, let the AI update the shape, open the code or remove the link. **Draw.AI: Check Code Links** lists every stale link, and the AI can refresh code-derived diagrams with the `drawio_code_links` tool.
-   **Export to PDF**: **Draw.io: Export to PDF…**, **File → Export as PDF…** in the diagram, `.pdf` in **Draw.io: Export To...**, or **Export PDF** under a `@drawio` answer. Every page becomes one PDF page the size of its content, rendered at print resolution (about 300 dpi) inside VS Code; nothing is uploaded.
-   **Export from chat**: ask for a PDF, Visio, SVG or PNG file ("export this as Visio to docs/architecture.vsdx") and the AI writes it into the workspace with the `drawio_export` tool. It only writes inside the workspace (never through symbolic links), asks you before replacing an earlier export, and never replaces a diagram.
-   **Import from chat**: ask the AI to open a Visio, Gliffy, yEd, Lucidchart, Miro or draw.io CSV file ("open docs/network.vsdx") and it converts it into a new `.drawio` file with the `drawio_import` tool, then tells you what did not carry over. It only reads files inside the workspace and never replaces a file.
-   **Shape Workshop**: galleries of icons and logos as palettes and in draw.io's search, your own collections, and draw.io's shape sets in one place. See [Shape Workshop](#shape-workshop).
-   **Mapper**: **Draw.AI: Map Something…** draws software, databases, cloud environments and ML systems into the diagram from facts it collects read-only, with health findings and guided tours. See [Mapper](#mapper).
-   **External agents (MCP)**: turn on the local MCP server and Claude Code, Codex, Cursor and other MCP clients can read and edit your diagrams with the same tools, including review mode and your design template. It listens on `127.0.0.1` only and requires a secret token.

## Privacy

-   Nothing is sent anywhere until you ask the AI something. Then the relevant diagram content, plus any images or code analysis you attach, goes to the model you picked in VS Code's chat.
-   Design templates are plain files in your repository.
-   The MCP server is off by default (`drawio-ai.mcp.enabled`). While it runs, each VS Code window records its port, a session token that only works while that window runs, its folders and open diagrams in a file only your user account can read (`~/.drawio-ai/instances/`), so the Claude Code / Codex plugin can find it (`drawio-ai.mcp.discovery`). The long-lived token you copy for hand-configured clients never goes there.
-   An agent can only open diagrams inside your workspace folders, or ones you already have open, and never through symbolic links.
-   Exports and imports, including PDF and Visio files, are made inside VS Code. Nothing is uploaded.
-   The [Shape Workshop](#shape-workshop) downloads nothing until you switch a gallery on. Then it fetches that gallery's index and the shapes you look at from jsDelivr or GitHub; nothing about your diagrams is sent.
-   The [Mapper](#mapper) only reads the systems it maps. Passwords, connection strings and tokens are used for one run and are never stored, drawn or sent to the agent; the facts it collects go to the agent only when you ask it to review, describe or dig into a map.

## Main Settings

| Setting | Default | |
| --- | --- | --- |
| `drawio-ai.reviewChanges` | `true` | Hold AI edits as pending changes |
| `drawio-ai.template` | (auto) | Active design template id, or `none` |
| `drawio-ai.checkCodeLinks` | `true` | Badge shapes whose linked code changed |
| `drawio-ai.mcp.enabled` / `.port` | `false` / `47821` | Local MCP server for external agents |
| `drawio-ai.mcp.discovery` | `true` | Let connected Claude Code / Codex find each VS Code window without a copied token |
| `drawio-ai.maxToolRounds` | `16` | Tool calls per request before the AI pauses |

## Open Visio, Gliffy, yEd, Lucidchart, Miro and CSV Files

**Draw.io: Open Visio File as Draw.io…** (or right-click a Visio file in the Explorer) converts it into a new `.drawio` file next to the original and opens it. **Draw.io: Import Diagram from Another Tool…** does the same for every format below; it is also in the diagram's **File** menu as **Open from Another Tool…**, and on `.gliffy` and `.graphml` files in the Explorer. In chat, the AI does it with `drawio_import`.

| From | Files |
| --- | --- |
| Microsoft Visio | `.vsdx` drawings, `.vstx` templates, `.vssx` stencils (their shapes are laid out on one page, each with its name), and the binary `.vsd`, `.vst` and `.vss` files of Visio 2003–2010 |
| Gliffy | `.gliffy` files, or Gliffy `.json` exports |
| yEd | `.graphml` |
| Lucidchart | `.json` files with Lucidchart document data, the format draw.io's own Lucidchart import reads. Lucidchart can also export `.vsdx`, which opens as Visio. |
| Miro | `.json` files with the board data Miro puts on the clipboard when you copy shapes (it starts with `{"isProtected":`). Miro board backups (`.rtb`) are not supported. |
| CSV | `.csv` files in draw.io's CSV format: rows plus `# label:`, `# style:`, `# connect:` and `# layout:` lines that turn them into shapes, connectors and a layout (see **Arrange > Insert > Advanced > CSV** in draw.io). Without those lines, each row becomes one shape. |

-   The conversion is done by draw.io's own importers, inside VS Code, in a draw.io panel of its own that closes again when it is done, so open diagrams are not affected. Nothing is uploaded. This uses the draw.io bundled with the extension (`drawio-ai.offline`, on by default).
-   Existing files are never replaced: if `network.drawio` exists, the new diagram is `network-2.drawio`.
-   What did not carry over is reported when the diagram opens: shapes with no draw.io equivalent, parts of a binary Visio file that could not be read, images that are linked from the web instead of embedded. **Show Details** lists everything.
-   Visio 2003–2010 XML files (`.vdx`, `.vsx`, `.vtx`) cannot be converted; save them as `.vsdx` in Visio first.

## Claude Code and Codex

Draw.AI's diagram tools also work from Claude Code and Codex, whether you run them in VS Code's terminal, in their own VS Code panels, or elsewhere on the same computer. Edits appear live in the Draw.AI editor, held for review like any other AI edit.

1. Run **Draw.AI: Connect Claude Code / Codex…** (also in the MCP status bar item's menu).
2. Pick the agents. Draw.AI shows the exact commands it will run, turns on its MCP server if needed, and installs its plugin:
    - Claude Code: `claude plugin marketplace add ~/.drawio-ai/agent-plugin` and `claude plugin install draw-ai@draw-ai`
    - Codex: `codex plugin marketplace add ~/.drawio-ai/agent-plugin` and `codex plugin add draw-ai@draw-ai`
3. Start a new Claude Code or Codex session and ask for a diagram, for example "draw our checkout flow in docs/checkout.drawio".

The plugin adds:

-   **Skills** that teach the agent how to build, review and code-link diagrams well. The same skills are offered to Copilot in VS Code.
-   **The `drawio_*` and `mapper_*` tools**, through a small bridge that runs on VS Code's own runtime (no Node.js needed). It finds the VS Code window that has the diagram, so several windows work at once and no token has to be copied.

Agents name a diagram with `file` (for example `docs/architecture.drawio`): it opens beside your work without taking keyboard focus, so you can watch. `drawio_list_diagrams`, `drawio_search_diagrams` and `drawio_create` find and make diagrams. Without `file`, the tools act on the diagram you have open. In a diagram with several pages, agents read any page with `page` and switch pages with `drawio_pages`; edits go to the page shown, so you see them.

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

## Using Draw.AI Next to Draw.io Integration

Draw.AI is a fork of Draw.io Integration (`hediet.vscode-drawio`) and includes everything it does. If both are enabled, VS Code may open diagrams in Draw.io Integration, where Draw.AI's lasso, review and AI tools are not available. Draw.AI says so when it starts: choose **Use Draw.AI for Diagrams** (or run **Draw.AI: Use Draw.AI for Diagram Files**), which makes Draw.AI the editor for `.drawio`, `.dio`, `.drawio.svg` and `.drawio.png` files, or disable Draw.io Integration.

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

## Mapper

**Draw.AI: Map Something…** (also in the Start view and the diagram's `…` menu) draws a system into the open diagram: software, databases, Azure, AWS, Google Cloud and machine-learning systems. It is the Mapper of the OmniDraw desktop app, with the same maps.

| Category | Maps |
| --- | --- |
| Software | Connectivity, data flow, module dependencies, class diagram, API surface, GitHub Actions workflows, Kubernetes |
| Databases | Schema (ERD) of PostgreSQL, MySQL / MariaDB, SQL Server / Azure SQL, Oracle, SQLite and MongoDB; dbt lineage |
| Azure, AWS, Google Cloud | The live environment through your signed-in `az`, `aws` or `gcloud`; infrastructure as code (Terraform, Bicep, ARM, CloudFormation, CDK, Deployment Manager) |
| Machine learning | Pipelines, MLflow tracking and registry, the end-to-end lifecycle, model architecture |

-   **Read-only.** A map is collected with listing, describing and querying commands only (a guard refuses anything else), fixed catalog queries in read-only database sessions, and file reads. Nothing in your systems is changed.
-   **Secrets.** Passwords, connection strings and tokens are used for that run only. They are never stored, drawn on the map or sent to the agent.
-   **Keep or revert.** A map is drawn on a page of its own as a pending change, like any AI edit.
-   **Next to the diagram.** What the Mapper knows about each map (its shapes, findings, descriptions, tours) is kept in `.drawai/maps/` beside the diagram, so it travels with the repository. The diagram has to be a file on disk, and the workspace has to be trusted: the Mapper runs `git` and your cloud CLIs in it. A diagram you rename or move in VS Code keeps its maps.

The **Maps** view (Draw.AI in the activity bar) lists the maps of the diagram you used last:

-   **Findings**: health problems the map shows (a port open to the internet, a table without a primary key, a gap in an ML lifecycle), worst first, with a badge on the shapes concerned. Click one to select its shapes; the buttons beside it hand it to the agent to fix, or dismiss it until it changes. The tooltip of **Findings** says what was checked.
-   **Tours**: click one to play it in presentation mode, step by step with captions.
-   Right-click a map to have the agent describe every shape in plain English (shown as tooltips), build a tour, see what changed in git since the map was made, or map it again and mark what is new.
-   **Ask the Map…** (the view's title bar) has the agent answer a question from the maps and draw the answer as a page. **Draw.AI: Dig Deeper into Selected Map Shapes…** has it investigate the shapes you selected.

The agent works through 13 `mapper_*` tools (`mapper_maps`, `mapper_find`, `mapper_show`, `mapper_path`, `mapper_findings`, `mapper_run` and others), in VS Code's chat with the **Draw.AI** agent (and `@drawio`) and, once connected, in Claude Code and Codex. When the agent starts a map itself, you are asked first, and stopping the chat request stops the map.

## Shape Workshop

**Draw.AI: Shape Workshop…** (also the Workshop button in the diagram's toolbar, **+ More Shapes** under the shapes sidebar, the Start view and the diagram's `…` menu) is the Shape Workshop of the OmniDraw desktop app. Its first part is the **Shape Gallery**:

-   **Galleries** of icons and logos: theSVG (open licences only), Tech logos (devicon and Simple Icons) and UI icons (Lucide and Tabler) are listed and **switched off** to start with. Switch one on to use it. You can also add a public GitHub repository of SVGs, a folder of SVG or PNG files, or a draw.io library file.
-   **Collections** you fill yourself from any gallery, and export as a draw.io library.
-   **Search** across the galleries that are on, and click a shape to put it in the diagram you used last.
-   A gallery that is on is also a **palette in the shapes sidebar** of every diagram (a first page of it), and **draw.io's own search** in that sidebar finds its shapes. The AI's `drawio_search_shapes` tool gets a few of the small ones too (a shape whose image is larger than about 4 KB is left out: it would fill the model's context).
-   A gallery that is **off stays off**: it cannot be browsed, synced or made available offline until you switch it on, and restored default galleries come back switched off.
-   **draw.io's own shape sets** (General, UML, AWS, …) and the **Scratchpad** are switches in the Workshop, where draw.io's More Shapes dialog used to be. They are kept for every diagram.

Shapes are downloaded only for galleries you switched on, only from jsDelivr and GitHub (`cdn.jsdelivr.net`, `data.jsdelivr.com`, `raw.githubusercontent.com`), and are kept in the extension's storage for offline use. Every SVG is cleaned of scripts and external links before it is shown or put in a diagram. Shape Shifter and Shape Creator, the Workshop's other two parts, are not there yet.

## Editor Tools and Look

The diagram editor has the editor tools and the look of the OmniDraw desktop app:

-   **Toolbar buttons** for Layers, Tags, Outline, the ruler and presentation mode. The first button opens and closes the Shapes panel with one click; the dot mark at the start of the toolbar opens the settings below.
-   **Presentation mode** (the toolbar button, or **Draw.AI: Presentation Mode** in the Command Palette): only the diagram, read-only, filling the editor. **Exit** is at the bottom left, **Previous** / **Next** at the bottom right, and pages are dots. The arrow keys, Tab and Space step through the pages; Esc leaves. Presenting changes nothing in the file. For the whole screen, use VS Code's own full screen or Zen Mode with it.
-   **The look**: warm paper in light mode, black in dark mode, a dot matrix behind the toolbars and panels (never over the diagram), and quick tooltips.

| Setting | What it does |
| --- | --- |
| `drawio-ai.look.theme` | `omni` (default) or `drawio` for draw.io's standard colours and font. Light or dark follows `drawio-ai.appearance` either way; set that to `automatic` to follow VS Code's theme. |
| `drawio-ai.look.icons` | `classic`, `dots2d` (default), `dots` or `real`. |
| `drawio-ai.look.matrix` | `grey` (default), `green` or `off`. |
| `drawio-ai.look.toolbar` | `top` (default), `left`, `right` or `bottom`. |
| `drawio-ai.look.editorTools` | `false` turns all of the above off: the editor as it was before 0.4. |

Icons, the matrix and the toolbar's place change in the open editor; the theme and `editorTools` load the editor again. With draw.io's `min`, `simple` and `sketch` themes (`drawio-ai.theme`), which have toolbars of their own, the editor gets presentation mode and quick tooltips only. Read-only views (a diff, an old version) are not changed.

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
