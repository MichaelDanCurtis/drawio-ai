// A GitHub repository where a map takes a folder: what is read as one, and how it is downloaded.
// Nothing here reaches GitHub: the "remote" is a repository made in a temporary folder.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
require("./helpers/ts");
const { parseRepository, repositoryLabel, fetchRepository, hasProgram } = require("../src/main/mapper/repository");
const { withRepositories, FOLDER_FIELD } = require("../src/main/mapper/recipes/common");
const { recipeById } = require("../src/main/mapper/registry");
const { MapperError } = require("../src/main/mapper/types");

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `omnidraw-${name}-`));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
const put = (root, rel, text) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
};

/** A repository with a workflow, a service in a sub-folder, a link out of it, and a second branch. */
function remote() {
	const dir = tmp("remote");
	git(dir, "init", "-q");
	put(dir, ".github/workflows/ci.yml", "name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n  deploy:\n    needs: build\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./deploy.sh\n");
	put(dir, "services/api/package.json", '{"name":"api"}');
	put(dir, "README.md", "main\n");
	fs.symlinkSync("/etc/hosts", path.join(dir, "outside"));
	// (what would make git run a program, were it allowed to: a filter named in the repository, and a submodule)
	put(dir, ".gitattributes", "*.bin filter=lfs\n");
	put(dir, "big.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:0\nsize 1\n");
	put(dir, ".gitmodules", '[submodule "dep"]\n\tpath = dep\n\turl = ext::sh -c "touch /tmp/omnidraw-should-never-exist"\n');
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "first");
	git(dir, "checkout", "-q", "-b", "feature/x");
	put(dir, "README.md", "feature\n");
	git(dir, "commit", "-q", "-am", "on the branch");
	git(dir, "tag", "v1");
	git(dir, "checkout", "-q", "main");
	return dir;
}

test("what is read as a GitHub repository: its address in the browser, its clone addresses, owner/name; and what is not", () => {
	const of = (t) => { const s = parseRepository(t); return s ? repositoryLabel(s) : undefined; };
	assert.equal(of("https://github.com/octo/widgets"), "github.com/octo/widgets");
	assert.equal(of("https://github.com/octo/widgets.git"), "github.com/octo/widgets");
	assert.equal(of("github.com/octo/widgets/"), "github.com/octo/widgets");
	assert.equal(of("http://www.github.com/octo/widgets?tab=readme-ov-file"), "github.com/octo/widgets");
	assert.equal(of("git@github.com:octo/widgets.git"), "github.com/octo/widgets");
	assert.equal(of("ssh://git@github.com/octo/widgets.git"), "github.com/octo/widgets");
	assert.equal(of("octo/widgets"), "github.com/octo/widgets");
	assert.equal(of("  octo/widgets  "), "github.com/octo/widgets");
	// a branch, a tag or a commit; and a folder in it, from the address of that folder's page
	assert.equal(of("octo/widgets@release/2.x"), "github.com/octo/widgets@release/2.x");
	assert.equal(of("octo/widgets#v1.2.0"), "github.com/octo/widgets@v1.2.0");
	assert.equal(of("https://github.com/octo/widgets/tree/main"), "github.com/octo/widgets@main");
	assert.equal(of("https://github.com/octo/widgets/tree/main/services/api"), "github.com/octo/widgets@main/services/api");
	assert.equal(of("https://github.com/octo/widgets/blob/main/services/api/app.ts"), "github.com/octo/widgets@main/services/api");
	assert.deepEqual(parseRepository("https://github.com/octo/widgets/tree/main/services/my%20api"), { host: "github.com", owner: "octo", repo: "widgets", ref: "main", subpath: "services/my api" });
	// pages of a repository that are not places in it
	assert.equal(of("https://github.com/octo/widgets/actions"), "github.com/octo/widgets");
	assert.equal(of("https://github.com/octo/widgets/pull/12"), "github.com/octo/widgets");

	// not a repository: other sites, paths, and anything git could take for an option or a place outside
	for (const no of ["", "widgets", "/Users/me/code/widgets", "./octo/widgets", "~/octo/widgets", "../octo/widgets", "https://gitlab.com/octo/widgets", "https://github.com/octo", "octo/widgets/extra", "octo/wid gets", "-o/--upload-pack=x", "octo/--upload-pack=touch", "octo/widgets@--upload-pack=x", "octo/widgets@a..b", "octo/widgets@x.lock", "octo/..", "https://github.com/octo/widgets/tree/main/../../etc", "https://evil.example/github.com/octo/widgets", "o".repeat(700)]) {
		assert.equal(parseRepository(no), undefined, no);
	}
});

test("a repository is downloaded as it is now, into the app's folder, and nothing of it runs: no hook, filter, submodule or link", async () => {
	const origin = remote();
	const cacheDir = tmp("cache");
	const said = [];
	const o = { cacheDir, env: process.env, progress: (t) => said.push(t), remotes: () => [{ url: origin, how: "a local copy" }] };
	const spec = parseRepository("octo/Widgets");

	const got = await fetchRepository(spec, o);
	const repoDir = path.join(cacheDir, "github.com", "octo", "widgets");
	assert.match(got.head, /^[0-9a-f]{40}$/);
	assert.equal(got.head, git(origin, "rev-parse", "main").trim());
	// (a folder of that one commit)
	assert.equal(got.dir, path.join(repoDir, got.head.slice(0, 12)));
	assert.equal(got.root, got.dir);
	assert.deepEqual(said, ["Downloading github.com/octo/Widgets…"]);
	assert.equal(fs.readFileSync(path.join(got.dir, "README.md"), "utf8"), "main\n");
	assert.ok(fs.existsSync(path.join(got.dir, ".github/workflows/ci.yml")));
	// the newest state only
	assert.equal(git(got.dir, "rev-list", "--count", "HEAD").trim(), "1");
	// a link in the repository is a small file here, not a way out of the folder
	assert.equal(fs.lstatSync(path.join(got.dir, "outside")).isSymbolicLink(), false);
	assert.equal(fs.readFileSync(path.join(got.dir, "outside"), "utf8"), "/etc/hosts");
	// the file a filter would have fetched is as it is in the repository; the submodule was not looked at
	assert.match(fs.readFileSync(path.join(got.dir, "big.bin"), "utf8"), /^version https:\/\/git-lfs/);
	assert.equal(fs.existsSync(path.join(got.dir, "dep", ".git")), false);
	assert.equal(fs.existsSync("/tmp/omnidraw-should-never-exist"), false);
	assert.equal(fs.existsSync(path.join(got.dir, ".git", "hooks")), false, "no hooks were put in");

	// another branch: a folder of its own, and the first map's files are still what they were
	const branch = await fetchRepository({ ...spec, ref: "feature/x" }, o);
	assert.notEqual(branch.dir, got.dir);
	assert.equal(fs.readFileSync(path.join(branch.dir, "README.md"), "utf8"), "feature\n");
	assert.equal(fs.readFileSync(path.join(got.dir, "README.md"), "utf8"), "main\n", "a map drawn from main still points at main's files");
	// a tag of that same commit, and the first branch again: the folders that are there are used, not replaced
	fs.writeFileSync(path.join(branch.dir, "kept"), "the same folder");
	assert.equal((await fetchRepository({ ...spec, ref: "v1" }, o)).dir, branch.dir);
	assert.ok(fs.existsSync(path.join(branch.dir, "kept")));
	// a folder inside
	const inside = await fetchRepository({ ...spec, subpath: "services/api" }, o);
	assert.equal(inside.dir, got.dir);
	assert.equal(inside.root, path.join(got.dir, "services", "api"));
	assert.deepEqual(fs.readdirSync(repoDir).sort(), [got.dir, branch.dir].map((d) => path.basename(d)).sort(), "one folder per commit, and nothing half-made beside them");

	// what is not there says so, and leaves the copies from before
	await assert.rejects(fetchRepository({ ...spec, ref: "nope" }, o), (e) => e instanceof MapperError && e.message === "octo/Widgets has no branch, tag or commit called nope.");
	await assert.rejects(fetchRepository({ ...spec, subpath: "no/such" }, o), /octo\/Widgets has no folder no\/such\./);
	assert.equal(fs.readdirSync(repoDir).length, 2);
	assert.deepEqual(fs.readdirSync(path.join(cacheDir, "github.com", "octo")), ["widgets"]);
});

test("downloads of a repository: the newest few commits are kept, and one in use is never taken away", async () => {
	const origin = remote();
	const cacheDir = tmp("cache");
	const o = { cacheDir, env: process.env, remotes: () => [{ url: origin, how: "a local copy" }] };
	const spec = parseRepository("octo/widgets");
	const repoDir = path.join(cacheDir, "github.com", "octo", "widgets");
	const dirs = [];
	for (let i = 0; i < 6; i++) {
		put(origin, "README.md", `commit ${i}\n`);
		git(origin, "commit", "-q", "-am", `commit ${i}`);
		dirs.push((await fetchRepository(spec, o)).dir);
	}
	// (all six were used a moment ago: a map of any of them may still be read)
	assert.equal(fs.readdirSync(repoDir).length, 6);
	// hours later: the oldest go when the next commit is downloaded, the newest four stay
	const longAgo = (n) => new Date(Date.now() - (10 - n) * 3600_000);
	dirs.forEach((d, i) => fs.utimesSync(d, longAgo(i), longAgo(i)));
	fs.mkdirSync(path.join(repoDir, ".new-0badc0de"));
	fs.utimesSync(path.join(repoDir, ".new-0badc0de"), longAgo(0), longAgo(0));
	put(origin, "README.md", "commit 6\n");
	git(origin, "commit", "-q", "-am", "commit 6");
	const newest = await fetchRepository(spec, o);
	assert.deepEqual(fs.readdirSync(repoDir).sort(), [dirs[3], dirs[4], dirs[5], newest.dir].map((d) => path.basename(d)).sort());
	assert.equal(fs.readFileSync(path.join(dirs[3], "README.md"), "utf8"), "commit 3\n");
	// a commit downloaded before is used again, and counts as used now
	git(origin, "reset", "-q", "--hard", "HEAD~3");
	const again = await fetchRepository(spec, o);
	assert.equal(again.dir, dirs[3]);
	assert.ok(Date.now() - fs.statSync(dirs[3]).mtimeMs < 60_000);
});

test("the GitHub CLI is found on Windows too, where a program has an ending", () => {
	const bin = tmp("bin");
	fs.writeFileSync(path.join(bin, "gh.exe"), "");
	assert.equal(hasProgram("gh", { PATH: `C:\\nowhere;${bin}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32"), true);
	assert.equal(hasProgram("gh", { Path: bin }, "win32"), true, "Windows calls it Path, and has endings of its own when PATHEXT is not set");
	assert.equal(hasProgram("git-lfs", { PATH: bin, PATHEXT: ".EXE" }, "win32"), false);
	const unix = tmp("bin");
	fs.writeFileSync(path.join(unix, "gh"), "");
	assert.equal(hasProgram("gh", { PATH: `/nowhere${path.delimiter}${unix}` }), true);
	assert.equal(hasProgram("gh", { PATH: "" }), false);
});

test("a filter this computer's git knows is not run on a downloaded repository's files, whatever it is called and wherever git has it from", async () => {
	// The repository names the filters in its .gitattributes; the programs are in the user's own git
	// settings (as Git LFS is, and git-crypt, and whatever else they have installed). Fetching needs
	// those settings for the sign-in, so they cannot simply be left out.
	const origin = tmp("remote");
	git(origin, "init", "-q");
	put(origin, ".gitattributes", "*.one filter=one\n*.two filter=two\n*.three filter=three\nsub/* filter=one\n*.txt text eol=crlf ident\n");
	for (const f of ["a.one", "b.two", "c.three", "sub/d.dat"]) put(origin, f, "as committed\n");
	put(origin, "e.txt", "$Id$ one\ntwo\n");
	git(origin, "add", "-A");
	git(origin, "commit", "-q", "-m", "first");

	const marks = tmp("marks");
	const smudge = (name) => `sh -c 'touch "${path.join(marks, name)}"; echo changed by a filter'`;
	const settings = tmp("settings");
	// (from the user's own settings file, from the computer's, and from the environment)
	execFileSync("git", ["config", "--file", path.join(settings, "global"), "filter.one.smudge", smudge("one")]);
	execFileSync("git", ["config", "--file", path.join(settings, "global"), "filter.one.required", "true"]);
	execFileSync("git", ["config", "--file", path.join(settings, "system"), "filter.two.smudge", smudge("two")]);
	const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(settings, "global"), GIT_CONFIG_SYSTEM: path.join(settings, "system"), GIT_CONFIG_NOSYSTEM: "", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.three.smudge", GIT_CONFIG_VALUE_0: smudge("three") };
	// (the filters do run in an ordinary checkout with these settings: this is what is being kept out)
	const plain = tmp("plain");
	execFileSync("git", ["clone", "-q", origin, plain], { env, stdio: "ignore" });
	assert.deepEqual(fs.readdirSync(marks).sort(), ["one", "three", "two"]);
	for (const m of fs.readdirSync(marks)) fs.rmSync(path.join(marks, m));

	const got = await fetchRepository(parseRepository("octo/filters"), { cacheDir: tmp("cache"), env, remotes: () => [{ url: origin, how: "a local copy" }] });
	assert.deepEqual(fs.readdirSync(marks), [], "no filter ran");
	for (const f of ["a.one", "b.two", "c.three", "sub/d.dat"]) assert.equal(fs.readFileSync(path.join(got.dir, f), "utf8"), "as committed\n", f);
	// (and the files are as they are in the repository: no line endings or keywords rewritten on the way)
	assert.equal(fs.readFileSync(path.join(got.dir, "e.txt"), "utf8"), "$Id$ one\ntwo\n");
});

test("the ways of signing in are tried one after the other; when none works it says what each said, never asks, and leaves nothing behind", async () => {
	const origin = remote();
	const cacheDir = tmp("cache");
	const spec = parseRepository("octo/widgets");
	const gone = path.join(tmp("gone"), "nothing-here");
	const second = await fetchRepository(spec, { cacheDir, env: process.env, remotes: () => [{ url: gone, how: "git's saved sign-in" }, { url: origin, how: "the GitHub CLI's sign-in" }] });
	assert.ok(fs.existsSync(path.join(second.dir, "README.md")));

	const empty = tmp("cache");
	await assert.rejects(
		fetchRepository(spec, { cacheDir: empty, env: process.env, remotes: () => [{ url: gone, how: "git's saved sign-in" }, { url: `${gone}2`, how: "an SSH key" }] }),
		(e) => e instanceof MapperError && /^Could not download octo\/widgets from GitHub\.\n- With git's saved sign-in: .+\n- With an SSH key: .+$/.test(e.message) && /gh auth login/.test(e.hint) && /choose its folder/.test(e.hint)
	);
	assert.deepEqual(fs.readdirSync(path.join(empty, "github.com", "octo")), [], "no half-made folder is left");

	// stopped: nothing more is tried
	const stop = new AbortController();
	stop.abort();
	await assert.rejects(fetchRepository(spec, { cacheDir: empty, env: process.env, signal: stop.signal, remotes: () => [{ url: origin, how: "a local copy" }] }), /Cancelled/);
});

test("a map of a repository: the recipe reads the downloaded folder, a folder of that name on this computer wins, and a program that keeps no repositories says so", async () => {
	const origin = remote();
	const cacheDir = tmp("cache");
	const cwd = tmp("diagram");
	const asked = [];
	const ctx = {
		cwd,
		signal: new AbortController().signal,
		progress() {},
		exec: async () => ({ stdout: "", stderr: "", code: 1 }),
		repository: (spec) => (asked.push(repositoryLabel(spec)), fetchRepository(spec, { cacheDir, env: process.env, remotes: () => [{ url: origin, how: "a local copy" }] })),
	};
	const recipe = recipeById("software.github-actions");
	assert.equal(recipe.fields.find((f) => f.id === "folder").repository, true);
	assert.match(FOLDER_FIELD.placeholder, /GitHub repository/);

	const from = await withRepositories(recipe.fields, { folder: "https://github.com/octo/widgets/tree/main" }, ctx);
	const copy = path.join(cacheDir, "github.com", "octo", "widgets", git(origin, "rev-parse", "main").trim().slice(0, 12));
	assert.deepEqual([from.source, from.root, from.input.folder], ["github.com/octo/widgets@main", copy, copy]);
	const result = await recipe.collect(from.input, ctx);
	assert.equal(result.summary, "1 workflow(s), 2 job(s)");
	assert.ok(result.graph.nodes.some((n) => n.kind === "gha:job" && /deploy/.test(n.label)));

	// every map that takes a repository or folder takes one this way
	for (const id of ["software.connectivity", "software.dataflow", "software.modules", "software.classes", "software.api", "software.github-actions"]) {
		const r = recipeById(id);
		assert.ok(r, id);
		assert.equal(r.fields.find((f) => f.id === "folder")?.repository, true, id);
	}

	// a folder is a folder: one that is there is not asked for on GitHub, typed whole or from the diagram's folder
	asked.length = 0;
	fs.mkdirSync(path.join(cwd, "octo", "widgets"), { recursive: true });
	assert.deepEqual(await withRepositories(recipe.fields, { folder: "octo/widgets" }, ctx), { input: { folder: "octo/widgets" } });
	assert.deepEqual(await withRepositories(recipe.fields, { folder: cwd }, ctx), { input: { folder: cwd } });
	assert.deepEqual(await withRepositories(recipe.fields, { folder: "" }, ctx), { input: { folder: "" } });
	assert.deepEqual(asked, []);

	// neither a folder nor a repository; and a repository where none can be downloaded
	await assert.rejects(withRepositories(recipe.fields, { folder: "/no/such/folder" }, ctx), /is not a folder on this computer, and not a GitHub repository/);
	await assert.rejects(withRepositories(recipe.fields, { folder: "octo/other" }, { ...ctx, repository: undefined }), /repositories cannot be downloaded here\. Clone it and choose its folder\./);
	// a field that does not take a repository is left as it is
	assert.deepEqual(await withRepositories([{ id: "folder", label: "Model folder", type: "folder" }], { folder: "octo/other" }, ctx), { input: { folder: "octo/other" } });
});
