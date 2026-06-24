import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const { DEFAULT_CONFIG } = await jiti.import(path.join(repoRoot, "src", "config.ts"), { default: false });
const { normalizeHunkComments } = await jiti.import(path.join(repoRoot, "src", "hunk-bridge.ts"), { default: false });

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
	codeToTokensBase(line) {
		return [[{ content: line, color: "#ffffff" }]];
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

console.log("pi-huff units ok");
