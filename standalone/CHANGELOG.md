# Changelog: Draw.AI desktop

## [Unreleased]

- **Settings window** (Cmd/Ctrl+, or the dot mark before File) instead of a JSON file:
  System / Light / Dark, the icon style, which models each agent shows and which one a
  new chat starts with, the chat's side, width and defaults, the editor's review options,
  and your own shape folders and draw.io libraries in the shapes sidebar.
- **Icons in four styles**: classic (flat), isometric line, dot-matrix 3D and soft
  extruded, for the chat, Settings and draw.io's toolbar.
- **Toolbar**: Layers, Tags, Outline and Presentation mode are buttons; the panel menu
  keeps only Shapes, Ruler and Fullscreen; a chat button at the right end; the Draw.AI
  mark sits before File.
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
