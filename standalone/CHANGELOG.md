# Changelog: Draw.AI desktop

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
- **MCP for Claude Code and Codex**: Agent → Connect Claude Code / Codex to Draw.AI
  lets coding agents on this computer use the open diagrams and maps.

The macOS build is not signed yet. The first time, right-click Draw.AI.app → **Open**
(or run `xattr -dr com.apple.quarantine /Applications/Draw.AI.app`).
