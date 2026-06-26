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

const { parseUnifiedPatch, renderDiffLines, findPatchLineAddress, patchLineAddressKey } = await jiti.import(path.join(repoRoot, "src", "diff-view.ts"), { default: false });
const { DEFAULT_CONFIG, TOKENIZE_MAX_LINE_LENGTH, TOKENIZE_TIME_LIMIT_MS, ansiFg } = await jiti.import(path.join(repoRoot, "src", "config.ts"), { default: false });
const { applyHunkPreset, choicesForSpec, descriptionForSpec, hunkConfigGroups, hunkConfigPresets } = await jiti.import(path.join(repoRoot, "src", "config-spec.ts"), { default: false });
const { createHighlighterCache } = await jiti.import(path.join(repoRoot, "src", "highlighter-cache.ts"), { default: false });
const { normalizeHunkComments, createHunkBridge, buildReviewNoteShape, reviewAnnotationsForRecord } = await jiti.import(path.join(repoRoot, "src", "hunk-bridge.ts"), { default: false });
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

// patch address query: a review note lands on the rendered row it names
const noteAddress = findPatchLineAddress(parsed, { filePath: "a.ts", newLine: 2 }, repoRoot);
assert.ok(noteAddress, "new-side address found");
assert.equal(noteAddress.kind, "add");
assert.equal(noteAddress.lineIndex, 2);
const annotatedRender = renderDiffLines({
	patch,
	filePath: "a.ts",
	cwd: repoRoot,
	title: "unit",
	config: { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false },
	highlighter: fakeHighlighter,
	theme: fakeTheme(),
	liveSession: false,
	annotations: new Map([[patchLineAddressKey(noteAddress), [{ text: "tighten greeting", detail: "human rationale", author: "human" }]]]),
});
const annotatedLine = annotatedRender.find((line) => stripAnsi(line).includes("tighten greeting"));
assert.ok(annotatedLine, "annotation rendered inline beside addressed row");
assert.match(stripAnsi(annotatedLine), /hi.*note human: tighten greeting \(human rationale\)/);

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

// --- Shiki perf guards + lazy non-core language loading --------------------
{
	let invalidated = false;
	const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"] });
	assert.ok(!highlighter.getLoadedLanguages().includes("haskell"), "haskell is not eagerly loaded");
	const hsPatch = [
		"--- a/Main.hs",
		"+++ b/Main.hs",
		"@@ -1,1 +1,1 @@",
		"-main = putStrLn \"old\"",
		"+main = putStrLn \"new\"",
	].join("\n");
	const first = renderDiffLines({
		patch: hsPatch,
		filePath: "Main.hs",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "none", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter,
		theme: fakeTheme(),
		liveSession: false,
		invalidate: () => (invalidated = true),
	});
	assert.ok(first.some((line) => stripAnsi(line).includes("putStrLn")), "first render falls back to readable plain text");
	for (let i = 0; i < 40 && !highlighter.getLoadedLanguages().includes("haskell"); i++) await new Promise((resolve) => setTimeout(resolve, 25));
	assert.ok(highlighter.getLoadedLanguages().includes("haskell"), "haskell loaded lazily");
	assert.equal(invalidated, true, "lazy load asks TUI to rerender");
	const expected = highlighter.codeToTokensBase("main = putStrLn \"new\"", { lang: "haskell", theme: "github-dark" })[0].find((t) => t.content.includes("new"));
	const expectedAnsi = ansiFg(expected?.color);
	const second = renderDiffLines({
		patch: hsPatch,
		filePath: "Main.hs",
		cwd: repoRoot,
		title: "unit",
		config: { ...DEFAULT_CONFIG, wordHighlight: "none", lineHighlight: "none", lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter,
		theme: fakeTheme(),
		liveSession: false,
	});
	assert.ok(expectedAnsi && second.some((line) => line.includes(expectedAnsi)), "second render uses lazily loaded Haskell grammar");
	await highlighter.dispose();

	let calls = 0;
	const guardedHighlighter = {
		codeToTokensBase(_code, options) {
			calls++;
			assert.equal(options.tokenizeMaxLineLength, TOKENIZE_MAX_LINE_LENGTH, "max line guard passed to Shiki");
			assert.equal(options.tokenizeTimeLimit, TOKENIZE_TIME_LIMIT_MS, "time guard passed to Shiki");
			return [[{ content: "const ok = true;", color: "#ffffff" }]];
		},
	};
	const shortPatch = "--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-const ok = false;\n+const ok = true;";
	renderDiffLines({ patch: shortPatch, filePath: "a.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, compactUnchanged: false }, highlighter: guardedHighlighter, theme: fakeTheme() });
	assert.equal(calls, 2, "normal hunk tokenizes both sides with guards");
	const longLine = "x".repeat(TOKENIZE_MAX_LINE_LENGTH + 1);
	const longPatch = `--- a/a.ts\n+++ b/a.ts\n@@ -1,1 +1,1 @@\n-${longLine}\n+${longLine}`;
	renderDiffLines({ patch: longPatch, filePath: "a.ts", cwd: repoRoot, title: "unit", config: { ...DEFAULT_CONFIG, compactUnchanged: false }, highlighter: guardedHighlighter, theme: fakeTheme() });
	assert.equal(calls, 2, "too-long hunk falls back to plain text before tokenization");
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

	const config = { ...DEFAULT_CONFIG, hunk: { ...DEFAULT_CONFIG.hunk, enabled: true, autoReviewNotes: true, autoReviewNotesMin: 99 } };

	// Desired: only the on-edit note is relevant. Arbitrary count thresholds no
	// longer gate pickup; one relevant note is enough when auto pickup is enabled.
	const { result: r1, inject: inj1 } = await bridge.pickup(cwd, config);
	assert.equal(inj1, true, "one relevant note injects even when legacy min is high");
	assert.equal(r1.comments.length, 1, "result carries only relevant notes");
	assert.equal(r1.comments[0].summary, "on the edit", "the relevant note is the on-edit one");

	const { inject: inj2 } = await bridge.pickup(cwd, config);
	assert.equal(inj2, false, "unchanged review state is deduped");
}

// --- I2: shared patch model shapes review notes by rendered hunk row --------
{
	const cwd = repoRoot;
	const store = createRenderRecordStore();
	const record = {
		tool: "edit",
		filePath: path.join(cwd, "src", "app.ts"),
		patch: writePatch("a/src/app.ts", "b/src/app.ts", "line1\nline2\nold\nold\nline5\n", "line1\nline2\nnewA\nnewB\nline5\n"),
		summary: "edited app.ts",
	};
	store.record("call-1", record);
	const findRecent = (filePath) => store.findRecent(filePath, cwd);
	const comments = [
		{ id: "n1", type: "user", filePath: "src/app.ts", newLine: 4, summary: "pin on new row", rationale: "spatial" },
		{ id: "n2", type: "user", filePath: "src/missing.ts", newLine: 1, summary: "no patch" },
	];
	const shape = buildReviewNoteShape(comments, findRecent, cwd);
	assert.equal(shape.hunks.length, 1, "one rendered hunk owns matching note");
	assert.equal(shape.hunks[0].lines.length, 1, "one addressed row in hunk");
	assert.equal(shape.hunks[0].lines[0].comments[0].summary, "pin on new row");
	assert.equal(shape.openComments.length, 1, "unmatched note remains open");
	const annotations = reviewAnnotationsForRecord(comments, record, cwd);
	const rendered = renderDiffLines({
		patch: record.patch,
		filePath: record.filePath,
		cwd,
		title: "review notes",
		config: { ...DEFAULT_CONFIG, lineNumbers: false, header: "minimal", compactUnchanged: false },
		highlighter: fakeHighlighter,
		theme: fakeTheme(),
		liveSession: false,
		annotations,
	});
	assert.ok(rendered.some((line) => /newB.*note pin on new row/.test(stripAnsi(line))), "review annotation shares diff renderer row");
}

// --- J: /hunk review pairs notes with recent edits (read-only) -------------

// renderReviewLines lists each human note with whether a recent edit touched
// its line or not. It must not send anything to the agent; it is a human-facing
// diagnostic.
{
	const cwd = repoRoot;
	const store = createRenderRecordStore();
	store.record("call-1", {
		tool: "edit",
		filePath: path.join(cwd, "src", "app.ts"),
		patch: writePatch("a/src/app.ts", "b/src/app.ts", "line1\nline2\nold\nold\nold\nline6\n", "line1\nline2\nnewA\nnewB\nnewC\nline6\n"),
		summary: "edited app.ts",
	});
	const findRecent = (filePath) => store.findRecent(filePath, cwd);
	const bridge = createHunkBridge(findRecent);

	const result = {
		live: true,
		session: { id: "s" },
		comments: [
			{ id: "n1", type: "user", filePath: "src/app.ts", newLine: 4, summary: "on the edit", rationale: "why" },
			{ id: "n2", type: "user", filePath: "src/other.ts", newLine: 99, summary: "untouched file" },
		],
		message: "",
	};
	const lines = bridge.renderReviewLines(result, findRecent, cwd, fakeTheme());
	const plain = lines.map(stripAnsi).join("\n");
	assert.match(plain, /Hunk review/, "review header present");
	assert.match(plain, /on the edit/, "on-edit note listed");
	assert.match(plain, /untouched file/, "off-edit note listed");
	const onEditIdx = lines.findIndex((l) => stripAnsi(l).includes("on the edit"));
	const offEditIdx = lines.findIndex((l) => stripAnsi(l).includes("untouched file"));
	assert.ok(onEditIdx >= 0 && offEditIdx >= 0, "both notes rendered");
	assert.match(stripAnsi(lines[onEditIdx]), /touched/i, "on-edit note marked touched");
	assert.match(stripAnsi(lines[offEditIdx]), /open/i, "off-edit note marked open");
}

// --- J2: a note pinned to a removed line (oldLine) counts as touched -------
// Regression: the overlap check used to compare oldLine against the edit's
// new-side span only, so a note on a deleted line always read as "open".
// The shared patch address query now checks oldLine against rendered remove rows.
{
	const cwd = repoRoot;
	const store = createRenderRecordStore();
	store.record("call-1", {
		tool: "edit",
		filePath: path.join(cwd, "src", "app.ts"),
		patch: writePatch("a/src/app.ts", "b/src/app.ts", "a\nb\nc\nd\ne\n", "a\nb\nc\n"),
		summary: "deleted lines 4-5",
	});
	const findRecent = (filePath) => store.findRecent(filePath, cwd);
	const bridge = createHunkBridge(findRecent);

	const result = {
		live: true,
		session: { id: "s" },
		comments: [
			{ id: "n1", type: "user", filePath: "src/app.ts", oldLine: 4, summary: "on the removed line" },
		],
		message: "",
	};
	const lines = bridge.renderReviewLines(result, findRecent, cwd, fakeTheme());
	const idx = lines.findIndex((l) => stripAnsi(l).includes("on the removed line"));
	assert.ok(idx >= 0, "removed-line note rendered");
	assert.match(stripAnsi(lines[idx]), /touched/i, "note on a removed line is touched, not open");
}

// --- K: highlighter cache coalesces refreshes and serves stale while loading -
{
	const configA = { ...DEFAULT_CONFIG, shikiDarkTheme: "theme-a", shikiLightTheme: "theme-a-light" };
	const configB = { ...DEFAULT_CONFIG, shikiDarkTheme: "theme-b", shikiLightTheme: "theme-b-light" };
	let releaseB;
	const gateB = new Promise((resolve) => (releaseB = resolve));
	const calls = [];
	const cache = createHighlighterCache(async (config) => {
		calls.push(config.shikiDarkTheme);
		if (config.shikiDarkTheme === "theme-b") await gateB;
		return { id: config.shikiDarkTheme };
	});
	await cache.refresh(configA);
	assert.equal(cache.get(configA).id, "theme-a", "initial highlighter loaded");
	const refreshB = cache.refresh(configB);
	assert.equal(cache.get(configB).id, "theme-a", "stale highlighter served while new key loads");
	const refreshB2 = cache.refresh(configB);
	assert.equal(refreshB2, refreshB, "same-key refresh coalesces to one promise");
	assert.deepEqual(calls, ["theme-a", "theme-b"], "only one rebuild starts for concurrent same-key refreshes");
	releaseB();
	await refreshB;
	assert.equal(cache.get(configB).id, "theme-b", "new highlighter served after refresh completes");
}

// --- L: config spec model is pure and round-trips without TUI --------------
{
	const groups = hunkConfigGroups();
	const specs = groups.flatMap((group) => group.specs);
	const ids = specs.map((spec) => spec.id);
	assert.equal(new Set(ids).size, ids.length, "config spec ids are unique");
	assert.deepEqual(ids, [
		"wordHighlight",
		"colors.add",
		"colors.remove",
		"colors.context",
		"lineHighlight",
		"colors.gutter",
		"symbols.gutter",
		"symbols.add",
		"symbols.remove",
		"header",
		"lineNumbers",
		"colors.header",
		"colors.lineNo",
		"colors.meta",
		"symbols.context",
		"symbols.fold",
		"compactUnchanged",
		"contextRadius",
		"maxRenderedLines",
		"diffTheme",
		"shikiDarkTheme",
		"shikiLightTheme",
		"enabled",
		"showHunkHint",
		"hunk.enabled",
		"hunk.reviewTool",
		"hunk.autoReviewNotes",
	], "spec model covers current TUI configuration surface");
	for (const spec of specs) {
		const draft = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
		const current = spec.get(draft);
		const choices = choicesForSpec(spec, draft, fakeTheme());
		assert.ok(choices.some((choice) => choice.value === current), `${spec.id} choices include current value`);
		const next = choices.find((choice) => choice.value !== current)?.value ?? current;
		spec.set(draft, next);
		assert.equal(spec.get(draft), next, `${spec.id} set/get round-trips`);
		assert.match(descriptionForSpec(spec, draft, fakeTheme()), /^Current:/, `${spec.id} has description`);
	}
	const presets = hunkConfigPresets();
	assert.deepEqual(presets.map((preset) => preset.id), ["pi-native", "high-contrast-mono", "warm-editorial", "syntax-only"], "preset surface is stable");
	const warm = applyHunkPreset(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), presets.find((preset) => preset.id === "warm-editorial"));
	assert.equal(warm.wordHighlight, "underline", "preset applies word style");
	assert.equal(warm.header, "compact", "preset applies header style");
	assert.equal(warm.colors.add, "#80dc78", "preset applies full color config");
	const syntaxOnly = applyHunkPreset(JSON.parse(JSON.stringify(DEFAULT_CONFIG)), presets.find((preset) => preset.id === "syntax-only"));
	assert.equal(syntaxOnly.wordHighlight, "none", "syntax-only disables word markers");
	assert.equal(syntaxOnly.lineHighlight, "none", "syntax-only disables line markers");
	const gutterSpec = specs.find((spec) => spec.id === "symbols.gutter");
	const addColorSpec = specs.find((spec) => spec.id === "colors.add");
	const gutterChoice = choicesForSpec(gutterSpec, DEFAULT_CONFIG, fakeTheme())[0];
	const addColorChoice = choicesForSpec(addColorSpec, DEFAULT_CONFIG, fakeTheme())[0];
	assert.match(stripAnsi(gutterChoice.label), /\+\s+const x = 1;/, "symbol choices render glyphs inside a sample diff line");
	assert.match(stripAnsi(addColorChoice.label), /\+ const tone = vivid/, "color choices render color inside a sample diff line");
}

console.log("pi-hunk units ok");
