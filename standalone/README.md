# Draw.AI desktop (standalone)

A desktop app for draw.io diagrams with an AI chat beside the editor. It does not
use its own model API keys: the chat drives a coding agent you already have
installed and signed in to — **Claude Code**, **Gemini** (Google's Antigravity CLI, or
Gemini CLI) or **Codex** — over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP). The agent edits the
open diagram live through Draw.AI's diagram tools, and you keep or revert its
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

| Agent | Install | Sign in | How Draw.AI starts it |
| --- | --- | --- | --- |
| Claude Code | `npm i -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp` | `claude` → `/login` | `claude-agent-acp` (or `npx -y @agentclientprotocol/claude-agent-acp`) |
| Gemini (Antigravity CLI) | `agy`, from [antigravity.google](https://antigravity.google) | `agy acp --login` (or sign in from `agy`) | `agy acp` |
| Gemini CLI (fallback when `agy` is not installed) | `npm i -g @google/gemini-cli` | `gemini` | `gemini --acp` |
| Codex | `npm i -g @openai/codex @agentclientprotocol/codex-acp` | `codex login` | `codex-acp` (or `npx -y @agentclientprotocol/codex-acp`) |

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
  (allow once / always / reject) and waits for you.
- **Review**: the agent's edits appear as pending changes; **Accept** keeps them,
  **Reject** reverts them (also under the **Agent** menu).
- **File menu** (both the app menu and draw.io's own File menu in the editor): New,
  Open, Save, Save As, Export as PDF (vector, one PDF page per diagram page, via
  Chromium's `printToPDF`), Export to any format (PDF, editable SVG and PNG, Visio
  `.vsdx`, `.drawio`), Open from Another Tool (Visio, Gliffy, yEd/GraphML, Lucidchart,
  Miro: converted by draw.io into a new window), and Print (every page, fitted to the
  paper, through the system print dialog). draw.io's in-editor File menu is replaced by
  `src/renderer/desktop-menu.js`, a draw.io plugin loaded after the Draw.AI one.

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

## Settings

**Draw.AI → Settings…** opens `settings.json` in the app's data folder. Everything
is optional:

```json
{
	"agents": { "codex": { "command": "/opt/tools/codex-acp", "args": [], "env": {} } },
	"chatWidth": 420,
	"editor": { "drawio-ai.reviewChanges": true, "drawio-ai.flashChanges": true }
}
```

## Development

- `yarn build` — bundle to `out/`; `yarn typecheck` — TypeScript, including the
  shared `../src` modules it uses.
- `yarn e2e` — opens an example in the real app, calls the window's MCP endpoint,
  exports PDF/SVG and screenshots the editor and chat into a temp folder.
  `yarn e2e --agent claude` (or `gemini`, `codex`) also sends one prompt through that
  agent over ACP, auto-approving its permission requests, and fails if the diagram
  did not change. `--click-permissions` answers them by clicking the permission card
  in the chat instead. `--prompt "…"` and `--file path` pick the request and diagram.
- View → Editor/Chat Developer Tools for the two web views.
