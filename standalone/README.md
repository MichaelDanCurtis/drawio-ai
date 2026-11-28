# OmniDraw (desktop app)

*Formerly the Draw.AI desktop app. The VS Code extension keeps the name Draw.AI.*

A desktop app for draw.io diagrams with an AI chat beside the editor. The chat drives a
coding agent you already have installed and signed in to — **Claude Code**, **Gemini**
(Google's Antigravity CLI, or Gemini CLI), **Codex**, **GitHub Copilot** or **Kimi** — over
the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). The agent edits the
open diagram live through OmniDraw's diagram tools, and you keep or revert its
changes.

The app has no model API keys of its own. You can add yours (Anthropic, OpenAI, Gemini, Grok,
Kimi, OpenRouter) to use a provider's models without an agent program, in the chat and
everywhere else an agent is used: see [API keys](#api-keys).

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
  (one window per diagram), with unsaved-change prompts. Excalidraw drawings
  (`.excalidraw`) are a second kind of document: see [Excalidraw drawings](#excalidraw-drawings).
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
  **Agent** menu. Under **With an API key** the same picker lists the providers whose models
  answer without an agent program: see [the chat with an API key](#the-chat-with-an-api-key).
- **While it works** the box stays open. What you send then waits in a strip above the box
  (✕ takes it back) and reaches the model with the next answer of one of the diagram's tools,
  so it reads it as it works; the chat shows it there as "added while it works". What could
  not be handed over (no tool answered after it, or it has images) is sent as the next request
  when this one ends, one at a time. Each keeps what was selected in the diagram as you sent it. After Stop, an error or New Chat nothing is sent by itself: what was
  waiting goes back into the box. Up to eight things wait, with four pictures between them;
  one more stays in the box. A request made elsewhere in the app meanwhile (the Mapper's, the
  Shape Workshop's "Ask the agent") waits there too, under its own name: it is a task of its
  own, so it is never handed over mid-request and follows as the next one. After Stop it is
  not sent; the chat says so. Works with agents and with API models alike (`mcpServer.ts`,
  `userUpdate`). The tags that mark an addition as yours are taken out of what a tool itself
  answers (`withoutUpdateTags`), so text in a diagram or a mapped folder cannot pass for you.
- **Review**: the agent's edits appear as pending changes; **Accept** keeps them,
  **Reject** reverts them (also under the **Agent** menu).
- **File menu** (both the app menu and draw.io's own File menu in the editor): New,
  Open, Save, Save As, Export as PDF (vector, one PDF page per diagram page, via
  Chromium's `printToPDF`), Export to any format (PDF, editable SVG and PNG, Visio
  `.vsdx`, `.drawio`), Open from Another Tool (Visio, Gliffy, yEd/GraphML, Lucidchart,
  Miro: converted by draw.io into a new window), and Print (every page, fitted to the
  paper, through the system print dialog). draw.io's in-editor File menu is replaced by
  `src/renderer/desktop-menu.js`, a draw.io plugin loaded after the Draw.AI one.

## Excalidraw drawings

The app also opens, edits and saves [Excalidraw](https://github.com/excalidraw/excalidraw)
drawings, in the real Excalidraw editor (the `@excalidraw/excalidraw` package, MIT, used as
it is), offline. **File → New Excalidraw Drawing** (Cmd/Ctrl+Alt+N) starts one; **File →
Open…**, a double-click on a `.excalidraw` file, or a `.excalidraw` file dropped on a drawing's
window opens one. A drawing has a window of its own in the same shell as a diagram's: the editor
on one side and the chat on the other, the file's name in the title with a dot while there are
unsaved changes, Save and Save As, and the question before a window with unsaved changes closes.

- **Files.** A `.excalidraw` file is Excalidraw's own JSON (`type: "excalidraw"`,
  `version: 2`, `source`, `elements`, `appState`, `files`), written as Excalidraw writes it,
  so it opens in excalidraw.com and in every other tool that reads the format. A PNG or SVG
  that carries a drawing (an export with the scene embedded) opens as a drawing too, and is
  saved back as the picture it is: **Save As** offers **Editable PNG** (`.excalidraw.png`) and
  **Editable SVG** (`.excalidraw.svg`) beside `.excalidraw`. A picture without a drawing in it
  opens as before, in draw.io. What is not a drawing (an Excalidraw library, other JSON, a
  damaged file) is refused with a sentence that says what it is, and no window opens.
- **Export.** **File → Export as PNG…** (Cmd/Ctrl+Shift+E) and **Export as SVG…**, or **PNG**
  and **SVG** in the bar above the canvas. Both carry the drawing inside
  (`appState.exportEmbedScene`), so an export opens again for editing, here or in Excalidraw.
  The PNG is twice the drawing's size, for sharp lines; the SVG holds its fonts, cut down to the
  letters the drawing uses. Before a file is written the app checks what the editor handed
  over: a `.excalidraw` file must be a whole drawing, and a picture must carry the drawing.
- **Offline.** Nothing is loaded from a CDN. Excalidraw's fonts (the hand-drawn ones and its
  UI's) are copied into the app and served by it (`window.EXCALIDRAW_ASSET_PATH`). Excalidraw
  also names a CDN as a second address for every font; that address is taken out before the
  browser sees it. A web page cannot be embedded in a drawing, and Excalidraw's own
  text-to-diagram features (which call a service) are off. The Mermaid import works: it is part
  of the package.
- **Look.** Light and dark follow **Settings → Appearance**. The bar above the canvas (the
  drawing's name, the unsaved dot, Export, Save, and the chat's button when the chat is closed)
  is in the app's look; Excalidraw's own UI is not restyled. The first entries of Excalidraw's
  menu (☰) are the app's: New drawing, Open, Save, Save as, Export.
- **Menu bar.** While a drawing is in front the menu bar is the drawing's: File, Edit (Undo, Redo
  and Select All are Excalidraw's on the canvas and the system's in a text field), View, Window.
  draw.io's menus, Shapes, Agent and Map are not there: they work on diagrams.
- **Chat.** The panel stays in the window, and says that AI editing of Excalidraw drawings is
  not there yet: the agents' drawing tools are draw.io's. No agent is started for a drawing and
  the chat offers no tools; it still closes (Cmd/Ctrl+J), resizes and opens Settings.

Not there yet: AI tools for drawings, a home with preview cards and version history, sharing a
drawing through Go live, and converting between draw.io and Excalidraw. Excalidraw's shape
library is kept while a window is open, not between runs.

The Excalidraw page has a Content-Security-Policy of its own (`src/renderer/excalidraw.html`):
scripts from the app only, as on the app's other pages, and styles inline too, because
Excalidraw and its Mermaid import write them. `'wasm-unsafe-eval'` is not in it and is not
needed. Excalidraw uses WebAssembly for one thing, cutting a font down to the letters a drawing
uses for an SVG export, and does that in a worker; a worker is bound by the policy its own
script is served with, not the page's, and the app serves it with none. On the page itself
WebAssembly is refused, and the end-to-end check confirms both: the refusal, and an SVG whose
fonts are a few kilobytes. (Were the worker ever missing, Excalidraw would put the whole font
files in the SVG instead; the export would still work.)

It adds 21.7 MB to the app (15.9 MB compressed): 13.1 MB of fonts, 12.7 MB of them the
hand-drawn Chinese, Japanese and Korean font in 209 pieces of which a drawing loads only those
it uses; 7.6 MB of parts that load when they are used (Excalidraw's languages, the Mermaid
import, font subsetting); under 1 MB for the editor page itself. Excalidraw's licence (MIT)
is in the app beside it (`src/renderer/excalidraw/NOTICE.txt`).

## Mapper

**Map → Map Something…** (Cmd/Ctrl+Shift+M), or **🗺 Map…** in the chat, maps a
system into the diagram. Every map is collected **read-only**, drawn as one pending
change on its own page (keep or revert it like any AI change), and can then be handed
to your agent to review, complete or dig into.

**A repository on GitHub** goes where a folder goes (`mapper/repository.ts`): its address from
the browser (also of a branch, or of a folder in it), its clone address, or `owner/name`, with
`@branch` for a branch, tag or commit. Its newest state, without history, is downloaded into
`mapped-repos` in the app's data folder with the access to GitHub this computer already has
(git's own saved sign-in, then the GitHub CLI's, then an SSH key; it never asks at a prompt) and
read there like any folder, so the agent can read its files too. Each download is of one commit
and has a folder of its own (`mapped-repos/github.com/<owner>/<repo>/<commit>/<repo>`: called
what the repository is called, so what a map names after its folder stays the same), so a map drawn
earlier, or of another branch, still points at the files it was drawn from. A folder that is
there is never replaced. The newest four of a repository are kept; an older one that a saved
map points at is downloaded again, as that commit, when the map is used (Dig deeper, recent
changes). git is run so that no program runs for the repository's files: no hooks,
no filters of any name (Git LFS files stay pointers, and a filter your own git settings define
is not run either), no submodules, no file monitor, and links in it are written as plain files.
A folder of that name on this computer wins: `docs/api` beside the diagram is a folder.

The Mapper places the shapes itself (`mapper/layout.ts`); the connectors are then routed
by draw.io's obstacle-avoiding router (the plugin's `layout` operation, type `route`): each
goes around the shapes in its way and apart from the ones beside it, and no shape moves.
Maps with more than 600 connectors are left unrouted, as routing them takes too long.

| Category | Maps |
| --- | --- |
| Software | Connectivity (services, databases, queues, external APIs from compose, Kubernetes YAML, config and code), data flow (entry points; the agent traces the flows), module dependencies, class diagram, API surface (OpenAPI/Swagger, GraphQL), GitHub Actions workflows, live Kubernetes cluster |
| Databases | Schema/ERD for PostgreSQL, MySQL/MariaDB, SQL Server/Azure SQL, Oracle, SQLite and MongoDB (fields inferred from sampled documents); dbt lineage |
| Azure | Subscription › resource groups › VNets › subnets › resources (Resource Graph or `az` list commands); infrastructure as code (Bicep, ARM, Terraform) |
| AWS | Account › regions › VPCs › subnets › services, with load balancer, event source, subscription and security-group edges; infrastructure as code (Terraform, CloudFormation/SAM, CDK) |
| Google Cloud | Project › VPCs › regions › subnetworks › resources (Cloud Asset Inventory); infrastructure as code (Terraform, Deployment Manager) |
| Machine learning | Pipelines (DVC, Kubeflow/Vertex, Argo, Azure ML, SageMaker, Airflow, Metaflow), MLflow tracking and registry, the end-to-end lifecycle (with gaps marked), model architecture (Hugging Face config + safetensors, GGUF, ONNX, XGBoost, LightGBM) |

- **A cluster in the cloud.** The Kubernetes map reads a context of this computer's
  kubeconfig, or finds the cluster in Azure (AKS), AWS (EKS) or Google Cloud (GKE) with the
  CLI you are signed in to. It is then read through a sign-in made for that one read:
  `~/.kube/config` is not changed. AKS with Microsoft Entra sign-in needs `kubelogin`, GKE
  needs `gke-gcloud-auth-plugin`, and a private cluster can only be reached from inside its
  network.
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

## Shape Workshop

**Shapes → Shape Workshop…** (Cmd/Ctrl+Alt+K, or the shapes button in the toolbar) opens one
window for finding, collecting, changing and making shapes. It has the **Shape Gallery**, the
**Shape Shifter** and the **Shape Creator**; finding a shape from an image and the cloud
vendors' own sets come next.

- **Galleries** start with three you can turn off, remove and restore:
  - theSVG, open licences only (CC0, MIT, Apache-2.0); not its AWS, Azure or Google Cloud sets, whose labels there don't match the vendors' terms
  - Tech logos: devicon + Simple Icons (logos with a non-open licence of their own are left out)
  - UI icons: Lucide + Tabler
- **Add your own:** a public GitHub repository or one folder of it, a folder on this
  computer, or a draw.io library file. **New collection** makes an empty gallery you fill
  from any search (⋯ on a shape); it is a draw.io library you can export.
- **Search** runs across every gallery that is on; pick a gallery to browse it. Click a shape
  to add it to the diagram you used last (selected, in the middle of the view).
- **In the editor:** each gallery is a palette in the shapes sidebar (a first page; the rest
  is found by search), and draw.io's own sidebar search finds gallery shapes too.
- **draw.io's own shape sets** (General, UML, AWS, BPMN… and the Scratchpad) are switches in
  the same list, under "Built into draw.io". The editor's **+ More Shapes** button opens the
  Workshop there: draw.io's separate "More Shapes" dialog is not used, so there is one place
  for every kind of shape. A switch applies to every open diagram and is remembered.
- **The Scratchpad** (draw.io's shelf for shapes you drag onto it) is kept in the app's data
  folder, so it is still there after a restart. draw.io would keep it in the page's own
  database, which is new on every launch because the editor's local address changes.
  Windows share that storage (`src/main/drawioStorage.ts`): a window's save only changes the
  keys that window changed, and the others are told, so two open diagrams cannot lose each
  other's Scratchpad shapes. The file is written whole, then moved into place, and once more
  before the app quits.
- **Downloads** happen in the app's main process, only from jsDelivr (npm and GitHub's CDN)
  and, for theSVG's licence data, raw.githubusercontent.com. Every redirect is checked
  against those hosts and every answer is size-capped (`src/main/workshop/fetch.ts`).
  Indexes are cached for a week, then refreshed in the background while search keeps using
  the old one (Sync now refreshes them at once); SVGs are fetched when shown and cached;
  **Make available offline** downloads a whole gallery (removing the gallery stops it).
  Everything lives in the app's data folder (`galleries/`, `collections/`).
- **Every SVG is cleaned** before it is cached or used: no scripts, animations, event
  handlers, external links (quoted, unquoted or encoded), embedded HTML or DTDs
  (`src/main/workshop/svgSanitize.ts`). Images from libraries, folders and collections are
  checked the same way, also the pictures a library's shapes embed: in a style (`image=`,
  `indicatorImage=`…), in an inline stencil, and in the model's `<defs>`. A shape that cannot
  be checked is left out: one that holds an SVG anywhere else (the HTML of a label), is not a
  plain graph model, has a stencil that is not written the way draw.io writes it, or whose
  XML cannot be read (`cleanShapeXml` in `sources.ts`, on the tag-by-tag reader
  `xmlScan.ts`). Each shape keeps its source and licence, also in the shape's style
  (`galleryItem=…;licence=…`).
- **GitHub galleries** without a branch in their address use `main`, then `master`, then the
  newest tag. A branch with a "/" in its name can't be told apart from a folder in an
  address, so such a repository can't be added by branch yet.

The **Shape Shifter** (the second tab, or **Shapes → Find a Shape…**) works on the diagram you
used last:

- **Find by words:** one search over draw.io's own shapes (all of them, also the sets that are
  switched off) and every gallery that is on. Results come in two groups, "draw.io's own
  shapes" and "From your galleries", each with a picture. Click one to add it: beside what is
  selected in the diagram, or in the middle of the view when nothing is. (The Gallery adds
  shapes the same way now.)
- **Change a shape:** select shapes in the diagram and set their **Fill**, **Line** and
  **Text** colour (None takes a fill or a line away; a connector has no fill). A selected
  group or container is one shape: what is inside it is not changed with it. **Icon colour**
  gives a gallery icon one colour: its SVG is cleaned and then rewritten tag by tag (fills and
  strokes that paint become that colour; `none`, gradients, and what is inside a mask, a clip
  path or a pattern stay; text and titles are not touched), and pictures that are not SVGs
  kept in the shape are left alone. Each change is one undo step. Or **describe the change**
  and **Ask the agent**: the request goes to the diagram's chat with the selection, and the
  agent's edits arrive as reviewable AI edits like any other.
- **Import a stencil:** a Visio stencil (`.vssx`, `.vss`, `.vssm`; up to 64 MB) becomes a
  collection of your own. draw.io's converter runs in the editor page on this computer:
  nothing is uploaded. You name the collection before it is saved, and the pictures its
  shapes keep are checked like every other image.

The **Shape Creator** (the third tab, or **Shapes → Create a Shape…**) has an agent, or a
model you have an API key for, draw an icon:

- **Describe it.** Pick who draws: one of the agents the chat uses (and a model, when the
  agent has told the app which it offers), or a provider you have given an
  [API key](#api-keys) for and one of its models. Then a look (line, solid, isometric, dot
  matrix) and one icon or three variations; attach, paste or drop up to four images that show
  what you mean. Only your description and those images go to whoever draws.
- **With an API key** there is no program, folder or tool endpoint: the app talks to the
  provider itself, the model gets the same two tools and nothing else, and the tools run in
  the app. What goes to the provider is the request, the images you attached, and what the
  tools answer (the picture of its own drawing). The rest of this list is about agents; what
  is accepted, Stop and the time limit are the same for both.
- **The agent runs apart from any diagram:** in an empty folder of its own, and the Workshop
  gives it a tool endpoint with two tools: `workshop_render_preview` returns a picture of its
  SVG (drawn by the Workshop page) so it can check its work, and `workshop_submit_svg` hands
  an icon in. When it asks the app for permission, one use of one of those two tools is
  allowed and everything else is refused (what was refused shows in the status line);
  nothing is ever allowed "always", which would be written into the agent's own
  configuration. The app does not take the agent's own tools away: what the agent's own
  settings already allow without asking (rules you set up in the agent itself, servers it is
  connected to) stays as it is there.
- **What it hands in is cleaned** like every SVG before it is shown, and has to be one
  well-formed `<svg>` element (an SVG shown as an image is read as XML: a tag left open or a
  second document after the first would draw nothing) with a `viewBox` that draws something;
  otherwise the agent is told what to fix. Six icons at most per request.
- **Look at it** at 16, 24 and 64 pixels on white and on black. **Ask for a change** ("thicker
  lines"): the same agent, still running, gets the request and the icon as it is now.
  **Source** shows the SVG; what you edit there is cleaned again when you apply it.
- **Keep it:** Insert puts it into the diagram used last as an image shape; Save keeps it in
  **My shapes** (a collection like any other: a palette in the shapes sidebar, found by
  search, exportable) or another of your collections; Copy SVG puts the source on the
  clipboard. Icons are drawn with `var(--fill, #141414)` and `var(--stroke, #141414)`, so
  the Shifter's Icon colour recolours them.
- **Stop** asks the agent to stop; an agent that has not stopped five seconds later is
  closed. The same happens to a request that runs for eight minutes. The agent is closed, its
  folder removed and its endpoint shut when the Workshop window closes, when you choose
  another agent or model, and when it ends by itself.

Code: `src/main/workshop/` (`sources.ts` parses each source, `galleries.ts` caches and
searches, `shifter.ts` is the Shape Shifter's own logic: selections, style edits, one-colour
icons; `workshopWindow.ts`), `src/renderer/workshop.html`, and the palettes, search and
insertion in `src/renderer/desktop-toolbar.js`. What the Shifter needs from a diagram
(`ShifterHost` in `core.ts`: search draw.io's shapes, read the selection, apply style edits,
ask the agent, convert a stencil) is `DiagramWindow`'s. The Creator: `workshop/creator.ts`
(what the agent is asked, what is accepted, and `CreatorCore`, the page's other half for it),
`src/main/creatorSession.ts` (the agent's session: folder, tool endpoint, permissions) and
`creatorRunner.ts` (which agents there are; `api/creator.ts` for the models used with an API
key). Tests: `test/workshop.test.js`,
`test/shifter.test.js`, `test/creator.test.js` and `scripts/e2e.mjs --workshop`, all on
fixtures (`test/fixtures/galleries/mirror`, served by the e2e script as a stand-in for
jsDelivr: test runs never download anything). No test starts a real agent: the unit tests use
`test/helpers/fake-acp-agent.js`, which speaks the agent protocol on stdio and reaches only
the tool endpoint it is given, and the end-to-end run uses a stand-in inside the app
(`DRAWAI_E2E_CREATOR`).

## API keys

**Settings → Agents & models → API keys** (the second half of that section). Paste a key to
use that provider's models without an agent program. Usage is billed by the provider to that
key.

| Provider | Key from | Notes |
| --- | --- | --- |
| Anthropic | the Claude Console | |
| OpenAI | platform.openai.com | Needs OpenAI to keep responses for a while (an organisation can switch that off). |
| Gemini | Google AI Studio | Reached at Google's address for OpenAI's protocol. |
| Grok | console.x.ai | Over the API xAI calls deprecated (no end date given); attached images as JPEG or PNG. |
| Kimi | Moonshot AI's international platform (`api.moonshot.ai`) | A key from the China platform is refused. |
| OpenRouter | openrouter.ai | One key for many providers' models. Only models that can call tools are listed (the newest 500). Nothing that names this app is sent. Which providers a request may go to, and what they may keep, is set in your OpenRouter account. |

- **Where a key is kept.** Encrypted with a secret the operating system holds for the app
  (Electron's `safeStorage`: the macOS Keychain), in `api-keys.json` in the app's data folder,
  readable by your user only. A file there that the app cannot read, or that is not one it
  wrote, is never written over (the second is set aside as `api-keys.json.unreadable`). It is never written to `settings.json`, a diagram or a log,
  never shown again after you paste it, never sent to an agent, and sent only to its own
  provider's address. What a provider says when something goes wrong is shown, but never the
  key, should it quote the key back. macOS may ask for your login keychain the first time a
  key is saved or used. The keychain is not asked when Settings or the Shape Creator merely
  opens.
- **Nothing comes from the environment.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `*_CUSTOM_HEADERS` and the like are not read: the
  key is the one you saved, and it goes to the provider's own address. (What Node itself takes
  from the environment for every connection, a proxy or extra certificates, applies here as
  it does to everything else the app fetches.)
- **A key is checked before it is kept.** The provider is asked which models the key can use.
  A key it does not accept is not kept. If the provider cannot be reached, the key is kept and
  **Refresh** asks again. A kept key the provider later stops accepting is marked
  **Not accepted**. A restricted key that may not list models is kept, and what it may not do
  is said.
- **Models.** What the provider lists for the key, newest first; untick one to leave it out of
  the pickers. The model you picked last is offered first next time. Only the names of models
  are stored in `settings.json` (under `api:<provider>`). A model that takes no pictures
  (Kimi says which of its models; of OpenAI's, the older ones known for it) is marked: it is
  given words only, also where a tool would show it a picture.
- **A conversation that broke is forgotten.** A request that is stopped, declined or fails is
  not kept in the conversation with the model, so the next one starts from something the
  provider accepts; the Shape Creator then says its rules again.
- **Where they can be used:** wherever an agent is: the diagram chat (and with it the
  Shifter's "Ask the agent" and the Mapper's requests, which go through the chat), and the
  Shape Creator.

### The chat with an API key

The chat's picker lists your agents and, under **With an API key**, the providers (the ones
you have a key for first). Pick one, then one of its models; the model picked last is the one
a new chat starts with.

- **No program, no endpoint.** An agent program is started in the diagram's folder and reaches
  the diagram's tools over MCP. A model used through its API has neither: the app offers it
  this window's tools (the `drawio_*` ones and the Mapper's) and runs them itself. What goes
  to the provider is your request with what you selected, the images you attached, and what
  the tools answer (what they read of the diagram, a picture of it, a map's facts).
- **What is asked first.** A tool that only reads runs as the model calls it. One that changes
  the diagram, writes a file or collects a map shows the same card an agent's request does:
  **Allow**, **Always allow in this chat** (that tool, until New Chat) or **Deny**, with
  **Allow all** beside them. A call you do not allow is not run; the model is told, and goes
  on without it. Edits arrive as pending changes to keep or revert, as with an agent.
- **A conversation is held with one model.** Picking another model starts a new conversation
  with it (the chat says so): what one model wrote and thought is not something another can
  go on from. So does a key that is replaced or removed; a request under way then ends as
  stopped.
- **Nothing happens until you send a request.** A window that opens with a provider picked
  sends nothing and does not ask the keychain; the key is read when a request goes out.
- **When something is wrong with the key or the models** (no key, one the provider stopped
  accepting, every model switched off), the request's error has an **Open Settings** button
  that lands on the API keys.
- **Long chats.** The whole conversation goes to the provider with every request (OpenAI
  keeps it on its side). With Anthropic, what was sent before is read from its cache at a
  fraction of the price. When it has grown long (about 60,000 tokens of what was said,
  called and answered: `SUMMARISE_AT` in `api/chatSession.ts`), the next request first has
  the model sum the conversation up for itself, and then goes to a new conversation that
  starts with that summary. The chat says so; the summary is not shown, and no tool runs
  for it. If no summary can be had, the conversation goes on as it is and it is tried again
  later. A conversation the provider refuses as too long still starts over, and the app
  says so. **New Chat** does the same on purpose.

Code: `src/main/api/`: `keyStore.ts` (the file and its encryption; `keys.ts` gives it
`safeStorage`), `access.ts` (keeping, checking and removing a key, and the models it can
use), `keysPanel.ts` (the Settings page's other half), `chat.ts` (what a provider is to the
app: it lists models and holds a conversation that runs the app's tools), `anthropic.ts`
(the Messages API through `@anthropic-ai/sdk`), `openai.ts` (the Responses API through
`openai`), `completions.ts` (OpenAI's chat-completions protocol, which the other four speak
at an address of their own, through `openai`; what differs between them is named there) with
`gemini.ts`, `grok.ts`, `kimi.ts` and `openrouter.ts`, `env.ts` (why nothing is taken from
the environment), `creator.ts` (the Shape Creator drawing this way), `chatSession.ts` (the
chat answered this way: to `chatController.ts` it is a session like an agent's, see
`ChatSession` in `acpSession.ts`). Tests: `test/api.test.js`, `test/api-chat.test.js` and
`test/ai/settings.e2e.test.js` (in the repository root),
against local stand-ins for the three APIs (`test/helpers/fake-providers.js`, which refuse a
conversation that is not whole, as the real ones do) and a test cipher instead of the
keychain: no test reaches a provider, uses a real key or touches the keychain. In the real
app, `node scripts/e2e.mjs --api-chat` runs the chat with a provider that is none
(`api/standIn.ts`): the window, the chat page, the tools, the permission cards and the key
file are the real ones.

The tests never reach a real provider: the request shapes follow each provider's
documentation and SDK (as of November 2026), and the tests check what is sent and what is
made of the answers. A provider's first real request is where a wrong assumption would show.
What each of the four on `completions.ts` does differently, as its documentation has it:
Gemini wants the signature of its thinking back on each tool call, sends tool calls whole
and without a position, says what went wrong as a list, and refuses a tool argument that is
an object of any shape (it is asked for as JSON text and read back) or a tool without
arguments (it is given one to leave out); Grok sends tool calls whole too
and can say what went wrong as a plain sentence; Kimi wants its reasoning text back;
OpenRouter wants the reasoning back as the list of parts it came as.

## Go live

**File → Go Live…** shares the open diagram by a link; **File → Join a Shared Diagram…** opens
one someone shared. Everyone sees the others' changes as they are made, with their pointers and
selections. The host's file stays the master copy and is saved as always; a guest's window
holds the shared diagram, not a file.

OmniDraw has no server built in. **Settings → Sharing** holds the address of the OmniPad server
you or your team runs (the Go live window asks for it the first time, and remembers it), and
its **Check** asks that server whether it can share diagrams.

It goes through that OmniPad server: the diagram becomes a *board* there,
in a pad of its own, and the link (`https://<omnipad>/b/<pad>/<board>`) opens it in OmniDraw or
in OmniPad in a browser. The protocol is OmniPad's;
[`docs/omnipad-boards-protocol.md`](../docs/omnipad-boards-protocol.md) says what OmniDraw does
with it.

What a person has selected is theirs for as long as it is: it is outlined in their colour for
everyone else, who cannot select it, and the AI's edits leave it be. The server refuses a change
that touches it all the same; such a change is undone, with a line that says whose shape it was.

Without an OmniPad server, a small stand-in in this repository speaks the part of the protocol
Go live uses, which is enough to share between OmniDraw windows:

```bash
node standalone/test/helpers/boardRelay.js
```

and give the address it prints as the OmniPad server in the Go live window.

How it works (`src/main/live/`):

- `session.ts` is one person's side of a board: what is sent when the diagram changes, what
  is done with what arrives, how someone whose change crossed another's catches up with the
  order the server put them in, and what happens when the server refuses a change. It knows
  nothing of draw.io or of sockets.
- `liveShare.ts` gives it draw.io: diff sync (draw.io's embed protocol) is turned on for the
  open diagram, each change goes out as draw.io's own patch, and others' come in through its
  `patch` action, outside your undo history. Pointers, held shapes and the line that explains
  a refusal use the presence plugin (`drawio-custom-plugins/src/liveshare.ts`).
- The link is the permission (anyone who has it can edit), so it is treated as a secret: shown
  and copied when you ask, never logged, never sent to an agent.

`yarn e2e --live` runs two windows through the stand-in server; with
`--omnipad http://127.0.0.1:<port>` through an OmniPad server started by hand on this computer.

## The editor add-ons for another host (`omnidraw-frame`)

A build also writes `out/frame/`: the editor's add-ons (the look, the AI's editing tools, Visio
and PDF export, the importers, presentation mode, the pieces that put a shared diagram in place)
as one script, `omnidraw-frame.js`, with its fonts, for a page that frames a plain draw.io and
wants it to be OmniDraw's. OmniPad runs its Structured boards that way.

- [`src/renderer/frame/README.md`](src/renderer/frame/README.md) ships in the folder and says
  how to load it (`window.omnidrawConfig`, then the script, before the editor starts) and
  which messages it takes and sends.
- In a frame the add-ons answer to the page that frames them, at the frame's own origin unless
  `omnidrawConfig.hostOrigin` names another. (In the desktop app and in VS Code they answer to
  the stand-in those hosts put at `window.opener`, as before.)
- `yarn dist:frame` packs it as `dist/omnidraw-frame-<version>.zip`, to go up with a release
  beside the app. It is GPL-3.0 like the rest of this repository: a host under another licence
  fetches the file and talks to it with messages, and does not carry its source.
- `aiPrintPdf` is for such a host: every page goes to the browser's print dialog as an SVG, one
  to a sheet of the drawing's size, so that "Save as PDF" there gives a PDF whose text stays
  text. (The desktop app prints the same sheets to a file itself.)

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
agents or start a new chat, and a 3D dot object in the empty chat that keeps changing
shape: it starts as a square of stacked layers, then every dot travels to its place in a
human head (a fine mesh of some 3,700 dots, lit like a 3D scan), a tetrahedron, a spiral, a galaxy, a ringed planet, a double helix, a heart and
more (`ui/dot-object.js`). When you start to type it shoots to the top right corner of
the chat and stays there, small, during the conversation; in a new, empty chat it comes
back. The dots near the pointer brighten and lean, in the object, in every head's dot
field (chat, Mapper, Settings, Workshop) and in the top corner of draw.io's Format panel.

- **The matrix:** the head's dot field also lies behind every surface (`ui/matrix.js`): the
  same dots, 7px grid and grey across the whole of each window (the chat, Settings, the Mapper,
  the Workshop, and draw.io's toolbar, sidebars and page tabs), never over the diagram. It is
  a background: text, buttons, tabs, fields and cards are in front of it. Dots
  near the pointer brighten and lean away, as in the field. It is drawn once and only the patch
  around the pointer is drawn again, so it costs nothing while the mouse is still. The heads'
  live fields sit on the same grid, so their dots fall on the matrix's. Settings → Appearance →
  Matrix: Grey, Green or Off. Motion is short and ease-out only: messages, menus, cards and tour captions
rise in. Under *reduce motion* nothing moves.

- Tokens, motion and the dot modules: `src/renderer/ui/` (from the `omni-design`
  skill), served at `/ui/`. The fonts are self-hosted from `@fontsource` packages
  (`build.mjs` copies them).
- The Mapper is shared with the VS Code extension as it is: `src/main/mapper/` (recipes,
  layout, drawing, records, lookups, tools; nothing of Electron in it), the Map Something
  page `src/renderer/mapper.html` with `ui/*.css` and `ui/brands.js`, and the page's other
  half `src/main/mapper/dialog.ts` (`MapperDialogCore`; `mapperDialog.ts` gives it a window,
  the extension a webview panel: `src/features/mapper/`). Keep `mapper/toolSchemas.ts` free
  of imports (the extension's manifest is generated from it), name host-specific wording
  through `setToolSource` and `tourPrompt`'s `play`, and keep the page's files under `/ui/`.
- The Shape Workshop is shared with the VS Code extension as it is: `src/main/workshop/`
  without `index.ts` and `workshopWindow.ts` (the gallery service, sources, the guarded fetch,
  the sanitiser, `types.ts`, `palette.ts`, and the page's other half `core.ts`, `WorkshopCore`),
  `src/main/shapeSets.ts`, and the page `src/renderer/workshop.html`
  (the extension: `src/features/workshop/`). Keep those files free of Electron and of
  `../settings`; what needs a window or the app's settings goes through `WorkshopPorts`.
  The Shape Shifter is on where a program says so (`WorkshopPorts.shifter`, with
  `pickStencil`) and gives the Workshop a `ShifterHost`; the Shape Creator is on where a
  program gives `WorkshopPorts.creator` (`CreatorPorts`: its agents, and a way to start one).
  The extension does neither yet, so both tabs stay "Next" there.
- Shared with the VS Code extension: `src/renderer/theme.js`, `desktop-toolbar.js`,
  `presentation.js` and `ui/{icons,brandmark,tips,dots,matrix}.js` are also the extension's
  editor tools (its plugin build copies them: `drawio-custom-plugins/webpack.config.ts`,
  `src/features/editorLook.ts`). A host that cannot put the look in the page's address sets
  `window.omnidrawConfig` first (`{ host, name, base, icons, toolbar, matrix, features }`);
  the app leaves it `null` and nothing changes for it. In these files, load modules and fonts
  through that `base`, switch app-only things off with `has("feature")`, and keep messages
  safe to receive twice (a VS Code webview delivers each one twice).
- draw.io's chrome: `src/renderer/theme.js`, a draw.io plugin that only changes
  draw.io's theme variables, its UI font and its primary buttons, never diagrams.
- Icons: `src/renderer/ui/icons.js` draws every icon (the chat's, Settings' and draw.io's
  toolbar) from one flat glyph set in four styles that look nothing alike: classic (flat
  lines), dot-matrix 2D (the glyph on a square grid of dots), dot-matrix 3D (the glyph stood
  up and turned, in dots) and realistic 3D (a small solid object in the colours of the real
  thing, with shaded sides and a shadow). `src/renderer/desktop-toolbar.js` swaps draw.io's
  own toolbar images; realistic icons keep their colours in dark mode (draw.io would show
  them as negatives). Settings that still name the earlier "isometric" and "extruded" styles
  get dot-matrix 2D and realistic 3D.
- Tooltips appear after a tenth of a second (`ui/tips.js`), at once when moving from one
  control to the next, in the app's pages and on draw.io's toolbar.
- The toolbar: the OmniDraw dot mark first (opens Settings; every few seconds its dots draw a circle, a face, a diamond, a plus, a wave, a heart or a spiral and come back to the square, `ui/brandmark.js`); Layers, Tags, Outline and
  Presentation mode as buttons, with Ruler next to them. The button after the mark shows
  and hides the Shapes panel with one click (no menu); Fullscreen and Format are at the
  right end.
- The chat closes and opens with an arrow at the edge it shares with the diagram: in the
  corner of the chat while it is open, at the end of the toolbar while it is closed (or
  Cmd/Ctrl+J). It docks left or right and resizes by dragging its inner edge. Lasso,
  Inline, Markup, Review and Map are a row of tabs under its head. Its agent and model
  pickers are in-app menus that show each model's version and description.
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
- An Excalidraw drawing has a window class of its own, `ExcalidrawWindow`
  (`src/main/excalidrawWindow.ts`), rather than a second kind of document inside
  `DiagramWindow`: no draw.io client, no agent, no MCP server. What the two share is in
  `src/main/documentShell.ts`: where a new window goes, which document is in front (the menu
  bar follows it), and the chat beside the editor (sliding, docking left or right, its edge
  dragged to resize). The editor page is `src/renderer/excalidraw/app.tsx`, bundled with
  React by `build.mjs` into `out/excalidraw/` (an ES module with its lazily loaded parts
  beside it, and Excalidraw's fonts copied from the package). The page hands the app the
  drawing when asked (`serializeAsJSON`, `exportToBlob`, `exportToSvg`) and tells it when
  there are unsaved changes; `src/main/excalidrawFile.ts` (no Electron in it, so the tests
  load it) decides which files are drawings, reads the drawing inside a PNG or SVG, and
  checks what is about to be written.

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

- **Appearance:** System, Light or Dark; the toolbar on the top, left, right or bottom; the matrix of dots over every surface (grey, green or off); the icon style.
- **Agents & models:** for each agent, the models its picker shows and the command that
  launches it. Each agent is asked for its models when the page opens (it is started in an
  empty folder with no tools, and nothing is sent to a model); **Refresh** asks again. A
  new chat starts with the model picked last.
  - Claude Code and Codex speak ACP through npm adapters. The app looks their newest
    versions up on npm (at most twice a day, only the package names are sent) and starts
    that exact version with `npx` when a globally installed copy is older, so the model
    list is never the one from the day the adapter was installed
    (`src/main/adapterVersions.ts`).
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
	"appearance": { "theme": "dark", "iconStyle": "dots" },
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
  `--excalidraw` checks Excalidraw drawings instead (`src/main/e2eExcalidraw.ts`): it opens
  `test/fixtures/excalidraw/sample.excalidraw`, adds an element through Excalidraw's API, runs
  Undo, Redo and Save from the menu bar, reads the saved file, reopens it, exports PNG and SVG
  and edits and saves those, answers the question before closing, checks what is refused, and
  screenshots the window in light and dark (`window-light.png`, `window-dark.png`). It fails if
  the page asked for anything outside the app or reported a refused load.
  `DRAWAI_E2E_CONSOLE=1` prints what the page's console says.
- View → Editor/Chat Developer Tools for the two web views.
