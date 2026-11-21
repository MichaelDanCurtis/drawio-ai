import type { DiagramImportFormat } from "../../../src/DrawioClient/CustomizedDrawioClient";

// Which of draw.io's converters reads a file. Same rules as the extension's
// src/features/importDiagram.ts (detectImportFormat), which needs VS Code.

export const VISIO_EXTENSIONS = ["vsdx", "vsd", "vssx", "vss", "vstx", "vst"];
export const IMPORT_FILTERS = [
	{ name: "Diagrams from other tools", extensions: [...VISIO_EXTENSIONS, "gliffy", "graphml", "json"] },
	{ name: "Microsoft Visio", extensions: VISIO_EXTENSIONS },
	{ name: "Gliffy", extensions: ["gliffy"] },
	{ name: "yEd / GraphML", extensions: ["graphml", "xml"] },
	{ name: "Lucidchart / Miro (.json)", extensions: ["json"] },
];

const COMPOUND_FILE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);

export function detectImportFormat(fileName: string, bytes: Uint8Array): Exclude<DiagramImportFormat, "csv"> {
	const ext = (/\.([^./\\]+)$/.exec(fileName)?.[1] ?? "").toLowerCase();
	if (VISIO_EXTENSIONS.includes(ext)) {
		if (startsWith(bytes, [0x50, 0x4b]) || startsWith(bytes, COMPOUND_FILE)) return "visio";
		throw new Error(`${fileName} is not a Visio file.`);
	}
	const head = new TextDecoder().decode(bytes.subarray(0, 65536)).replace(/^﻿/, "").trimStart();
	if (ext === "gliffy" || /"contentType"\s*:\s*"application\/gliffy\+json"/.test(head)) return "gliffy";
	if (ext === "graphml" || /<graphml[\s>]/.test(head)) return "graphml";
	if (/^\{\s*"(state|Properties|Pages|Page)"\s*:/.test(head)) return "lucidchart";
	if (/^\{\s*"isProtected"\s*:/.test(head)) return "miro";
	throw new Error(
		`${fileName} is not a file draw.io can convert. It reads Microsoft Visio (.vsdx, .vsd, .vssx, .vstx), Gliffy (.gliffy), yEd/GraphML (.graphml), and Lucidchart and Miro (.json) files.`
	);
}
