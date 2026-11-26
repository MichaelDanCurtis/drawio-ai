// A GitHub repository where a map takes a folder: what is read as one, and how it is downloaded.
// Nothing here reaches GitHub: the "remote" is a repository made in a temporary folder.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
require("./helpers/ts");
const { parseRepository, repositoryLabel, fetchRepository } = require("../src/main/mapper/repository");
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
	assert.equal(got.dir, path.join(cacheDir, "github.com", "octo", "widgets"));
	assert.equal(got.root, got.dir);
	assert.match(got.head, /^[0-9a-f]{40}$/);
	assert.equal(got.head, git(origin, "rev-parse", "main").trim());
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

	// another branch, a tag, a commit; a folder inside
	assert.equal(fs.readFileSync(path.join((await fetchRepository({ ...spec, ref: "feature/x" }, o)).dir, "README.md"), "utf8"), "feature\n");
	assert.equal(fs.readFileSync(path.join((await fetchRepository({ ...spec, ref: "v1" }, o)).dir, "README.md"), "utf8"), "feature\n");
	const inside = await fetchRepository({ ...spec, subpath: "services/api" }, o);
	assert.equal(inside.root, path.join(inside.dir, "services", "api"));
	// (what was fetched before is replaced: a map is of the repository as it is now, and nothing is left beside it)
	assert.equal(fs.readFileSync(path.join(inside.dir, "README.md"), "utf8"), "main\n");
	assert.deepEqual(fs.readdirSync(path.join(cacheDir, "github.com", "octo")), ["widgets"]);

	// what is not there says so, and leaves the copy from before
	await assert.rejects(fetchRepository({ ...spec, ref: "nope" }, o), (e) => e instanceof MapperError && e.message === "octo/Widgets has no branch, tag or commit called nope.");
	await assert.rejects(fetchRepository({ ...spec, subpath: "no/such" }, o), /octo\/Widgets has no folder no\/such\./);
	assert.deepEqual(fs.readdirSync(path.join(cacheDir, "github.com", "octo")), ["widgets"]);
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
	assert.deepEqual([from.source, from.root, from.input.folder], ["github.com/octo/widgets@main", path.join(cacheDir, "github.com", "octo", "widgets"), path.join(cacheDir, "github.com", "octo", "widgets")]);
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
