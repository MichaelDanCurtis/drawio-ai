# Go live: sharing a diagram through OmniPad

OmniDraw's **Go live** puts the open diagram on an OmniPad server as a *board* and gives a
link to it. Whoever opens the link, in OmniDraw or in OmniPad in a browser, works on the same
diagram at the same time.

**The protocol is OmniPad's.** Its reference is `packages/board-sync/PROTOCOL.md` in the
OmniPad repository, next to the message types in `packages/board-sync/src/protocol.ts`. An
earlier note in this place proposed a protocol of OmniDraw's own; the two were merged into
OmniPad's (2026-11-26), so that only one side translates. This file says what OmniDraw does
with it, and what it does on its own side that the wire does not show.

OmniDraw's code is in `standalone/src/main/live/`:

| File | What |
|---|---|
| `protocol.ts` | The messages OmniDraw sends and reads, the link, which changes can be told apart |
| `session.ts` | One person's side of a board: the rules below. Knows nothing of draw.io or sockets |
| `connection.ts` | The HTTP calls that share and end a board, and the socket to its pad |
| `liveShare.ts` | draw.io behind the session, pointers and held shapes, the window's part |

## The shape of it

- A board lives **in a pad** and is reached over the pad's socket (`/api/socket/{pad}`), next
  to the pad's text. OmniDraw reads the board's messages and who is on the pad; the rest (the
  pad's text, its files) it leaves alone.
- **Go live** asks the server for a pad of its own holding one board:
  `POST /api/boards {kind: "drawio", title, content}` answers `{pad, board, path, link, owner_key}`.
  The pad's id is 128 random bits: **the link is the permission**, so OmniDraw treats it as a
  secret (shown and copied when asked, never logged, never sent to an agent). The owner key
  stays in memory and is used once, to end the board.
- **The link** is `https://<omnipad>/b/<pad>/<board>`. OmniDraw also reads the address a browser
  shows once that link has opened, `https://<omnipad>/?pad=<pad>&board=<board>`, since that is
  what people copy.
- **Stop sharing** is `DELETE /api/boards/{pad}` with the owner key. Everyone gets the pad's
  board list without the board, then their connection closes, and the link answers 404.
  OmniDraw reads "my board left the list" as the end of sharing, and a connection that closes
  without it as a lost connection. A host that closes its window ends its board first.
- A board in **someone's own pad** can be joined the same way while that pad is open to
  anyone. Private pads need OmniPad's invites and sign-in, which OmniDraw does not do yet.

## How changes are ordered

The server numbers changes in the order they arrive and passes them on; everyone applies them
in that order. A change is draw.io's own page diff (its embed "diff sync"), which OmniDraw
turns on for the open diagram.

- **Base.** Each change says the revision this diagram will be at once everything sent before
  it is in. A change whose base is the server's revision was "made on the latest": its checksum
  is passed on.
- **Receipts.** A change comes back to its sender, numbered. Until then it is *in flight*.
- **Checksums.** OmniDraw sends draw.io's checksum with a change, as a number, and compares one
  only when nothing of its own is in flight (its diagram would also hold that). A mismatch
  means this diagram has drifted: it asks for the board's.
- **Crossing.** Someone else's change that arrives while one of this person's is in flight was
  put before it by the server, and after it here. If the two only change different shapes, the
  result is the same either way. Otherwise (the same shape, a shape added, removed or moved
  among its siblings, a page) OmniDraw asks for the board's diagram as soon as its receipts
  are in, and sends no checksum until it has it: it cannot vouch for its diagram meanwhile.
- **Epochs.** Every time this connection starts over on the board (opening it, asking for its
  diagram again, a refusal) it moves to a new epoch and says so with each change. The server
  drops changes from an epoch the connection has left.

## Held shapes

What a person has selected is theirs for as long as it is: the server refuses, whole, a change
that touches a shape someone else holds.

- OmniDraw says what is selected as the server knows shapes, `<page>/<cell>`, with where the
  pointer is.
- Shapes others hold are outlined in their holder's colour (from what the server says they
  hold) and **cannot be selected**, so they are not moved, restyled or deleted by hand.
- The AI's edits leave them be: an operation that would change one fails with a sentence that
  says why, and the rest of the batch goes on.
- A change that gets through all the same (two people at the same instant, a group deleted
  with a held shape in it) is **refused by the server**: it and whatever was done in the moment
  after it are undone by the board's diagram that follows, and a line in the editor says whose
  shape it was. What the person does while that diagram is on its way is kept and goes on top.

## Catching up

When OmniDraw asks for the board's diagram (or the server sends it after a refusal), the
answer is the whole diagram the server keeps and the changes since. OmniDraw works the result
out off to one side with draw.io's own functions, then merges it into the open diagram so
that only what differs changes: the view, the selection, the undo history and an open AI
review stay. The editor is locked for that moment; a change made just before the lock took
hold is kept and sent afterwards. A diagram that cannot be put in place ends sharing in that
window, with the diagram as it was.

## The whole diagram, for the server

The server keeps a whole diagram and the changes since, and now and then wants a fresh one. It
takes one only from someone in step, and (until its list of changes is long) only while nobody
else holds a shape. OmniDraw sends its diagram when the server asks and a few seconds after
things have gone quiet, if it is settled (nothing in flight, nothing held back, nothing to put
right).

## What is not built

- Joining a private pad (an invite code, signing in to OmniPad from the desktop app).
- Opening a link by clicking it (`omnidraw://`), and reconnecting by itself when the
  connection drops: a lost connection ends sharing in that window, with the diagram kept.
- Excalidraw drawings: OmniPad shares those too, OmniDraw's Excalidraw windows do not yet.

## Trying it

- With OmniPad: give its address as the OmniPad server in **File → Go Live…**.
- Without one: `node standalone/test/helpers/boardRelay.js` is a stand-in that speaks the part
  of the protocol Go live uses (written from the reference, not from OmniPad's code). It is
  what the tests run against.
- `yarn e2e --live` runs two windows through the stand-in. `--omnipad http://127.0.0.1:<port>`
  runs the same through an OmniPad server started by hand on this computer.

Both sides run the same draw.io version (32.4.1): a checksum is draw.io's hash of its own
pages, and two versions that write a shape differently would disagree on every change. Raise
it on both sides together.
