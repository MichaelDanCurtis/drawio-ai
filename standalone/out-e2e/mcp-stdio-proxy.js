"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target2) => (target2 = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target2, "default", { value: mod, enumerable: true }) : target2,
  mod
));

// src/proxy/mcp-stdio-proxy.ts
var fs = __toESM(require("fs"));
var http = __toESM(require("http"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var readline = __toESM(require("readline"));
var desktop = process.argv.includes("--desktop");
function target() {
  if (!desktop) return { url: new URL(process.argv[2] ?? ""), token: process.env.DRAWAI_MCP_TOKEN ?? "" };
  const file = path.join(process.env.DRAWIO_AI_HOME || path.join(os.homedir(), ".drawio-ai"), "desktop.json");
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("OmniDraw is not running. Open it, then try again");
  }
  return { url: new URL(info.url), token: String(info.token ?? "") };
}
function post(body) {
  return new Promise((resolve, reject) => {
    let url;
    let token;
    try {
      ({ url, token } = target());
    } catch (e) {
      return reject(e);
    }
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
          "x-drawio-ai-client": desktop ? "desktop-stdio" : "acp-stdio"
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}
var pending = Promise.resolve();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  pending = pending.then(async () => {
    let id = null;
    try {
      id = JSON.parse(line)?.id ?? null;
    } catch {
    }
    try {
      const answer = await post(line);
      if (answer.trim()) process.stdout.write(answer.trim().replace(/\n/g, " ") + "\n");
    } catch (e) {
      if (id !== null) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: `OmniDraw is not reachable: ${e?.message ?? e}` } }) + "\n");
      }
    }
  });
});
