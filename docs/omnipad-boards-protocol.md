# Go live: sharing a diagram through OmniPad

A note both sides build to: OmniDraw (this repository) and OmniPad (the `rustpad` repository).
It says what "Go live" does, what each side has today, and the protocol between them. Where it
proposes something OmniPad has not built, it says so: those parts are OmniPad's to confirm or
change. Version 3 of this note, 2026-11-26 (version 1 did not say how someone whose change crossed
another's catches up with the server's order; version 2 let them vouch for a checksum
meanwhile).

## What it is for

In OmniDraw you press **Go live** on an open diagram. You get a link. Whoever opens the link
works on the diagram with you, at the same time: in a browser on OmniPad's site, or in OmniDraw
if they have it. You see their cursors and what they have selected. Your file stays yours: it
is saved on your computer as always, and the shared copy goes away when you stop.

Words used below:

- **board**: a shared diagram on the OmniPad server. Like a pad, but its content is a diagram.
- **host**: the person who went live. Their OmniDraw holds the file the board came from.
- **guest**: anyone who joined by the link.
- **patch**: one change to the diagram, as draw.io describes it (cells added, changed, removed).
- **snapshot**: the whole diagram as XML.

## What each side has today

**OmniPad** (text pads only):

- One WebSocket per pad, `/api/socket/{padId}`, JSON messages tagged by name (`{"Edit":{…}}`).
  The server puts edits in one order and sends them to everyone.
- Pads are open by default: anyone with the link can edit. A signed-in owner can make a pad
  private and create invite links (`POST /api/pads/{id}/invites`: role, expiry, uses), which
  guests without an account can use (`POST /api/pads/{id}/join`, then a 60-second
  single-use ticket for the socket).
- Text only: operations are text transforms with a 256 KiB limit. Diagram XML sent through
  them would be corrupted by two people editing at once. So boards are a new kind of document.
- Its Phase 5 proposal (`docs/proposals/phase5-board-sync-analysis.md`) already describes
  boards as this note does: the server orders and relays draw.io patches and keeps a snapshot.

**draw.io** (32.4.1, in this repository's `drawio` folder) has what is needed in its embed
protocol, unused so far:

- Loaded with `diffSync: true`, every `autosave` event carries a `patch` and a `checksum` of
  the result beside the XML.
- `{action: "patch", patch, checksum}` applies someone else's patch without echoing it, and
  answers with its own checksum and `checksumMismatch` when the two differ.
- `{action: "resetDiff", xml}` loads a whole diagram as the new starting point.

Patches are keyed by cell id, so two people changing different shapes never collide. Two
people changing the same shape: per attribute, the later patch wins.

**OmniDraw** has the presence half from the VS Code extension's Live Share feature: a plugin in
the editor (`drawio-custom-plugins/src/liveshare.ts`) reports the cursor, the selection and the
selection rectangle in diagram coordinates, and draws other people's.

## The flow

1. **Go live.** OmniDraw sends the server the diagram and gets a board id back. The link is
   made from it. OmniDraw connects to the board's socket like any other participant.
2. **Join.** A guest opens the link. In a browser, OmniPad's page shows the board in an
   embedded draw.io. In OmniDraw, **File → Join a Shared Diagram…** takes the link (later also
   an `omnidraw://` address, so a click opens the app).
3. **Work.** Each change is a patch. The sender's client sends it; the server numbers it and
   sends it to the others; they apply it. Cursors and selections travel beside it.
4. **Stop.** The host presses **Stop sharing**. The board is closed and guests are told. A
   guest's browser offers to download the diagram as it was. The host's file is unchanged by
   stopping.

The host's file is the master copy. OmniDraw saves it as it always does, with everyone's
changes in it. A guest in OmniDraw works on the board only: nothing is saved on their computer
unless they choose **Save a Copy**.

## The link

Version 1, no account needed (what an open pad is today):

```
https://<omnipad>/b/<boardId>
```

`boardId` is 128 random bits, base64url (22 characters): the link is the permission. Anyone
who has it can edit, so OmniDraw treats it as a secret: it is shown and copied, never logged.

Version 2, with OmniPad's invites (needs the host signed in to OmniPad): the board is private,
and links are OmniPad invite links with a role (editor or viewer), an expiry and a number of
uses, revocable, as pads have them today:

```
https://<omnipad>/b/<boardId>?invite=<code>
```

OmniDraw recognises both. The server address is a setting (Settings → Sharing → OmniPad
server); there is no built-in default until OmniPad says which address is the public one.

## HTTP (proposed; OmniPad's to confirm)

Named after the pad routes they mirror.

| Call | Does | Notes |
|---|---|---|
| `POST /api/boards` | Creates a board | Body `{kind: "drawio", title, xml, checksum}`. Answers `{id, revision: 0, expires_at}`. `kind` may later be `"excalidraw"` |
| `GET /api/boards/{id}` | Says what it is | `{kind, title, revision, role, people}`; 404 when closed or expired |
| `DELETE /api/boards/{id}` | Closes it | Only the creator: the answer to `POST` also carries `owner_key`, sent back here as `X-Board-Owner`. Everyone connected gets `Closed` |
| `POST /api/boards/{id}/invites`, `/join`, `/ticket` | As for pads | Version 2 |

## The socket

`wss://<omnipad>/api/boards/{id}/socket` (version 2: `?ticket=…`). JSON, tagged by name like
the pad messages. `revision` counts patches the server has accepted, from 0.

**From a client**

| Message | Meaning |
|---|---|
| `{"Hello": {"name", "hue", "client"}}` | First message. `client` is like `"omnidraw/0.4.0"` or `"omnipad-web/1"` |
| `{"Patch": {"base", "patch", "checksum"}}` | A change. `base` is the revision this client's diagram will be at once all it has sent is accepted (see "How changes are ordered"). `patch` is draw.io's object, passed on untouched. `checksum` is draw.io's for the sender's diagram after the change, or `null` when the sender cannot vouch that its diagram is in the server's order (rule 4 below) |
| `{"Snapshot": {"revision", "xml", "checksum"}}` | The whole diagram at `revision`, from a client whose diagram is in the server's order (rule 6 below). Sent when the server asks, and by the host now and then when things are quiet. The server keeps it only if it has no newer one |
| `{"Presence": {"page", "cursor", "selection", "rect"}}` | Where this person is. `cursor` `{x, y}` or null and `rect` `{start, end}` or null, in diagram coordinates; `selection` a list of cell ids; `page` the page id. At most 30 a second |
| `{"Resync": {}}` | "Mine no longer matches: send me the diagram." |

**From the server**

| Message | Meaning |
|---|---|
| `{"Identity": {"id", "role", "owner"}}` | Who you are here. `role` `"editor"` or `"viewer"` |
| `{"Board": {"revision", "xml", "checksum", "patches"}}` | The diagram: the newest snapshot, and the patches accepted since it, in order (`[{revision, from, patch, checksum, clean}]`). Sent on joining and after `Resync`. The client loads the XML (`resetDiff`) and applies the patches |
| `{"Patch": {"revision", "from", "patch", "checksum", "clean"}}` | Someone's change, numbered. Not sent back to its sender |
| `{"Ack": {"revision", "clean"}}` | To the sender, in its place in the stream: your patch is this revision. Not clean: see rule 4 below |
| `{"NeedSnapshot": {}}` | "Send me a `Snapshot`": to one client, when the list of patches since the last snapshot is long (more than 500, or 4 MiB) |
| `{"UserInfo": {"id", "info"}}` | Someone's name and hue; `info` null when they left |
| `{"Presence": {"id", "page", "cursor", "selection", "rect"}}` | Someone's position |
| `{"Closed": {"reason"}}` | The board is over (`"host"`, `"expired"`), or you were removed (`"removed"`) |

### How changes are ordered

The server does not read patches. It numbers them in the order they arrive and passes them on.
That order is the truth: everyone's diagram must end up as the snapshot with the patches
applied in revision order. Someone who made a change at the same moment as someone else has
applied the two the other way round, and has to catch up. The rules:

1. **`base`** is the revision the sender's diagram will be at once everything it has sent is
   accepted: the last revision it has applied, plus the number of its own patches not yet
   acknowledged. (So two quick changes in a row are `base` 5 and `base` 6, not both 5.)
2. A patch is **clean** when its `base` is the server's revision just before the patch gets its
   number (nothing of anyone else's arrived in between) *and* it carries a `checksum`. Then
   that checksum is the one everyone should have at that revision. A sender gives a checksum
   only while its own diagram is known to be in the server's order: from the moment someone
   else's patch arrives while one of its own is unacknowledged, until it has reconciled (or
   found there was nothing to reconcile, rule 4), it sends `checksum: null`. Its patches then
   count as not clean for everyone, itself included, whatever their `base`.
3. **Receiving.** Everyone applies others' patches in revision order as they arrive. After a
   clean one, a client that has nothing of its own unacknowledged compares its checksum
   (draw.io gives it in its answer to `patch`) with the patch's. A difference means this client
   has drifted: it reconciles (rule 5).
4. **Sending.** A sender whose patch comes back `clean: false` made its change before
   someone else's that the server put first. Its own diagram has them in the other order, and
   where the two touched the same thing it now shows the wrong one. (A sets a label, B sets the
   same label; the server takes A, then B. Everyone must show B's. B received A's patch after
   making its own and shows A's.) It keeps working (its patches in the meantime carry no checksum, rule 2),
   and as soon as none of its own patches are unacknowledged it reconciles (rule 5). It may skip that when it can tell the crossed patches
   apart: they touch different cells and nothing of a page itself (its name, order, settings),
   so either order gives the same diagram.
5. **Reconciling** is `Resync`: the server answers with `Board`, and the client *replaces* its
   diagram with the snapshot and applies the patches in order. Replacing means the result's
   checksum equals the snapshot's before the patches go on: a load that merges with what the
   client had is not enough, and a client that cannot get that checksum loads the snapshot
   from scratch. Changes the person makes between sending `Resync` and receiving `Board` are
   held back, not sent; after the `Board` is in, they are applied on top again and sent then.
6. **Snapshots** come only from a client whose diagram is known to be in the server's order:
   nothing of its own unacknowledged, and nothing waiting to be reconciled.
7. If one client asks for `Resync` three times within a minute, the server asks the host for a
   `Snapshot` and sends everyone the `Board`: the host's copy settles it.

With these, two people changing different shapes never notice each other; two people changing
the same shape both end with the change the server numbered last, and the one whose change
lost sees it replaced a moment later.

### Limits (proposed)

- Snapshot at most 8 MiB, one patch at most 1 MiB, a board at most 32 people.
- A board nobody is connected to is removed after 7 days, and at once when the host stops.
- Viewers' `Patch` and `Snapshot` messages are refused; their clients open the diagram
  read-only.

## What OmniDraw does with what arrives

- A diagram from a board is someone else's content. It goes through draw.io's own loading and
  nothing in it runs: the app's rules for an opened file apply (no scripts, no links followed
  by themselves, remote requests blocked).
- Remote changes are not the user's edits: they do not enter the AI review (pending changes),
  and Undo in one person's window does not take back another person's change.
- While live, the AI chat still edits the diagram; its changes are patches like any other and
  everyone sees them arrive.
- The link, the owner key and (version 2) the OmniPad session are kept out of logs and out of
  anything sent to an agent. A session token is stored in the Keychain like the API keys.

## Excalidraw boards

The same server and messages carry them: `kind: "excalidraw"`, the snapshot is the scene JSON,
and a patch is the list of elements that changed. Excalidraw's own `reconcileElements` merges
them by each element's `version` and `versionNonce`, so the server still only numbers and
relays. Presence uses Excalidraw's collaborator pointers. This waits for the Excalidraw canvas
in OmniDraw.

## Decisions still open

1. **The same shape, two people.** Later change wins per attribute (what draw.io does), or a
   shape someone has selected is locked for the others (the selection is already sent).
2. **Signing in from the desktop app** (for version 2's invite links): OmniPad's sign-in page
   in a browser window, handing the app a session; or a token made on OmniPad's site and pasted
   into Settings.
3. **The public server address**, and whether OmniDraw ships with it filled in.
4. **How long a board lives** when the host does not stop it (7 days proposed; pads live 1).
5. **Where the browser side lives**: OmniPad's Phase 5 proposal has it in an MIT package
   written fresh, because this repository is GPL-3.0 and its code must not be copied there.

## Building it

- **Here (OmniDraw):** the session (socket, ordering, resync), draw.io loaded with diff sync
  while live, presence through the existing plugin, the Go live and Join windows, the setting.
  Tested against a small relay that speaks this protocol (`standalone/test/helpers`), which
  also lets two OmniDraw windows share a diagram on one computer before OmniPad has boards.
- **OmniPad:** the board document type and its routes, the browser page with draw.io embedded,
  invites for boards.
