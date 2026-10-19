
declare type CustomDrawioAction = UpdateVerticesAction | AddVerticesAction | GetVerticesAction
    | LinkSelectedNodeWithDataAction | NodeSelectionEnabledAction | UpdateLiveshareViewState
    | AiGetModelAction | AiApplyOpsAction | AiSetSelectionAction | AiSetLassoModeAction
    | AiSetStatusAction | AiOpenPromptAction | AiExportImageAction | AiSearchShapesAction
    | AiResolveReviewAction | AiSetMarkupModeAction | AiSetBadgesAction | AiExportVsdxAction | AiImportDiagramAction
    | AiPagesAction;
declare type CustomDrawioEvent = NodeSelectedEvent | GetVerticesResultEvent
    | UpdateLocalStorage | PluginLoaded | CursorChangedEvent | SelectionChangedEvent | FocusChangedEvent | InvokeCommandEvent | SelectionRectangleChangedEvent
    | AiModelEvent | AiApplyOpsResultEvent | AiAckEvent | AiAskEvent | AiLassoEvent | AiExportImageEvent | AiSearchShapesEvent
    | AiReviewEvent | AiMarkupEvent | AiBadgeClickEvent | AiExportVsdxEvent | AiImportDiagramEvent | AiPagesEvent;

// ---------------------------------------------------------------------------
// AI protocol
// ---------------------------------------------------------------------------

declare interface AiRect { x: number; y: number; width: number; height: number }

declare interface AiCell {
    id: string;
    kind: "vertex" | "edge" | "container" | "group";
    label: string;
    style?: string;
    /** Omitted when the parent is the default layer. */
    parent?: string;
    layer?: string;
    geometry?: AiRect;
    source?: string;
    target?: string;
    /** Edge waypoints, in graph coordinates. */
    points?: { x: number; y: number }[];
    /** Custom attributes of object-valued cells (tooltip, link, placeholders, ...). */
    data?: Record<string, string>;
    selected?: boolean;
    /** Only for scope=selection: cell is not selected but adjacent to the selection. */
    context?: boolean;
}

declare interface AiDiagramModel {
    /** The page that was read; `current` when it is the one shown in the editor. */
    page: { id: string; name: string; index: number; count: number; current: boolean };
    layers: { id: string; name: string; visible: boolean; locked: boolean }[];
    bounds: AiRect;
    selection: string[];
    cells: AiCell[];
    truncated: boolean;
    totalCells: number;
}

declare type AiStyleValue = string | number | boolean | null;

declare type AiPlacement = {
    relativeTo: string;
    side: "right" | "left" | "above" | "below";
    gap?: number;
};

declare type AiOp =
    | { op: "addShape"; tempId?: string; label?: string; x?: number; y?: number; width?: number; height?: number;
        style?: string; styleProps?: Record<string, AiStyleValue>; parent?: string; placement?: AiPlacement; data?: Record<string, string> }
    | { op: "addEdge"; tempId?: string; source: string; target: string; label?: string; style?: string;
        styleProps?: Record<string, AiStyleValue>; parent?: string; points?: { x: number; y: number }[] }
    | { op: "update"; id: string; label?: string; style?: string; styleProps?: Record<string, AiStyleValue>;
        x?: number; y?: number; width?: number; height?: number; parent?: string;
        source?: string; target?: string; data?: Record<string, string | null> }
    | { op: "delete"; ids: string[]; includeEdges?: boolean }
    | { op: "move"; ids: string[]; dx: number; dy: number }
    | { op: "resize"; ids: string[]; width?: number; height?: number; scale?: number }
    | { op: "group"; ids: string[]; tempId?: string; label?: string; style?: string; padding?: number }
    | { op: "ungroup"; ids: string[] }
    | { op: "align"; ids: string[]; align: "left" | "center" | "right" | "top" | "middle" | "bottom" }
    | { op: "distribute"; ids: string[]; direction: "horizontal" | "vertical" }
    | { op: "zOrder"; ids: string[]; position: "front" | "back" }
    | { op: "layout"; ids?: string[]; parent?: string;
        type: "hierarchical" | "horizontalHierarchical" | "tree" | "horizontalTree" | "radialTree" | "organic" | "circle" | "grid";
        spacing?: number }
    | { op: "insertXml"; xml: string; dx?: number; dy?: number; parent?: string }
    | { op: "replaceAll"; xml: string }
    | { op: "addLayer"; tempId?: string; name?: string; visible?: boolean; locked?: boolean; position?: "front" | "back" }
    | { op: "renameLayer"; id: string; name: string }
    | { op: "setLayerVisible"; id: string; visible: boolean }
    | { op: "setLayerLocked"; id: string; locked: boolean }
    | { op: "moveToLayer"; ids: string[]; layer: string };

declare interface AiOpResult {
    index: number;
    op: string;
    ok: boolean;
    error?: string;
    ids?: string[];
}

declare interface AiGetModelAction {
    action: "aiGetModel";
    scope: "page" | "selection";
    includeStyles: boolean;
    maxCells: number;
    /** Id or name of the page to read; default the one shown in the editor, which stays shown. */
    page?: string;
}

declare interface AiApplyOpsAction {
    action: "aiApplyOps";
    ops: AiOp[];
    selectResult: boolean;
    flash: boolean;
    /** Stop at the first failing operation and roll the whole batch back. */
    atomic: boolean;
    /** Keep the result as a pending AI change the user accepts or rejects. */
    review?: boolean;
}

declare interface AiSetSelectionAction {
    action: "aiSetSelection";
    cellIds: string[];
    reveal: boolean;
}

declare interface AiSetLassoModeAction {
    action: "aiSetLassoMode";
    enabled: boolean;
}

declare interface AiSetStatusAction {
    action: "aiSetStatus";
    busy: boolean;
    text?: string;
}

declare interface AiOpenPromptAction {
    action: "aiOpenPrompt";
}

declare interface AiExportImageAction {
    action: "aiExportImage";
    /** Restrict to these cells (and their descendants); whole page when empty. */
    cellIds: string[];
    maxSize: number;
}

declare interface AiModelEvent {
    event: "aiModel";
    message: AiGetModelAction;
    model: AiDiagramModel;
    /** E.g. no such page; `model` is then empty. */
    error?: string;
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

declare interface AiPageInfo {
    id: string;
    name: string;
    index: number;
    /** Shapes and connectors on the page. */
    cells: number;
    /** Shown in the editor. */
    current: boolean;
}

declare interface AiPagesAction {
    action: "aiPages";
    op: "list" | "add" | "rename" | "duplicate" | "move" | "select" | "delete";
    /** Id or name of the page to act on (all but list and add). */
    page?: string;
    /** add, rename, duplicate: the page's name. */
    name?: string;
    /** add, duplicate, move: 0-based position. */
    index?: number;
    /** add, duplicate: show the new page. Default true. */
    select?: boolean;
    /** Keep the change pending, like other AI changes, until the user accepts or rejects it. */
    review?: boolean;
    /** delete: only resolve the page and report it; nothing is deleted. */
    dryRun?: boolean;
}

declare interface AiPagesEvent {
    event: "aiPages";
    message: AiPagesAction;
    /** Every page, after the operation. */
    pages: AiPageInfo[];
    /** The page the operation acted on (the new page for add and duplicate; as it was, for delete). */
    page?: AiPageInfo;
    /** The page is one the AI added in the pending review. */
    aiAdded?: boolean;
    error?: string;
}

declare interface AiApplyOpsResultEvent {
    event: "aiApplyOpsResult";
    message: AiApplyOpsAction;
    results: AiOpResult[];
    idMap: Record<string, string>;
    rolledBack: boolean;
}

declare interface AiAckEvent {
    event: "aiAck";
    message: AiSetSelectionAction | AiSetLassoModeAction;
    error?: string;
}

declare interface AiExportImageEvent {
    event: "aiExportImage";
    message: AiExportImageAction;
    /** PNG data URL, or empty when export is not possible. */
    dataUrl: string;
    error?: string;
}

declare interface AiExportVsdxAction {
    action: "aiExportVsdx";
    /** Only the page that is visible in the editor; otherwise every page. */
    currentPageOnly: boolean;
}

declare interface AiExportVsdxEvent {
    event: "aiExportVsdx";
    message: AiExportVsdxAction;
    /** Base64 of the .vsdx package; empty when the export failed. */
    data: string;
    pages: number;
    shapes: number;
    connectors: number;
    images: number;
    warnings: string[];
    error?: string;
}

declare interface AiImportDiagramAction {
    action: "aiImportDiagram";
    /** "csv" builds the diagram in the editor, which must be empty, and empties it again. */
    format: "visio" | "gliffy" | "graphml" | "lucidchart" | "miro" | "csv";
    /** The file's name: it tells Visio drawings, stencils and templates apart. */
    fileName: string;
    /** Base64 of the file. */
    data: string;
    /** Gives up when draw.io's converter has not finished by then. */
    timeoutMs?: number;
}

declare interface AiImportDiagramEvent {
    event: "aiImportDiagram";
    /** The action without its data. */
    message: AiImportDiagramAction;
    /** An uncompressed <mxfile>; empty when the conversion failed. */
    xml: string;
    /** "stencil" when a Visio stencil's shapes were laid out on a page. */
    kind: "diagram" | "stencil";
    pages: number;
    shapes: number;
    connectors: number;
    /** What did not carry over. */
    warnings: string[];
    error?: string;
}

declare interface AiSearchShapesAction {
    action: "aiSearchShapes";
    query: string;
    limit: number;
}

declare interface AiShapeTemplate {
    title: string;
    library?: string;
    style: string;
    width: number;
    height: number;
    isEdge: boolean;
    /** Present when the template consists of several cells (e.g. a UML class). */
    xml?: string;
}

declare interface AiSearchShapesEvent {
    event: "aiSearchShapes";
    message: AiSearchShapesAction;
    shapes: AiShapeTemplate[];
    error?: string;
}

/** The user asked the AI something from inside the diagram (inline prompt). */
declare interface AiAskEvent {
    event: "aiAsk";
    prompt: string;
    cellIds: string[];
    region?: AiRect;
    /** How the request was made in the diagram; defaults to the inline prompt. */
    source?: "prompt" | "markup" | "image";
    /** Number of marks, for source=markup. */
    markCount?: number;
    images?: { mimeType: "image/png"; base64: string }[];
}

declare interface AiBadge {
    cellId: string;
    kind: "error" | "warning" | "info";
    tooltip: string;
}

/** Replaces all badges of `group` (small clickable icons on cells; not saved in the file). */
declare interface AiSetBadgesAction {
    action: "aiSetBadges";
    group: string;
    badges: AiBadge[];
}

declare interface AiBadgeClickEvent {
    event: "aiBadgeClick";
    group: string;
    cellId: string;
}

declare interface AiSetMarkupModeAction {
    action: "aiSetMarkupMode";
    enabled: boolean;
}

/** Markup mode was entered or left inside the diagram. */
declare interface AiMarkupEvent {
    event: "aiMarkup";
    active: boolean;
}

/** The user finished a lasso selection inside the diagram. */
declare interface AiLassoEvent {
    event: "aiLasso";
    cellIds: string[];
    region?: AiRect;
    lassoModeEnabled: boolean;
}

declare interface InvokeCommandEvent {
    event: "invokeCommand";
    command: "export" | "exportVisio" | "importDiagram" | "save" | "convert";
}

declare interface FocusChangedEvent {
    event: "focusChanged";
    hasFocus: boolean;
}

declare interface NodeSelectionEnabledAction {
    action: "setNodeSelectionEnabled";
    enabled: boolean;
}

declare interface UpdateVerticesAction {
    action: "updateVertices",
    verticesToUpdate: { id: string; label: string }[];
}

declare interface AddVerticesAction {
    action: "addVertices";
    vertices: { label: string }[];
}

declare interface GetVerticesAction {
    action: "getVertices";
}

declare interface LinkSelectedNodeWithDataAction {
    action: "linkSelectedNodeWithData";
    linkedData: any;
}

declare interface NodeSelectedEvent {
    event: "nodeSelected";
    linkedData: any;
    label: string;
}

declare interface GetVerticesResultEvent {
    event: "getVertices";
    message: GetVerticesAction;
    vertices: { id: string; label: string }[];
}

declare interface UpdateLocalStorage {
    event: "updateLocalStorage";
    newLocalStorage: Record<string, string>;
}

declare interface PluginLoaded {
    event: "pluginLoaded";
    pluginId: string;
}

// Liveshare 

declare interface CursorChangedEvent {
    event: "cursorChanged";
    position: { x: number, y: number } | undefined;
}

declare interface SelectionChangedEvent {
    event: "selectedCellsChanged";
    selectedCellIds: string[];
}

declare interface SelectionRectangleChangedEvent {
    event: "selectedRectangleChanged";
    rect: Rectangle | undefined;
}

declare interface Rectangle {
    start: { x: number, y: number },
    end: { x: number, y: number },
}

declare interface UpdateLiveshareViewState {
    action: "updateLiveshareViewState";
    cursors: ParticipantCursorInfo[];
    selectedCells: ParticipantSelectedCellsInfo[];
    selectedRectangles: ParticipantSelectedRectangleInfo[];
}

declare interface ParticipantCursorInfo {
    id: string;
    position: { x: number, y: number };
    label: string | undefined;
    color: string;
}

declare interface ParticipantSelectedCellsInfo {
    id: string;
    color: string;
    selectedCellIds: string[];
}

declare interface ParticipantSelectedRectangleInfo {
    id: string;
    color: string;
    rectangle: Rectangle;
}

// ---------------------------------------------------------------------------
// Review: AI edits are applied but stay pending until the user accepts them
// ---------------------------------------------------------------------------

declare interface AiChange {
    id: string;
    change: "added" | "removed" | "changed";
    cellKind: "vertex" | "edge" | "layer";
    label: string;
    /** For changed cells: which aspects differ from before the AI touched them. */
    fields?: ("label" | "style" | "geometry" | "parent" | "connection" | "visible")[];
    /** Name of the page the change is on, when that is not the page shown in the editor. */
    page?: string;
}

/** A change the AI made to the page list (drawio_pages). */
declare interface AiPageChange {
    change: "added" | "renamed" | "moved";
    /** Page id. */
    page: string;
    name: string;
    /** renamed: the name before. */
    from?: string;
}

declare interface AiReviewSummary {
    added: number;
    changed: number;
    removed: number;
    /** Pending page changes (added, renamed or moved pages); omitted when there are none. */
    pages?: number;
}

/** Sent whenever the set of pending AI changes changes; empty when nothing is pending. */
declare interface AiReviewEvent {
    event: "aiReview";
    pending: boolean;
    summary: AiReviewSummary;
    /** Changes on every page; those on other pages than the one shown name their page. */
    changes: AiChange[];
    pageChanges?: AiPageChange[];
    /** How the last review ended, if it just ended. */
    resolved?: "accepted" | "rejected" | "mixed";
}

/** Accept (keep) or reject (revert) pending AI changes: these cells on the page shown, or every change on every page (and the AI's page changes) when cellIds is omitted. */
declare interface AiResolveReviewAction {
    action: "aiResolveReview";
    decision: "accept" | "reject";
    cellIds?: string[];
}
