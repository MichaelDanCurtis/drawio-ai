---
applyTo: "**/*.drawio,**/*.dio,**/*.drawio.svg,**/*.drawio.png"
description: Draw.io diagrams are changed with Draw.AI's drawio_* tools, not by editing their XML.
---
Draw.io diagrams (.drawio, .dio, .drawio.svg, .drawio.png) open in the Draw.AI editor, and the drawio_* tools (drawio_get_diagram, drawio_apply_operations, drawio_lint, drawio_export, ...) change the open diagram live.

- To change a diagram, read it with drawio_get_diagram and edit it with drawio_apply_operations. If it is not open in the editor, ask the user to open it.
- Do not rewrite a diagram file's XML with file-editing tools: the change would skip the live view and the user's review of AI changes, and .drawio.svg/.drawio.png files embed the diagram in a form that is easy to break.
- For diagram-heavy work, the "Draw.AI" agent in the chat's agent picker is set up with these tools.
