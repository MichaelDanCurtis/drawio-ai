# omnidraw-frame

OmniDraw's editor add-ons for draw.io, as one script another page can load into a framed
draw.io: the look (theme, toolbar, icons), the AI's editing tools, Visio and PDF export, the
importers, presentation mode, and the pieces that put a shared diagram in place.

Licence: **GPL-3.0** (see `LICENSE.md`). The source is the `drawio-ai` repository
(`drawio-custom-plugins/` and `standalone/src/renderer/`). A page that loads this script into a
frame and talks to it with messages is a separate work; a page that links it into its own code
is not.

Built for draw.io **32.4.1**. `VERSION` holds the OmniDraw version it was built from.

## What is in the folder

| File | What |
|---|---|
| `omnidraw-frame.js` | Everything, in load order. A classic script |
| `ui/*.js` | Modules the toolbar loads when it needs them (the dot layers) |
| `ui/fonts/*.woff2` | Space Grotesk, Space Mono, Doto |
| `LICENSE.md`, `VERSION` | |

## Loading it

Serve the folder anywhere, say at `/omnidraw`. In the frame, **before** the script runs, set

```js
window.omnidrawConfig = {
  base: "/omnidraw",        // where this folder is served: fonts and ui/*.js load from <base>/ui
  host: "omnipad",          // a name for the host; "desktop" and "vscode" are OmniDraw's own
  name: "OmniPad",          // shown where the add-ons name the product
  icons: "dots2d",          // classic | dots2d | dots | real
  toolbar: "top",           // top | left | right | bottom
  matrix: "grey",           // the dot layer behind the page: grey | green | off
  presence: false,          // false: the host shows other people itself (see "Sharing")
  hostOrigin: undefined,    // default: the frame's own origin
  features: { chat: false, workshop: false, shortcuts: false },
};
```

then load `omnidraw-frame.js` after draw.io's own scripts and before the editor starts: as a
draw.io plugin (`plugins` in its configuration), or as a script tag added before `init`. Every
part registers through `Draw.loadPlugin`.

`features`, each `false` to leave it out: `toolbar` (the buttons, the icons, the toolbar's
place), `matrix`, `chat` (the arrow that opens the host's chat), `workshop` (the Shape Workshop
button), `shortcuts` (key hints in tooltips, and the keys themselves).

## Talking to it

Messages are JSON text both ways, on the channel draw.io's embed mode already uses: the host
posts `{"action": …}` to the frame, the frame posts `{"event": …}` to the page that frames it.
A message is taken only from that page, and only from `hostOrigin`.

### Export and import (answered with an event of the same name)

| Action | Answer |
|---|---|
| `aiExportVsdx {currentPageOnly}` | `data` (base64 of the .vsdx), `pages`, `shapes`, `connectors`, `images`, `warnings`, `error?` |
| `aiExportPdf {currentPageOnly, title?}` | `data` (base64 of the PDF), `pages`, `warnings`, `error?`. Each page is placed as a picture: text is not selectable |
| `aiPrintPdf {currentPageOnly, title?}` | `pages`, `warnings`, `error?`. Opens the browser's print dialog on every page as an SVG, one to a sheet of the drawing's size: "Save as PDF" there gives a PDF whose text stays text |
| `aiImportDiagram {format, fileName, data}` | `format`: visio, gliffy, graphml, lucidchart, miro, csv; `data`: base64. Answers `xml` (an uncompressed `<mxfile>`), `kind`, `library?` (a Visio stencil as a draw.io library), `pages`, `shapes`, `connectors`, `warnings`, `error?`. The open diagram is not touched |
| draw.io's own `export` (`xmlpng`, `xmlsvg`) and `getXml` | as draw.io documents them |

### The AI's tools

`aiGetModel`, `aiApplyOps`, `aiSetSelection`, `aiPages`, `aiSearchShapes`, `aiExportImage`,
`aiSetStatus`, `aiResolveReview` and the rest are what OmniDraw's own agents use;
`drawio-custom-plugins/src/types.d.ts` in the source has every field. Each answers with an
event (`aiModel`, `aiApplyOpsResult`, `aiAck`, …) that carries the action back as `message`.

### Sharing

For a host that shares a diagram between people:

| Action | What |
|---|---|
| `setDiffSync {on}` | Turns draw.io's diff sync on for the open diagram without loading it again |
| `liveLock {on}` | Locks the editor while a diagram takes the open one's place (answers `liveLock`) |
| `liveCompose {xml, patches}` | Works out a diagram from a whole one and the changes since, without touching the open one (answers `liveCompose {xml, checksum}`) |
| `liveLoading {on}` | Says for how long the diagram is not what it will be: an AI change under review is not judged meanwhile |
| `liveNotice {text}` | A line for the person, shown for a few seconds |
| `updateLiveshareViewState {cursors, selectedCells, selectedRectangles, lockedCells}` | Draws the others; `lockedCells` cannot be selected. Ignored with `presence: false` |

To put a diagram in place of the open one without a reload: `liveLock {on: true}`, then
draw.io's `resetDiff` with the diagram's XML (it merges, so only what differs changes; the view,
the selection and the undo history stay), then `liveLock {on: false}`.

With `presence: false` the add-ons report nothing of this person's pointer and selection,
draw nothing of the others', and keep no shape from being selected: the host does all of that.

### Events the host may ignore

`pluginLoaded`, `livePage {page}`, `desktopCommand {command}` (a toolbar button the host owns:
`settings`, `toggleChat`, `workshop`, `present`, `exitPresentation`, `shapeSets`), `desktopState`, `desktopMenus`, `desktopShapeSets`,
`desktopGallerySearch`, `invokeCommand`, and, with presence on, `cursorChanged`,
`selectedCellsChanged`, `selectedRectangleChanged`.
