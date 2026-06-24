import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHighlighter } from "shiki";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findPiPackageRoot() {
	const candidates = [
		process.env.PI_CODING_AGENT_ROOT,
		path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
		"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
		"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
		path.join(os.homedir(), ".pi", "scrutiny", "node_modules", "@earendil-works", "pi-coding-agent"),
		path.join(os.homedir(), ".pi", "agent", "npm", "node_modules", "@earendil-works", "pi-coding-agent"),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
	}
	throw new Error(`Could not locate @earendil-works/pi-coding-agent. Set PI_CODING_AGENT_ROOT.`);
}

const piPackageRoot = findPiPackageRoot();
const piNodeModules = path.join(piPackageRoot, "node_modules");
const requireFromPi = createRequire(path.join(piPackageRoot, "package.json"));
const createJiti = requireFromPi("jiti");

const jiti = createJiti(import.meta.url, {
	interopDefault: true,
	moduleCache: false,
	fsCache: false,
	alias: {
		"@earendil-works/pi-coding-agent": path.join(piPackageRoot, "dist", "index.js"),
		"@earendil-works/pi-tui": path.join(piNodeModules, "@earendil-works", "pi-tui", "dist", "index.js"),
		typebox: path.join(piNodeModules, "typebox", "build", "index.mjs"),
	},
});

const { parseUnifiedPatch, renderDiffLines } = await jiti.import(path.join(repoRoot, "src", "diff-view.ts"), { default: false });
const { DEFAULT_CONFIG, ansiFg } = await jiti.import(path.join(repoRoot, "src", "config.ts"), { default: false });
const { normalizeHunkComments, createHunkBridge } = await jiti.import(path.join(repoRoot, "src", "hunk-bridge.ts"), { default: false });
const { createRenderRecordStore } = await jiti.import(path.join(repoRoot, "src", "render-records.ts"), { default: false });
const { writePatch } = await jiti.import(path.join(repoRoot, "src", "diff-view.ts"), { default: false });

function fakeTheme() {
	const colors = {
		accent: "\x1b[38;2;255;190;106m",
		toolTitle: "\x1b[38;2;250;250;250m",
		toolDiffAdded: "\x1b[38;2;80;220;120m",
		toolDiffRemoved: "\x1b[38;2;240;100;100m",
		toolDiffContext: "\x1b[38;2;210;210;210m",
		muted: "\x1b[38;2;160;160;160m",
		dim: "\x1b[38;2;110;110;110m",
		warning: "\x1b[38;2;255;200;80m",
		error: "\x1b[38;2;255;100;100m",
	};
	return {
		name: "unit-dark",
		fg(name, text) {
			return `${colors[name] ?? ""}${text}\x1b[0m`;
		},
		getFgAnsi(name) {
			return colors[name] ?? "";
		},
		bold(text) {
			return `\x1b[1m${text}\x1b[22m`;
		},
	};
}

const fakeHighlighter = {
	codeToTokensBase(code) {
		return code.split("\n").map((line) => [{ content: line, color: "#ffffff" }]);
	},
};

function stripAnsi(value) {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

// --- parseUnifiedPatch: structure, line numbers, kinds ---------------------
const patch = [
	"--- a/a.ts",
	"+++ b/a.ts",
	"@@ -1,3 +1,3 @@",
	" export function greet(name: string) {",
	"-  return `hello ${name}`;",
	"+  return `hi ${name}`;",
	" }",
].join("\n");

const parsed = parseUnifiedPatch(patch);
assert.equal(parsed.oldFile, "a/a.ts");
assert.equal(parsed.newFile, "b/a.ts");
assert.equal(parsed.hunks.length, 1);
const hunk = parsed.hunks[0];
assert.equal(hunk.oldStart, 1);
assert.equal(hunk.newStart, 1);
const kinds = hunk.lines.map((l) => l.kind);
assert.deepEqual(kinds, ["context", "remove", "add", "context"]);
const removeLine = hunk.lines.find((l) => l.kind === "remove");
const addLine = hunk.lines.find((l) => l.kind === "add");
assert.equal(removeLine.oldLine, 2);
assert.equal(addLine.newLine, 2);
// word-level emphasis ranges computed on the paired add/remove block
assert.ok(removeLine.removeRanges && removeLine.removeRanges.length > 0, "remove ranges computed");
assert.ok(addLine.addRanges && addLine.addRanges.length > 0, "add ranges computed");
// the changed word "hello"→"hi" should be emphasized, not the shared "  return `"
const removeEmph = removeLine.removeRanges.find((r) => r.start >= 2);
assert.ok(removeEmph, "emphasized range starts past the shared prefix");

// trailing blank split row must not become a phantom context line
const trailingBlank = parseUnifiedPatch(patch + "\n");
assert.equal(trailingBlank.hunks[0].lines.length, hunk.lines.length, "no phantom trailing line");

// strike word highlighting is side-aware: deletions strike, additions underline
const strikeRender = renderDiffLines({
	patch,
	filePath: "a.ts",
	cwd: repoRoot,
	title: "unit",
	config: { ...DEFAULT_CONFIG, wordHighlight: "strike", lineHighlight: "tint" },
	highlighter: fakeHighlighter,
	theme: fakeTheme(),
	liveSession: false,
});
const removedRendered = strikeRender.find((line) => stripAnsi(line).includes("hello"));
const addedRendered = strikeRender.find((line) => stripAnsi(line).includes("hi"));
assert.match(removedRendered, /\x1b\[1;9m/, "removed words use strikethrough");
assert.doesNotMatch(addedRendered, /\x1b\[1;9m/, "added words are not struck through");
assert.match(addedRendered, /\x1b\[1;4m/, "added words use underline in strike mode");
const tintRepeats = (addedRendered.match(/\x1b\[48;2;26;44;28m/g) ?? []).length;
assert.ok(tintRepeats > 2, "tint background survives token resets across the line");

// --- normalizeHunkComments: shape tolerance, dedup, type filter ------------
const flat = normalizeHunkComments({
	comments: [
		{ id: "c1", type: "user", filePath: "a.ts", newLine: 3, summary: "tighten" },
		{ id: "c1", type: "user", filePath: "a.ts", newLine: 3, summary: "tighten" },
		{ id: "c2", type: "ai", filePath: "a.ts", newLine: 4, summary: "ignored" },
	],
});
assert.equal(flat.length, 1, "dedup + type filter");
assert.equal(flat[0].summary, "tighten");

const nested = normalizeHunkComments({
	files: [{ path: "b.ts", annotations: [{ newRange: [5, 5], summary: "nested", rationale: "why" }] }],
});
assert.equal(nested.length, 1);
assert.equal(nested[0].filePath, "b.ts");
assert.equal(nested[0].newLine, 5);
assert.equal(nested[0].rationale, "why");

const altFields = normalizeHunkComments([{ file: "c.ts", old_line: 7, text: "alt shape", author: { name: "human" } }]);
assert.equal(altFields.length, 1);
assert.equal(altFields[0].filePath, "c.ts");
assert.equal(altFields[0].oldLine, 7);
assert.equal(altFields[0].summary, "alt shape");
assert.equal(altFields[0].author, "human");

// --- whole-hunk grammar state: template-literal continuation line -----------

// A template literal spans two lines. The second line ("   world`;") is a
// context line that lives *inside* the template literal. Per-line tokenization
// loses that context and colors "world" as a bare identifier; whole-hunk
// tokenization colors it as template-string content. This locks in the fix.
{
	const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"] });
	const tsPatch = [
		"--- a/code.ts",
		"+++ b/code.ts",
		"@@ -1,4 +1,4 @@",
		" const a = 1;",
		"-const msg = `hello ${name}",
		"+const msg = `hi ${name}",
		"   world`;",
		" const b = 2;",
	].join("\n");

	// Ground truth: tokenize the full new side and read the "world" token color.
	// Contrast: tokenize the world line in isolation (what per-line rendering does).
	// The fix means the rendered "world" must carry the full-side (template-string)
	// color, NOT the isolated-identifier color.
	const fullNew = ["const a = 1;", "const msg = `hi ${name}", "   world`;", "const b = 2;"].join("\n");
	const fullTokens = highlighter.codeToTokensBase(fullNew, { lang: "typescript", theme: "github-dark" });
	const worldToken = fullTokens[2].find((t) => t.content.includes("world"));
	assert.ok(worldToken, "world token found in full tokenize");
	const expectedAnsi = ansiFg(worldToken.color);
	assert.ok(expectedAnsi, "expected template-string color resolves to ANSI");

	const isoTokens = highlighter.codeToTokensBase("   world`;", { lang: "typescript", theme: "github-dark" });
	const isoWorldToken = isoTokens[0].find((t) => t.content.includes("world"));
	assert.ok(isoWorldToken, "world token found in isolated tokenize");
	const isolatedAnsi = ansiFg(isoWorldToken.color);
	assert.notEqual(expectedAnsi, isolatedAnsi, "fixture is meaningful: full vs isolated world colors differ");

	const rendered = renderDiffLines({
		patch: tsPatch,
		filePath: "code.ts",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "none", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter,
		theme: fakeTheme(),
		liveSession: false,
	});
	const worldLine = rendered.find((line) => stripAnsi(line).includes("world"));
	assert.ok(worldLine, "world continuation line rendered");
	assert.ok(worldLine.includes(expectedAnsi), `continuation line carries template-string color ${expectedAnsi}`);
	assert.ok(!worldLine.includes(isolatedAnsi), `continuation line does not carry isolated-identifier color ${isolatedAnsi}; got: ${JSON.stringify(worldLine)}`);
	await highlighter.dispose();
}

// --- word-emphasis indexing across astral code points (Q4) ------------------

// diffWordsWithSpace emits UTF-16-code-unit ranges; the renderer advances its
// cursor by each code point's UTF-16 length. An astral emoji is 2 units, so a
// range ending at the emoji must NOT bleed emphasis onto the following char.
// This locks that alignment: the emoji is counted as 2, the trailing char as 3.
{
	const emojiPatch = [
		"--- a/e.ts",
		"+++ b/e.ts",
		"@@ -1,1 +1,1 @@",
		"-a c",
		"+a🎉c",
	].join("\n");
	const rendered = renderDiffLines({
		patch: emojiPatch,
		filePath: "e.ts",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "bold", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter: fakeHighlighter,
		theme: fakeTheme(),
		liveSession: false,
	});
	const added = rendered.find((line) => stripAnsi(line).includes("🎉"));
	assert.ok(added, "emoji added line rendered");
	const boldCount = (added.match(/\x1b\[1m/g) ?? []).length;
	assert.equal(boldCount, 1, `exactly the emoji is bold, not the trailing char; got ${boldCount} bold runs in ${JSON.stringify(added)}`);
	assert.ok(added.indexOf("\x1b[1m") < added.indexOf("🎉"), "bold run precedes the emoji, not the trailing char");

	// CJK is BMP (1 unit per char) — the changed char is emphasized, its neighbor is not.
	const cjkPatch = "--- a/c.ts\n+++ b/c.ts\n@@ -1,1 +1,1 @@\n-a c\n+a巴c";
	const cjkRendered = renderDiffLines({
		patch: cjkPatch,
		filePath: "c.ts",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "bold", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter: fakeHighlighter,
		theme: fakeTheme(),
		liveSession: false,
	});
	const cjkAdded = cjkRendered.find((line) => stripAnsi(line).includes("巴"));
	assert.ok(cjkAdded, "cjk added line rendered");
	assert.equal((cjkAdded.match(/\x1b\[1m/g) ?? []).length, 1, "exactly the changed CJK char is bold");
}

// --- I: note-to-edit scoped auto-pickup ------------------------------------

// Auto-pickup must inject only notes that overlap a recent edit by
// (file, line). A note about an untouched file must NOT trigger injection,
// even when the note count meets the threshold. The flat count threshold is a
// fallback, not the primary rule.
//
// The bridge needs recent records to correlate against; the store lives in the
// extension closure. createHunkBridge accepts an optional findRecent(filePath,
// cwd) seam so the bridge can query the store without owning it.
{
	const cwd = repoRoot;
	const store = createRenderRecordStore();
	// A recent edit to src/app.ts that touches new lines 3..5.
	store.record("call-1", {
		tool: "edit",
		filePath: path.join(cwd, "src", "app.ts"),
		patch: writePatch("a/src/app.ts", "b/src/app.ts", "line1\nline2\nold\nold\nold\nline6\n", "line1\nline2\nnewA\nnewB\nnewC\nline6\n"),
		summary: "edited app.ts",
	});

	// findRecent seam: bridge queries by file path, store resolves to the record.
	const findRecent = (filePath) => store.findRecent(filePath, cwd);
	const bridge = createHunkBridge(findRecent);

	// Override readNotes so we don't shell out to hunk; inject a controlled set.
	const notesOnEdit = { id: "n1", type: "user", filePath: "src/app.ts", newLine: 4, summary: "on the edit" };
	const notesOffEdit = { id: "n2", type: "user", filePath: "src/other.ts", newLine: 99, summary: "unrelated" };
	const fakeResult = (comments) => ({ live: true, session: { id: "s" }, comments, message: "" });
	bridge.readNotes = async () => fakeResult([notesOnEdit, notesOffEdit]);

	const config = { ...DEFAULT_CONFIG, hunk: { ...DEFAULT_CONFIG.hunk, enabled: true, autoReviewNotes: true, autoReviewNotesMin: 2 } };

	// Desired: only the on-edit note is relevant. With 2 notes but only 1
	// relevant, and min=2 as a *fallback* on the relevant set, this should NOT
	// inject (1 relevant < 2). Dropping min to 1 should inject the 1 relevant.
	const { result: r1, inject: inj1 } = await bridge.pickup(cwd, config);
	assert.equal(inj1, false, "two notes but only one overlaps an edit, min=2 → no inject");
	assert.equal(r1.comments.length, 1, "result carries only relevant notes");
	assert.equal(r1.comments[0].summary, "on the edit", "the relevant note is the on-edit one");

	bridge.resetSignature();
	const configMin1 = { ...config, hunk: { ...config.hunk, autoReviewNotesMin: 1 } };
	const { result: r2, inject: inj2 } = await bridge.pickup(cwd, configMin1);
	assert.equal(inj2, true, "one relevant note meets min=1 → inject");
	assert.equal(r2.comments.length, 1, "only the relevant note is injected");
	assert.equal(r2.comments[0].summary, "on the edit");
}

console.log("pi-huff units ok");
