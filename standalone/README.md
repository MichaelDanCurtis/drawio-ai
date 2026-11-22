# OmniDraw (desktop app)

*Formerly the Draw.AI desktop app. The VS Code extension keeps the name Draw.AI.*

A desktop app for draw.io diagrams with an AI chat beside the editor. It does not
use its own model API keys: the chat drives a coding agent you already have
installed and signed in to — **Claude Code**, **Gemini** (Google's Antigravity CLI, or
Gemini CLI), **Codex**, **GitHub Copilot** or **Kimi** — over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The agent edits the
open diagram live through OmniDraw's diagram tools, and you keep or revert its
changes.

## Run it

```bash
cd standalone
yarn
yarn start
```

`yarn start` checks out the draw.io webapp (the repository's `drawio` submodule,
depth 1) if it is missing, builds the app with esbuild, and launches Electron.
Pass a diagram to open it: `yarn start ../examples/use-cases/cloud-architecture.drawio`,
or use **File → Open Example…**.

Requirements: Node 20+, macOS (Linux and Windows should work but are untested), and
at least one agent:

| Agent | Install | Sign in | How OmniDraw starts it |
| --- | --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp` | `claude` → `/login` | `claude-agent-acp` (or `npx -y @agentclientprotocol/claude-agent-acp`) |
| Gemini (Antigravity CLI) | `agy`, from [antigravity.google](https://antigravity.google) | `agy acp --login` (or sign in from `agy`) | `agy acp` |
| Gemini CLI (fallback when `agy` is not installed) | `npm i -g @google/gemini-cli` | `gemini` | `gemini --acp` |
| Codex | `npm i -g @openai/codex @agentclientprotocol/codex-acp` | `codex login` | `codex-acp` (or `npx -y @agentclientprotocol/codex-acp`) |
| GitHub Copilot | `npm i -g @github/copilot` | `copilot` → `/login` | `copilot --acp` |
| Kimi | Kimi Code CLI, from [moonshotai.github.io/kimi-code](https://moonshotai.github.io/kimi-code/) | `kimi login` | `kimi acp` |

Google has moved personal Google accounts from Gemini CLI to the Antigravity CLI:
Gemini CLI now refuses them ("This client is no longer supported for Gemini Code Assist
for individuals"), so the Gemini entry uses `agy` when it is installed. Gemini CLI still
works with an API key or Vertex AI.

The ACP adapters for Claude Code and Codex are fetched with `npx` on first use when
they are not installed globally. The agent picker in the chat shows which agents are
installed and look signed in; when one is not, the chat says what to run (and offers
**Sign In** when the agent supports signing in over ACP).

## What it does

- **Files**: opens and saves `.drawio`, `.dio`, `.drawio.svg` and `.drawio.png`
  (one window per diagram), with unsaved-change prompts.
- **Editor**: the same bundled draw.io webapp and Draw.AI plugin as the VS Code
  extension (lasso, inline prompt with Alt+K, markup, review highlights), offline:
  the editor may only load from the app's own 127.0.0.1 server.
- **Chat**: the extension's chat panel (`src/features/ai/chatView.html`, adapted as
  `src/renderer/chat.html`). Pick the agent and its model or mode at the top. Agent
  replies, thoughts, tool calls and plans stream in; when the agent asks for
  permission (to run a tool, edit a file, ...) the chat shows the agent's options
  (allow once / always / reject) and waits for you. **Allow all** on a request approves it and everything
  else the agent asks for in that chat (shown as one-line ⚡ entries) until New Chat,
  switching agents, or a click on the ⚡ Allow all chip at the top; also under the
  **Agent** menu.
- **Review**: the agent's edits appear as pending changes; **Accept** keeps them,
  **Reject** reverts them (also under the **Agent** menu).
- **File menu** (both the app menu and draw.io's own File menu in the editor): New,
  Open, Save, Save As, Export as PDF (vector, one PDF page per diagram page, via
  Chromium's `printToPDF`), Export to any format (PDF, editable SVG and PNG, Visio
  `.vsdx`, `.drawio`), Open from Another Tool (Visio, Gliffy, yEd/GraphML, Lucidchart,
  Miro: converted by draw.io into a new window), and Print (every page, fitted to the
  paper, through the system print dialog). draw.io's in-editor File menu is replaced by
  `src/renderer/desktop-menu.js`, a draw.io plugin loaded after the Draw.AI one.

## Mapper

**Map → Map Something…** (Cmd/Ctrl+Shift+M), or **🗺 Map…** in the chat, maps a
system into the diagram. Every map is collected **read-only**, drawn as one pending
change on its own page (keep or revert it like any AI change), and can then be handed
to your agent to review, complete or dig into.

| Category | Maps |
| --- | --- |
| Software | Connectivity (services, databases, queues, external APIs from compose, Kubernetes YAML, config and code), data flow (entry points; the agent traces the flows), module dependencies, class diagram, API surface (OpenAPI/Swagger, GraphQL), GitHub Actions workflows, live Kubernetes cluster |
| Databases | Schema/ERD for PostgreSQL, MySQL/MariaDB, SQL Server/Azure SQL, Oracle, SQLite and MongoDB (fields inferred from sampled documents); dbt lineage |
| Azure | Subscription › resource groups › VNets › subnets › resources (Resource Graph or `az` list commands); infrastructure as code (Bicep, ARM, Terraform) |
| AWS | Account › regions › VPCs › subnets › services, with load balancer, event source, subscription and security-group edges; infrastructure as code (Terraform, CloudFormation/SAM, CDK) |
| Google Cloud | Project › VPCs › regions › subnetworks › resources (Cloud Asset Inventory); infrastructure as code (Terraform, Deployment Manager) |
| Machine learning | Pipelines (DVC, Kubeflow/Vertex, Argo, Azure ML, SageMaker, Airflow, Metaflow), MLflow tracking and registry, the end-to-end lifecycle (with gaps marked), model architecture (Hugging Face config + safetensors, GGUF, ONNX, XGBoost, LightGBM) |

- **Read-only.** Cloud and Kubernetes maps use your signed-in CLIs (`az`, `aws`,
  `gcloud`, `kubectl`) through a guard that only lets listing, describing and querying
  commands run; databases are read with fixed catalog queries in read-only sessions.
  Passwords, connection strings and tokens are used for the run only: they are never
  stored, drawn, or sent to the agent.
- **Dig deeper.** Select shapes on a map and press **🔎 Dig deeper** in the chat (or
  Map → Dig Deeper into Selection, Cmd/Ctrl+Shift+D); type a question first to focus
  it. The agent investigates with the ids stored on the shapes (resource ids, ARNs,
  files and lines), read-only, and you approve each command it wants to run.
- **Agent follow-up.** Tick *Then ask the agent to review and annotate the map* in the
  Mapper to have the agent add review notes (exposure, single points of failure,
  design issues) with the collected facts.

### Map insights

Every map is also saved as a record next to the diagram, in `.drawai/maps/<id>.json`
(what was mapped, the graph, findings, descriptions, tours, the git commit it was made
at; never passwords or tokens). The chat's **Map ▾** menu, and the **Map** menu, work
on the maps of the page shown:

- **Health findings.** Mapping also runs checks (exposed databases and ports, public
  buckets, missing encryption or backups, wide-open security groups, unpinned or
  over-privileged GitHub Actions, secrets in config, tables without primary keys, ...),
  drawn as red/amber/blue **!** badges on the *Health* layer. **Map ▾ → Findings**
  (the button shows ⚠ and the count) lists them with the evidence and a suggested fix:
  *Show on map*, *Fix with agent* (the agent proposes the change; it never changes live
  resources itself), or *Dismiss* (hidden until the finding changes). Each list ends
  with what was checked, so an empty list means something.
- **Plain-English descriptions.** **Describe the map** has the agent write one or two
  sentences per shape, from evidence (who uses it, what it uses, its code), for
  everyone or for developers. They become the shapes' tooltips. Descriptions are
  checked before they are saved: unknown shapes, placeholders, and jargon (for the
  "everyone" audience) are sent back to the agent. Also an option in the Mapper.
- **Recent changes.** Files changed in git since the map was made (committed and
  not), mapped onto its shapes with green badges on the *Changes* layer, with the
  commits.
- **Refresh.** Maps the same thing again onto a new page and tags what is new or
  changed; descriptions and tours of shapes that still exist carry over. Maps that need
  a password are refreshed from the Mapper.
- **Tours.** **Build a tour** has the agent write a guided walk through the map (type
  a focus first, e.g. "how an order is paid"). Play it with **Map → Play Tour**
  (Cmd/Ctrl+Shift+T) or the ▶ button in presentation mode: each step zooms to its
  shapes, highlights them and shows the caption; arrow keys or space to move, Esc to
  stop.
- **Ask the map.** Type a question, then **Map ▾ → Ask the map**: the agent looks it
  up on the maps and answers with a new page holding only the shapes involved,
  numbered in order, with its answer.

The agents reach the maps through MCP tools on each window's server: lookups
(`mapper_maps`, `mapper_find`, `mapper_show`, `mapper_path`, `mapper_findings`,
`mapper_worksheet`) and `mapper_run`, `mapper_set_descriptions`,
`mapper_recent_changes`, `mapper_refresh`, `mapper_set_tour`, `mapper_answer`.

### Use the maps from Claude Code and Codex

While the app runs, it serves the same diagram and Mapper tools to coding agents
anywhere on this computer. **Agent → Connect Claude Code / Codex to OmniDraw…** registers
a `draw-ai-desktop` MCP server in both (user scope, with `claude mcp add` and `codex mcp
add`); **Disconnect** removes it. Then, in a terminal session, an agent can ask the map
before grepping ("what talks to orders-db?", "map this repo and describe it"). Every
tool takes an optional `file`: the diagram to work on, opened if needed; without it, the
diagram used last. `drawio_list_diagrams` lists the open ones.

The app writes its address and a per-launch token to `~/.drawio-ai/desktop.json`
(readable only by you) and a launcher, `~/.drawio-ai/bin/draw-ai-desktop-mcp`, that the
agents start as a stdio MCP server; the launcher reads that file on every request, so a
connected agent keeps working across app restarts. To register it by hand:

```bash
claude mcp add --scope user draw-ai-desktop -- ~/.drawio-ai/bin/draw-ai-desktop-mcp
```

## Presentation mode

**View → Presentation Mode** (F5, Cmd/Ctrl+Shift+Enter, or the screen button in the
toolbar) shows only the diagram, full
screen and read-only. Drag with either mouse button to move around, scroll or pinch to
zoom, F to fit. Pages are dots in the bottom left: click one, or use Tab / Shift+Tab or
the arrow keys. Esc returns to the editor. Presenting never edits or marks the diagram
as changed. Pages with a map tour show ▶ next to the dots to play it.

## Look

The app's own pages (the chat, the Mapper, the presentation overlay) and draw.io's
chrome use one design language: warm paper and ink in light mode, OLED black in dark,
Space Grotesk with Space Mono caps labels, flat hairline cards, an ink primary button,
and one signal red for the single thing that needs you (a permission request, the
findings count, the current tour step). Depth comes from dots: a live dot field behind
the chat and Mapper heads that leans away from the pointer and ripples when you switch
agents or start a new chat, and a 3D dot object (stacked diagram layers) while the chat
is empty. Motion is short and ease-out only: messages, menus, cards and tour captions
rise in. Under *reduce motion* nothing moves.

- Tokens, motion and the dot modules: `src/renderer/ui/` (from the `omni-design`
  skill), served at `/ui/`. The fonts are self-hosted from `@fontsource` packages
  (`build.mjs` copies them).
- draw.io's chrome: `src/renderer/theme.js`, a draw.io plugin that only changes
  draw.io's theme variables, its UI font and its primary buttons, never diagrams.
- Icons: `src/renderer/ui/icons.js` draws every icon (the chat's, Settings' and draw.io's
  toolbar) from one flat glyph set in four styles: classic (flat), isometric line,
  dot-matrix 3D and soft extruded. Each glyph is stood up in 3D, given depth and turned
  a little; `src/renderer/desktop-toolbar.js` swaps draw.io's own toolbar images.
- The toolbar: the OmniDraw dot mark first (opens Settings; every few seconds its dots draw a circle, a face, a diamond, a plus, a wave, a heart or a spiral and come back to the square, `ui/brandmark.js`); Layers, Tags, Outline and
  Presentation mode as buttons; a chat button at the right end. The panel menu keeps
  only Shapes, Ruler and Fullscreen (Format and Find/Replace have their own places).
- The chat slides away and back (the button in its head, the toolbar's chat button, or
  Cmd/Ctrl+J), docks left or right, and resizes by dragging its inner edge. Its agent
  and model pickers are in-app menus that show each model's version and description.
- **Menus are in the system menu bar**, like any Mac app: File, Edit, View, Arrange and
  Extras come from draw.io (`src/renderer/desktop-menubar.js` records draw.io's menus with a
  popup that is never shown, whenever the editor's state may change, and the app builds the
  native menus from that). draw.io's own in-window menu bar is hidden. Undo, Redo and Select
  All act on the diagram when it has focus and on text otherwise; draw.io's other shortcuts
  are shown in the menus and still handled by draw.io.
- The toolbar can sit on any side (Settings → Appearance → Toolbar); draw.io lays its editor
  out with a CSS grid, and `desktop-toolbar.js` moves the toolbar's area.
- `DRAWAI_THEME=light|dark` forces the appearance (for checks and screenshots).

## How it works

```
Electron main process                          agent subprocess (cwd = diagram folder)
 ├─ DiagramWindow (per diagram)                 claude-agent-acp | gemini --acp | codex-acp
 │   ├─ editor view: draw.io + Draw.AI plugin        ▲  ACP (JSON-RPC over stdio)
 │   │    └─ CustomizedDrawioClient (IPC)            │  initialize, session/new, session/prompt,
 │   ├─ chat view: chat.html  ◀── ChatController ────┘  session/update, session/request_permission
 │   └─ WindowMcpServer 127.0.0.1:<port>/mcp  ◀──────── MCP (Streamable HTTP, bearer token),
 │        └─ DiagramToolbox → the window's editor        passed to the agent in session/new
 └─ StaticServer 127.0.0.1: draw.io webapp, plugin, pages
```

- The ACP client is the official SDK, `@agentclientprotocol/sdk`
  (`src/main/acpSession.ts`). Each window has at most one agent process and one
  session; switching agents or **New Chat** starts a new one.
- Each window runs an MCP server backed by its live editor (`src/main/mcpServer.ts`),
  reusing the extension's MCP handler (`src/features/ai/mcp.ts`), tool schemas and
  `DiagramToolbox` unchanged. It is handed to the agent in `session/new` as an HTTP
  MCP server when the agent supports that, otherwise as a stdio server
  (`out/mcp-stdio-proxy.js`, run with Electron's Node) that forwards to the same
  endpoint. Tools that need VS Code (workspace search, code links, imports) are left
  out; `file` arguments are dropped because a window is one diagram.
- Antigravity CLI (agy 1.5) silently leaves out MCP tools with large definitions (in
  testing, tools up to ~690 bytes of JSON were offered to the model; from ~720 bytes they
  were "not enabled"). For it, the server sends shortened descriptions and, for the large
  tools (`drawio_apply_operations`, `drawio_pages`, ...), only parameter names and types;
  the full descriptions and JSON Schemas are in the server instructions, which it reads
  (`compactTools` in `src/main/mcpServer.ts`). Other agents get the full definitions.
- The draw.io page is the extension's `src/DrawioClient/webview-content.html`,
  served unchanged; a preload recreates the `acquireVsCodeApi()` bridge over IPC.
  The Draw.AI plugin is built from `drawio-custom-plugins/` by `build.mjs`.
- Each window is a `BaseWindow` holding two `WebContentsView`s (editor, chat). A
  `BrowserWindow` would add its own, empty page in front of them on macOS, which gets
  in the way of mouse events such as hover.
- Shared code is imported read-only from `../src`; `vscode` imports resolve to a
  small shim (`src/main/vscode-shim.ts`).

## Build a release

```bash
yarn dist:mac
```

builds `dist/OmniDraw-<version>-arm64.dmg` and a `.zip` with electron-builder (`yarn dist`
for the current platform). The draw.io webapp and the examples ship as resources. Agents
run the stdio MCP proxy from `app.asar.unpacked`. The macOS build has an ad-hoc
signature (`build.mac.identity: "-"`), not a Developer ID: without one, a downloaded copy
counts as damaged on Apple silicon. Set `build.mac.identity` to the Developer ID (and add
notarization) once a certificate is available. `node scripts/e2e.mjs --app
dist/mac-arm64/OmniDraw.app/Contents/MacOS/OmniDraw` runs the end-to-end check against
the packaged app.

## Settings

**OmniDraw → Settings…** (Cmd/Ctrl+, or the dot mark at the start of the toolbar) opens the Settings
window. Changes save at once and reach open windows straight away:

- **Appearance:** System, Light or Dark; the toolbar on the top, left, right or bottom; the icon style.
- **Agents & models:** for each agent, the models its picker shows (an agent lists its
  models the first time it runs), the model a new chat starts with, and the command that
  launches it.
- **Chat:** which side it docks on, its width, starting tucked away, and "Allow all" by
  default.
- **Editor:** reviewing AI changes, flashing and selecting changed shapes, how many
  shapes the agent gets as context.
- **Shapes:** folders of SVG/PNG files and draw.io library files (`.xml`), shown as
  palettes in the shapes sidebar (up to 400 images per folder, two levels deep; links
  out of a folder are skipped).

Everything lives in `settings.json` in the app's data folder ("Open settings.json" in
the window), for example:

```json
{
	"appearance": { "theme": "dark", "iconStyle": "isometric" },
	"chat": { "side": "right", "startCollapsed": false, "allowAllByDefault": false },
	"models": { "claude": { "hidden": ["haiku"], "preferred": "opus" } },
	"agents": { "codex": { "command": "/opt/tools/codex-acp", "args": [], "env": {} } },
	"shapes": { "locations": [{ "path": "/Users/me/Icons", "enabled": true }] }
}
```

## Development

- `yarn build` — bundle to `out/`; `yarn typecheck` — TypeScript, including the
  shared `../src` modules it uses.
- `node --test test/*.test.js` — unit tests (Mapper core, every collector with
  fixtures; `MAPPER_DB_LIVE=1` adds the live database tests, see
  `test/fixtures/database/live/`).
- `yarn e2e` — opens an example in the real app, calls the window's MCP endpoint,
  exports PDF/SVG and screenshots the editor and chat into a temp folder.
  `yarn e2e --agent claude` (or `gemini`, `codex`, `copilot`, `kimi`) also sends one prompt through that
  agent over ACP, auto-approving its permission requests, and fails if the diagram
  did not change. `--map <recipe> --map-input '{…}'` draws a map (add `--map-dialog`,
  `--ask-agent`, `--dig "question"`); `--present` checks presentation mode.
  `--click-permissions` answers them by clicking the permission card
  in the chat instead. `--prompt "…"` and `--file path` pick the request and diagram.
- View → Editor/Chat Developer Tools for the two web views.
