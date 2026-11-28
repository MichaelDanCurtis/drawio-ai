# Changelog: OmniDraw (formerly the Draw.AI desktop app)

## [Unreleased]

- **AI in an Excalidraw drawing.** The chat beside a drawing now works as it does beside a
  diagram: an agent (Claude Code, Gemini, Codex, GitHub Copilot, Kimi) or a model used with your
  API key edits the open drawing live.
  - Six tools of its own: it reads the drawing, changes it with a list of add, update and delete
    operations applied as one step, selects, renders a picture to look at, adds a Mermaid
    flowchart as editable shapes, and exports. Shapes, labels and arrows are made by Excalidraw
    itself; an arrow between two shapes is routed between them, and follows them when the agent
    moves them.
  - What it changes is pending until you keep or revert it, as in a diagram: outlined on the
    canvas (added, changed, removed), counted in the bar above it and in the chat, with **Reject**
    and **Accept** in both and under **Agent**. Reject gives each element back what it was before
    the agent touched it; what you draw yourself meanwhile is not part of the review; a change you
    undo is no longer pending, and is again if you redo it.
  - A request is about the selection when there is one. A model used with an API key is asked
    about before it changes the drawing or writes a file.
  - Not yet: keeping or reverting part of a review, and reaching a drawing from Claude Code or
    Codex connected from outside the app.
- **Security: `npx` is no longer run in the document's folder.** When the Claude Code or Codex
  adapter is not installed (or an older one is), the app fetches it with `npx` as the chat opens.
  That was done in the folder of the diagram or drawing, where npm reads the folder's own
  settings (an `.npmrc` can name another registry) and looks in its `node_modules` first: a
  checked-out repository could so decide what was run as the agent, by a file in it being
  opened. `npx`, and any other package runner set as an agent's command in settings.json, is
  now started in an empty folder of the app's own; the agent still works in the document's
  folder, which its session is told. Installed adapters and agents are started as before.

## [0.4.1]

- A new app icon: a letter D drawn in dots, white on black with one red dot. (The square of
  dots it had since 0.4.0 is the mark of all the Omni products, not this one's.) Its drawing is
  `build/icon.svg`.
- Run from source (`yarn start`), the app shows OmniDraw's icon in the Dock, not Electron's.

## [0.4.0]

- **Go live** (File → Go Live…): share the open diagram by a link, and work on it with others at
  the same time. Whoever joins (File → Join a Shared Diagram…, with the link) sees your changes
  as you make them and you see theirs, with their pointers and what they have selected. Two
  people changing different shapes never get in each other's way; on the same shape the later
  change wins for everyone. Your file stays on your computer and is saved as always; a guest
  works on the shared diagram, not on a file of their own. Stop sharing and the link is dead.
  - It goes through an OmniPad server, whose address you give: the diagram becomes a board
    there, in a pad of its own, and the link opens it in OmniDraw or in OmniPad in a browser.
    OmniDraw speaks OmniPad's own board protocol (`docs/omnipad-boards-protocol.md` says what it
    does with it). Without an OmniPad server, the small stand-in in the repository is enough
    to share between OmniDraw windows: `node standalone/test/helpers/boardRelay.js`.
  - What someone has selected is theirs for as long as it is. It is outlined in their colour
    for everyone else, who cannot select it, and the AI's edits leave it be. A change that
    touches it all the same is refused by the server and undone, with a line that says whose
    shape it was.
  - The link is the permission: anyone who has it can change the diagram. It is shown and
    copied when you ask, and is not written to the log or sent to an agent.
  - Not yet: private pads (invites, signing in to OmniPad), opening a link by clicking it, and
    reconnecting by itself when the connection drops.
- **The editor's add-ons for another host.** A build now also writes `out/frame/`: the look,
  the AI's editing tools, Visio and PDF export, the importers and presentation mode as one
  script (`omnidraw-frame.js`, with its fonts and a README) that a page framing a plain draw.io
  can load. OmniPad uses it for its Structured boards. `yarn dist:frame` packs it as
  `omnidraw-frame-<version>.zip`, to go up with a release. GPL-3.0, like the app.
  - In a frame the add-ons answer to the page that frames them, at the frame's own origin
    unless told another.
  - New for such a host: `aiPrintPdf` hands every page to the browser's print dialog as an SVG,
    one to a sheet of the drawing's size, for a PDF whose text stays text; and
    `presence: false` leaves the showing of other people to a host that does it itself.
- **Excalidraw drawings.** The app opens, edits and saves `.excalidraw` files in the real
  Excalidraw editor (the `@excalidraw/excalidraw` package, 0.18.1, MIT), offline, as a second
  kind of document beside draw.io diagrams. **File → New Excalidraw Drawing**
  (Cmd/Ctrl+Alt+N), or **File → Open…** on a `.excalidraw` file.
  - A drawing has a window of its own in the same shell as a diagram's: editor and chat, the
    name in the title with a dot while there are unsaved changes, Save and Save As, and the
    question before a window with unsaved changes closes. A bar above the canvas names the
    drawing and holds Save and Export.
  - Saved files are Excalidraw's own JSON, as Excalidraw writes it. **Export as PNG…** and
    **Export as SVG…** carry the drawing inside, so an export opens again for editing; such a
    picture opens as a drawing and is saved back as the picture (**Save As** → Editable PNG,
    Editable SVG). What is not a drawing is refused with a sentence that says why.
  - Nothing is loaded from a CDN: Excalidraw's fonts are in the app, and the CDN address it
    keeps as a fallback for each font is taken out. Light and dark follow Settings →
    Appearance; Excalidraw's own UI is not restyled.
  - While a drawing is in front the menu bar is the drawing's (File, Edit, View): draw.io's
    menus, Shapes, Agent and Map work on diagrams and are not shown.
  - The chat panel stays, and says that AI editing of Excalidraw drawings is not there yet; no
    agent is started for a drawing.
  - The app grows by 21.7 MB (15.9 MB compressed), most of it Excalidraw's hand-drawn Chinese,
    Japanese and Korean font.

- A new app icon: the dot mark the app already carries inside (a square of white dots on black,
  one of them red) in place of the orange one. Its drawing is `build/icon.svg`.

## [0.3.0]

- **Mapper: the API surface of a running API.** The API surface map takes an API's address
  beside (or in place of) a folder, and asks the API for its own description: the address
  itself, what its docs page and that page's scripts name, then the places frameworks serve
  an OpenAPI document from; a GraphQL endpoint is asked for its schema (the address you
  give too, when nothing else was found). An optional Authorization header is sent to that
  host only and is not saved. It only reads, stays on the host it was given, sends at most
  40 requests, and when an API publishes no description it says what it asked and what
  answered. A schema file in the folder and the same API asked live are drawn as one schema.
- Mapper, **Kubernetes cluster**: the cluster no longer has to be a context in this computer's
  kubeconfig. **Where the cluster is** offers Azure (AKS), AWS (EKS) and Google Cloud (GKE):
  - The clusters are listed with the `az`, `aws` or `gcloud` CLI you are signed in to: those of a
    subscription, of an account's region or of a project, or of every subscription or every
    enabled region. A subscription or region that could not be searched is named in the list.
  - The one you choose is read through a kubeconfig made for that one read, in a file only you
    can read, which is removed when the read ends. `~/.kube/config` is never written to. For AWS
    and Google Cloud the file holds no secret (the cluster's address and public certificate, and
    the CLI as the way to sign in); for Azure it is what `az aks get-credentials` prints for you,
    never the cluster admin's, with `kubelogin` told to use the Azure CLI's sign-in.
  - Nothing of that sign-in is in the map, the facts, the log or what an agent is sent.
- The Map Something dialog's lists: only the ones on show are asked for, one after the other,
  each with what the ones before it chose (a project's clusters come after the project). What
  is chosen is always something the list offers, so a choice made under another subscription
  is not left behind unseen. The lists keep coming while you type in a text box, and what a
  run said stays when the form is drawn again.
- **Mapper: map a GitHub repository.** Where a map takes a repository or folder (Connectivity,
  Data flow, GitHub Actions workflows, API surface, Module dependencies, Class diagram,
  Infrastructure as code, dbt, ML pipelines) it now also takes a repository on GitHub: its
  address from the browser (also of a branch or a folder in it), its clone address, or
  `owner/name` (`owner/name@branch` for a branch, tag or commit). The repository's newest
  state is downloaded with the access to GitHub this computer already has (git's saved
  sign-in, the GitHub CLI's, or an SSH key) into the app's own folder and read there. It
  said "is not a folder" before. git runs no program for the repository's files while it does
  so (no hook, no filter of any name, no submodule), and nothing is ever sent to the
  repository. Each download is of one commit, in a folder of its own that is never replaced,
  so an earlier map still points at the files it was drawn from. The newest four of a
  repository are kept, and an older one comes back, as that commit, when its map is used.

## [0.2.0]

- The dot drawing in an empty chat no longer has a red dot in it: it is all in ink.
- Polish:
  - A map drawn by the Mapper is shown being built, like any other edit (Settings → Editor →
    **Show edits being built**).
  - The outlines around new and changed shapes (the review's, and the flash) come in with
    their shapes; they used to stand around shapes that were not there yet.
  - **New Chat** during a request no longer leaves "Stopped." as the new chat's first line.
  - A map with more than 600 connectors got no routing at all. The connectors inside each
    top-level box are now routed, box by box, for up to six seconds; what runs between the
    boxes is left as drawn.
- **Long chats with an API model.** The whole conversation goes to the provider with every
  request, so a long chat cost more each time and in the end the provider refused it. When a
  conversation has grown long (about 60,000 tokens), the model is asked to sum it up for
  itself, and the chat goes on in a new conversation that starts with that summary. The chat
  says so; the summary itself is not shown. The diagram is read again as needed.
- **Test an API key** (Settings → Agents & models → API keys → **Test**): sends one short
  request to the provider the way the chat does (the chat's tools as they are, one tool call
  and its answer) and says whether it worked, or what the provider answered. Keeping a key
  only lists its models; this is the check that the provider takes the chat's requests. It
  runs on your click only and uses a little of your credit. No tool is run and the diagram
  is not touched.
- **A run log.** The app notes when it started and how it ended in `logs/app.log` in its data
  folder (on macOS `~/Library/Application Support/OmniDraw`): a quit, a window's page or a
  helper process that ended and why, an error in the main process. A run that ended without a
  word (a crash, a kill) is named by the next start. It holds times and reasons only, never a
  diagram, a request or a key.
- Development: the end-to-end run builds into `out-e2e` and starts the app from there, so a
  test no longer replaces the files of a copy of the app that is running from `out`.
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
- Cleaning an SVG takes time in step with its size, whatever it is made of. A crafted SVG from
  a gallery or a library (`<!--`, `<script ` or `url(` thousands of times, never closed) could
  hold the app for half a minute. An SVG in which a comment, a processing instruction, a CDATA
  section, a DOCTYPE, a tag or a dropped element (a script, an animation) never ends is now
  left out, where part of it used to stay; a script is dropped whatever its prefix
  (`a.b:script` used to pass).
- A cleaned SVG has to stay as it is when it is cleaned again. One in which taking a link or
  an `@import` out put an event handler, a link or a `foreignObject` together from its two
  halves (`o href="x"nload="…"`) came back with it; it is now left out.
- An SVG that keeps its CSS in a CDATA section (Illustrator writes it so) keeps it: the icon
  has its colours again. The CSS is cleaned like any other.
- An SVG whose root tag has a `>` inside an attribute's value no longer gets a second `xmlns`
  (it did not show after that).
- An SVG with a tag that is not written the way XML writes one (attributes with nothing
  between them, without quotes or without a value, a `<` in a value, a `<` in text that begins
  no tag) is left out: a browser shows nothing of it as an image, and read as HTML it could
  keep an event handler (`<rect width="9"onclick="…"/>`). A link under an unusual prefix
  (`a.b:href`) is no longer kept. The size of an SVG whose root tag has a `>` inside a value
  is read right.
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
