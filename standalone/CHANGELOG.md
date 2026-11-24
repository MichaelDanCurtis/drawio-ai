# Changelog: OmniDraw (formerly the Draw.AI desktop app)

## [Unreleased]

- **Mapper: map a working copy with one click.** When a folder's code is in working copies the
  scan does not read (git worktrees in `.claude/worktrees`, `.worktrees`, `.git-worktrees`),
  the result now offers them, the six worked in last first and the rest behind a button: a click maps one. The
  result also scrolls into view; it could end up below the form, unseen.
- A request made elsewhere in the app while the chat works (the Mapper's, the Shape Workshop's
  "Ask the agent") is no longer refused with "press Stop first". It waits in the strip above
  the box under its own name and follows as the next request.
- **Maps: connectors are routed.** After the Mapper has placed the shapes, each connector is
  taken around the shapes in its way and apart from the ones beside it (draw.io's own
  obstacle-avoiding router; no shape moves), and where two still cross, one hops over the
  other. Before, every connector ran straight between its ends, through whatever lay there,
  and the ones leaving a shape on the same side lay on top of each other. Maps with more than
  600 connectors are drawn as before (routing them takes too long).
- **Software maps of a repository without services.** A Rust binary (`src/main.rs`,
  `src/bin/`), axum, actix-web and Rocket routes, and a Python `__main__.py` count as entry
  points, so such a package is drawn. When nothing is a service, the message says how much was
  read and which packages are there; and when the repository's working copies are kept in a
  hidden folder (`.claude/worktrees`), that they were not read and how to map one.
- The Mapper's dialog wrote "null" under a result without warnings, and ticked off a run that
  found nothing. A run that found nothing now says so plainly and keeps the dialog open.
- **Watch it build.** An edit by the AI is shown being made: new shapes appear one after
  another in the order they were added, connectors draw in from start to end, and shapes that
  were moved (also by a layout) glide to their place. It takes about a second at most. The
  edit itself is applied at once, as before (one undo step, pending changes to keep or
  revert); only how it is shown changes. Off when the system asks for reduced motion, and
  under Settings → Editor → **Show edits being built**.
- **Send while it works.** The chat's box stays open during a request. What you send waits in
  a strip above it and is handed to the model with its next step (it reads it as it works), or
  sent as the next request when this one ends; ✕ takes it back. After Stop, an error or New Chat it goes
  back into the box instead of being sent. The line under the box says so, where it used to
  repeat "Working… watch the diagram".
- A new diagram that is not saved yet was described to the model as "no diagram is open", so
  it would not draw on it, or added a page of its own. It is told the diagram is "Untitled",
  that an empty page is the place to draw, and not to add a page because the one shown is
  empty.

- **API keys** (Settings → Agents & models): use Anthropic's, OpenAI's, Gemini's, Grok's or
  Kimi's models, or the many behind OpenRouter, with your own API key, without an agent
  program. A key is checked with its provider, then kept
  encrypted with a secret from the macOS Keychain; it is never written to `settings.json`,
  never shown again, and nothing about it is taken from environment variables. These models
  are listed beside the agents wherever an agent is used:
  - the **chat** (and with it the Shifter's "Ask the agent" and the Mapper's requests): pick
    a provider under "With an API key", then a model. The app runs the diagram's tools
    itself; a tool that changes something asks first (Allow, Always allow in this chat,
    Deny), and edits are yours to keep or revert as with an agent;
  - the **Shape Creator**.
- The chat's tool lines and permission cards name the Mapper's tools in words ("Mapping…")
  as they do the diagram's.
- Requests to Anthropic's API read what was sent before from its cache (cheaper rounds of
  tool calls).
- Shape Creator: an agent that is not ready says why in full (the note was cut off at the
  first line), with a link to where it is set up in Settings.
- A shape of a Visio stencil that has no name is called "Shape 3" (by its place) and no
  longer "null".
- **Shape Creator** in the Shape Workshop (its third tab, or Shapes → Create a Shape…):
  describe an icon and one of your agents draws it as SVG. See it at the sizes a diagram uses,
  ask for changes, edit the source, then insert it, keep it in **My shapes** or another
  collection, or copy the SVG. The agent runs in a folder of its own with two tools (look at
  the icon, hand it in); everything else it asks for is refused, and what it hands in is
  cleaned like every SVG.
- A collection shows a shape added to it at once, also when it was being read at that moment.
- **Shape Shifter** in the Shape Workshop (its second tab, or Shapes → Find a Shape…):
  - **Find a shape by words** across draw.io's own shapes and your galleries at once, each
    result with a picture; click to add it.
  - **Change a shape**: fill, line and text colour of what is selected in the diagram, one
    colour for a gallery icon, or describe the change and ask the diagram's agent.
  - **Import a Visio stencil** (`.vssx`, `.vss`, `.vssm`) as a collection of your own,
    converted on this computer.
- A shape added from the **Shape Workshop** now goes beside what is selected in the diagram
  (in the middle of the view when nothing is selected).
- The Workshop's question dialog (a name for a collection, an address): **Enter** is OK (it
  was Cancel), **Esc** is always Cancel, and the answer is taken when you press OK, also in a
  window that is covered by another one.
- Pictures inside the shapes of a draw.io library (also a collection's, and a converted
  stencil's) are checked like every other image: SVGs are cleaned of scripts and links, and
  what only claims to be an image is dropped from the shape. A shape that cannot be checked
  (an SVG in the HTML of a label, a file's pages instead of a shape) is left out.
- Cleaning an SVG no longer takes minutes when it holds a very long run of spaces, or throws
  on a character reference that names no character.
- **Mapper**: YAML merge keys (`<<: *common`) are followed, so a compose service built on an
  anchor keeps its image, its environment and what it depends on (Connectivity, Kubernetes,
  pipelines, MLflow, API maps).
- **Shape Workshop**: a diagram's palettes follow what a gallery holds, not only which
  galleries are on: a collection that gets its first shape shows up in the shapes sidebar, an
  emptied one leaves it, and a synced gallery shows its new first page.
- The **Shape Workshop** is now also in the Draw.AI extension for VS Code, from this same code
  (its page says whose it is).
- The agents' `drawio_search_shapes` no longer returns gallery shapes with large images: at
  most four shapes that carry their image per search, each under 4,000 characters.
- **Mapper**: `git` run by the Mapper no longer starts the program a repository's own
  configuration names (`core.fsmonitor`) and no longer writes the index; only a commit hash
  from a map's record reaches git's arguments (Recent changes); a tour saved again under its
  title can no longer share its id with another tour. The Mapper is now also in the Draw.AI
  extension for VS Code, from this same code.
- **Shape Workshop** (Shapes → Shape Workshop…, Cmd/Ctrl+Alt+K) with the **Shape Gallery**:
  theSVG (open licences only), Tech logos (devicon + Simple Icons) and UI icons (Lucide +
  Tabler) to start; add GitHub repositories, folders and draw.io libraries; make your own
  collections; search across galleries and click to add a shape. Galleries are also palettes
  in the shapes sidebar, and draw.io's search finds their shapes. Downloads come only from
  jsDelivr, are cached for offline use, and every SVG is cleaned of scripts and external links.
- **OmniDraw**: the desktop app's new name. Settings, draw.io preferences and Mapper inputs
  carry over from the Draw.AI data folder on first launch. Claude Code and Codex connect to
  it as the `omnidraw` MCP server; Connect and Disconnect also remove the old
  `draw-ai-desktop` entry.
- **Menus in the system menu bar**: draw.io's File, Edit, View, Arrange and Extras menus are
  native menus, with their shortcuts, checkmarks and submenus; draw.io's in-window menu bar
  is gone. Undo, Redo and Select All act on the diagram or on the text you are typing in.
- **Toolbar on any side**: top, left, right or bottom (Settings → Appearance).
- **A living mark**: the dot mark at the start of the toolbar (and in the Settings and Mapper
  heads) now and then draws a circle, a face, a diamond, a plus, a wave, a heart or a spiral
  and comes back to the square. It holds still under reduce motion.
- **Settings window** (Cmd/Ctrl+, or the dot mark before File) instead of a JSON file:
  System / Light / Dark, the icon style, which models each agent shows and which one a
  new chat starts with, the chat's side, width and defaults, the editor's review options,
  and your own shape folders and draw.io libraries in the shapes sidebar.
- **Icons in four styles**: classic (flat), isometric line, dot-matrix 3D and soft
  extruded, for the chat, Settings and draw.io's toolbar.
- **Toolbar**: Layers, Tags, Outline and Presentation mode are buttons; the panel menu
  keeps only Shapes, Ruler and Fullscreen; a chat button at the right end; the dot mark
  sits before File.
- **Chat**: slides away and back (its own button, the toolbar's, or Cmd/Ctrl+J), docks
  left or right, resizes by dragging its edge, and keeps its whole button row visible at
  any width. The agent and model pickers are in-app menus (the native ones opened on the
  wrong screen after the window moved) and show each model's version, e.g. Opus 4.8.
- **Mapper, AWS**: the region is a picker filled from your profile (its own region, all
  enabled regions, or one).
- New windows open fully on screen, on the display the pointer is on.

## [0.1.0]

First release of the standalone app: the draw.io editor with a chat that drives your
own coding agents.

- **Agents over ACP**: Claude Code, Codex, Antigravity (Gemini), GitHub Copilot and
  Kimi. Pick the agent and its model or mode in the chat. The agent's edits are
  pending changes you accept or reject. **Allow all** approves every request for the
  rest of a chat.
- **Files and export**: `.drawio`, `.dio`, `.drawio.svg` and `.drawio.png`. Vector PDF
  export, export to SVG/PNG/Visio/`.drawio`, import from Visio, Gliffy,
  yEd/GraphML, Lucidchart and Miro, and print.
- **Mapper**: maps software (connectivity, data flow, modules, classes, APIs, GitHub
  Actions, Kubernetes), databases (PostgreSQL, MySQL/MariaDB, SQL Server, Oracle,
  SQLite, MongoDB, dbt), Azure, AWS and Google Cloud (live, read-only, or from
  infrastructure as code) and machine learning (pipelines, MLflow, lifecycle, model
  architecture).
- **Map insights**:
  - Health findings with evidence and fixes, and what was checked.
  - Plain-English descriptions as tooltips.
  - Recent changes from git, and refresh.
  - Guided tours, and Ask the map.
- **Presentation mode** (F5): only the diagram, read-only, pages as dots, tours.
- **A new look**: paper and ink, or OLED black, with Space Grotesk, mono caps
  labels, one signal red, a live dot field and a 3D dot object, and short ease-out
  motion. It applies to the chat, the Mapper, presentation mode and draw.io's own chrome.
- **MCP for Claude Code and Codex**: Agent → Connect Claude Code / Codex to Draw.AI
  lets coding agents on this computer use the open diagrams and maps.

The macOS build is not signed with a Developer ID yet. The first time you open it, macOS
says it can't verify Draw.AI: click **Done**, then **System Settings → Privacy & Security →
Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/Draw.AI.app` once.
