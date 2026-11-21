import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { paths } from "./paths";
// The page the extension shows in its webview, used unchanged (read-only import).
import webviewHtml from "../../../src/DrawioClient/webview-content.html";

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".gif": "image/gif",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".xml": "application/xml",
	".txt": "text/plain",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json",
};

export interface EditorPageOptions {
	dark: boolean | "auto";
	localStorage: Record<string, string>;
}

/**
 * Serves the bundled draw.io webapp, the Draw.AI plugin and the editor page on
 * 127.0.0.1 (draw.io expects an http(s) origin). Read-only static files only.
 */
export class StaticServer {
	private server: http.Server | undefined;
	public base = "";
	private pages = new Map<string, EditorPageOptions>();

	public async start(): Promise<void> {
		this.server = http.createServer((req, res) => this.handle(req, res));
		await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
		this.base = `http://127.0.0.1:${(this.server.address() as any).port}`;
	}

	/** URL of an editor page for one window. */
	public editorUrl(id: string, options: EditorPageOptions): string {
		this.pages.set(id, options);
		return `${this.base}/editor/${id}.html`;
	}

	private editorHtml(o: EditorPageOptions): string {
		const base = this.base;
		return (webviewHtml as string)
			.replace(/\$\$literal-vsuri\$\$/g, `${base}/webapp`)
			.replace("$$theme$$", JSON.stringify("kennedy"))
			.replace("$$appearance$$", JSON.stringify("0"))
			.replace("$$dark$$", JSON.stringify(o.dark === "auto" ? "auto" : o.dark ? "1" : "0"))
			.replace("$$lang$$", JSON.stringify("en"))
			.replace("$$simpleLabels$$", "false")
			.replace("$$chrome$$", JSON.stringify("1"))
			.replace("$$customPluginPaths$$", JSON.stringify([`${base}/plugin/drawio-plugin.js`, `${base}/plugin/desktop-menu.js`]))
			.replace("$$localStorage$$", JSON.stringify(o.localStorage))
			.replace("$$additionalCode$$", "[]");
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://x");
		const p = decodeURIComponent(url.pathname);
		const page = /^\/editor\/([\w-]+)\.html$/.exec(p);
		if (page) {
			const o = this.pages.get(page[1]);
			if (!o) return void res.writeHead(404).end();
			res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
			return void res.end(this.editorHtml(o));
		}
		if (p === "/chat.html" || p === "/mapper.html") {
			const nonce = crypto.randomBytes(16).toString("hex");
			const html = fs
				.readFileSync(path.join(paths.out, p.slice(1)), "utf8")
				.replace(/\$\$nonce\$\$/g, nonce)
				.replace(/\$\$cspSource\$\$/g, this.base);
			res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
			return void res.end(html);
		}
		let file: string | undefined;
		if (["/plugin/drawio-plugin.js", "/plugin/drawio-plugin.js.map", "/plugin/desktop-menu.js"].includes(p)) {
			file = path.join(paths.out, path.basename(p));
		} else if (p.startsWith("/webapp/")) {
			file = path.join(paths.webapp, p.slice("/webapp/".length));
			if (!file.startsWith(paths.webapp + path.sep)) return void res.writeHead(403).end();
		}
		if (!file) return void res.writeHead(404).end();
		fs.stat(file, (err, st) => {
			if (err || !st.isFile()) return void res.writeHead(404).end();
			res.writeHead(200, { "content-type": MIME[path.extname(file!).toLowerCase()] ?? "application/octet-stream", "content-length": st.size });
			fs.createReadStream(file!).pipe(res);
		});
	}

	public dispose(): void {
		this.server?.close();
	}
}
