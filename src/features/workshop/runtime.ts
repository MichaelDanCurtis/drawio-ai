/**
 * The Shape Workshop itself is the desktop app's code, used as it is
 * (standalone/src/main/workshop without its Electron window): the gallery service (indexes
 * and shapes cached in a folder, search, collections), its guarded downloads, and the page's
 * other half.
 *
 * Imported with `await import("./runtime")`: nothing of it runs until a gallery is on or the
 * Workshop is opened.
 */
export { WorkshopCore } from "../../../standalone/src/main/workshop/core";
export { workshopFetch } from "../../../standalone/src/main/workshop/fetch";
export { GalleryService } from "../../../standalone/src/main/workshop/galleries";
export { galleryPalette, searchForEditor } from "../../../standalone/src/main/workshop/palette";
