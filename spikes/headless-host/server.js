// Loopback-only static server for the headless draw.io page (spike).
const http = require("http");
const fs = require("fs");
const path = require("path");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".gif": "image/gif", ".xml": "application/xml", ".txt": "text/plain", ".woff": "font/woff", ".woff2": "font/woff2" };

class HeadlessServer {
	static async start(root) {
		const s = new HeadlessServer(root);
		await new Promise((r) => s.server.listen(0, "127.0.0.1", r));
		s.base = `http://127.0.0.1:${s.server.address().port}`;
		return s;
	}

	constructor(root) {
		this.webapp = path.join(root, "drawio/src/main/webapp");
		this.plugin = path.join(root, "dist/custom-drawio-plugins/index.js");
		this.html = fs.readFileSync(path.join(root, "src/DrawioClient/webview-content.html"), "utf8");
		this.server = http.createServer((req, res) => this.handle(req, res));
	}

	editorHtml() {
		const shim = `<script>window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(typeof m === "string" ? m : JSON.stringify(m)) });</script>`;
		return this.html
			.replace("<head>", "<head>" + shim)
			.replace(/\$\$literal-vsuri\$\$/g, `${this.base}/webapp`)
			.replace("$$theme$$", JSON.stringify("kennedy"))
			.replace("$$appearance$$", JSON.stringify("0"))
			.replace("$$dark$$", JSON.stringify("0"))
			.replace("$$lang$$", JSON.stringify("en"))
			.replace("$$simpleLabels$$", "false")
			.replace("$$chrome$$", JSON.stringify("1"))
			.replace("$$customPluginPaths$$", JSON.stringify([`${this.base}/plugin.js`]))
			.replace("$$localStorage$$", "{}")
			.replace("$$additionalCode$$", "[]");
	}

	handle(req, res) {
		const url = new URL(req.url, "http://x");
		let file;
		if (url.pathname === "/editor.html") {
			res.writeHead(200, { "content-type": "text/html" });
			return res.end(this.editorHtml());
		} else if (url.pathname === "/plugin.js") {
			file = this.plugin;
		} else if (url.pathname.startsWith("/webapp/")) {
			file = path.join(this.webapp, decodeURIComponent(url.pathname.slice("/webapp/".length)));
			if (!file.startsWith(this.webapp + path.sep)) {
				res.writeHead(403);
				return res.end();
			}
		}
		if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404);
			return res.end();
		}
		res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
		fs.createReadStream(file).pipe(res);
	}

	close() {
		return new Promise((r) => this.server.close(r));
	}
}

module.exports = { HeadlessServer };
