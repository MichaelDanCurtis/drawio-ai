import * as fs from "fs";
import * as path from "path";

/**
 * A short record of when the app started and how it ended, kept in its data folder
 * (`logs/app.log`). An app that is gone without a word leaves no way to tell a crash from a
 * quit: this says which, and why where the system says so. It holds times, reasons and the
 * first line of an error; never a diagram, a request, a key or what a tool answered.
 */

const MAX_BYTES = 256 * 1024;
const MAX_LINE = 600;

/** One line, as it is written: the time, what happened, and a few details. */
export function logLine(what: string, details: Record<string, unknown> = {}, at = new Date()): string {
	const parts = Object.entries(details)
		.filter(([, v]) => v !== undefined && v !== null && v !== "")
		.map(([k, v]) => `${k}=${String(v).replace(/\s+/g, " ").trim()}`);
	const line = [at.toISOString(), what, ...parts].join(" ");
	return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** What an error is called and says, without its stack beyond where it was thrown. */
export function errorDetails(e: unknown): { error: string; at?: string } {
	const err = e instanceof Error ? e : new Error(String(e));
	const where = (err.stack ?? "").split("\n").find((l) => /^\s+at /.test(l));
	return { error: `${err.name}: ${err.message.split("\n")[0]}`, ...(where ? { at: where.trim().replace(/^at /, "") } : {}) };
}

export class RunLog {
	private ended = false;
	private running = false;

	constructor(private readonly file: string) {}

	/** Appends a line. A log that cannot be written is never a reason for the app to fail. */
	public write(what: string, details: Record<string, unknown> = {}): void {
		// (a process that never became the running copy has nothing to say in the running one's log)
		if (!this.running && what !== "started" && !what.startsWith("the run before")) return;
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// (kept small: when it has grown, the older half goes)
			try {
				if (fs.statSync(this.file).size > MAX_BYTES) {
					const text = fs.readFileSync(this.file, "utf8");
					const half = text.slice(text.length - MAX_BYTES / 2);
					fs.writeFileSync(this.file, half.slice(half.indexOf("\n") + 1));
				}
			} catch {
				// no file yet
			}
			fs.appendFileSync(this.file, `${logLine(what, details)}\n`);
		} catch {
			// not logged
		}
	}

	/**
	 * The app started. If the run before this one left no word of its end (it crashed, was
	 * killed, or the machine went down), that is said first: it is the only trace such an end leaves.
	 */
	public started(details: Record<string, unknown>): void {
		const last = this.lastRun();
		if (last && !last.ended) this.write("the run before this one ended without a word (crashed or was killed)", { started: last.started, pid: last.pid });
		this.write("started", details);
		this.running = true;
	}

	/** The app is ending by its own doing (a quit); written once. */
	public end(why: string, details: Record<string, unknown> = {}): void {
		if (this.ended || !this.running) return;
		this.ended = true;
		this.write("ended", { why, ...details });
	}

	private lastRun(): { started: string; pid?: string; ended: boolean } | undefined {
		let lines: string[];
		try {
			lines = fs.readFileSync(this.file, "utf8").split("\n");
		} catch {
			return undefined;
		}
		for (let i = lines.length - 1; i >= 0; i--) {
			const m = /^(\S+) started\b(.*)$/.exec(lines[i]);
			if (!m) continue;
			const pid = / pid=(\d+)/.exec(m[2])?.[1];
			return { started: m[1], pid, ended: lines.slice(i + 1).some((l) => new RegExp(`^\\S+ ended\\b.* pid=${pid ?? ""}\\b`).test(l)) };
		}
		return undefined;
	}
}
