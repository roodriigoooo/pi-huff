import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
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
	throw new Error(`Could not locate @earendil-works/pi-coding-agent. Set PI_CODING_AGENT_ROOT. Tried: ${candidates.join(", ")}`);
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
		"typebox": path.join(piNodeModules, "typebox", "build", "index.mjs"),
	},
});

function fakeTheme() {
	const colors = {
		accent: "\x1b[38;2;255;190;106m",
		borderMuted: "\x1b[38;2;90;90;90m",
		toolTitle: "\x1b[38;2;250;250;250m",
		toolDiffAdded: "\x1b[38;2;80;220;120m",
		toolDiffRemoved: "\x1b[38;2;240;100;100m",
		toolDiffContext: "\x1b[38;2;210;210;210m",
		muted: "\x1b[38;2;160;160;160m",
		dim: "\x1b[38;2;110;110;110m",
		warning: "\x1b[38;2;255;200;80m",
	};
	return {
		name: "smoke-dark",
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

function makeCtx(cwd, ui, idle = true) {
	return {
		cwd,
		ui,
		mode: "tui",
		hasUI: true,
		sessionManager: {},
		modelRegistry: {},
		model: undefined,
		signal: undefined,
		isIdle: () => idle,
		isProjectTrusted: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({}),
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
	};
}

function stripAnsi(value) {
	return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function renderTool(tool, toolCallId, result, args, cwd) {
	const component = tool.renderResult(result, { expanded: true, isPartial: false }, fakeTheme(), {
		args,
		toolCallId,
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
	});
	return component.render(100).join("\n");
}

const tmp = await mkdtemp(path.join(os.tmpdir(), "pi-huff-smoke-"));
try {
	const fakeHunk = path.join(tmp, "fake-hunk.mjs");
	await writeFile(
		fakeHunk,
		`#!/usr/bin/env node
import { realpathSync } from "node:fs";
const args = process.argv.slice(2);
const joined = args.join(" ");
function valueAfter(flag) {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}
function assertFlag(condition, message) {
  if (!condition) {
    console.error(message + ": " + joined);
    process.exit(2);
  }
}
function samePath(a, b) {
  if (!a || !b) return false;
  try { return realpathSync(a) === realpathSync(b); } catch { return a === b; }
}
if (joined.startsWith("session get")) {
  assertFlag(samePath(valueAfter("--repo"), process.cwd()), "session get missing --repo cwd");
  assertFlag(args.includes("--json"), "session get missing --json");
  console.log(JSON.stringify({ id: "smoke-session", repo: process.cwd() }));
  process.exit(0);
}
if (joined.startsWith("session comment list")) {
  assertFlag(samePath(valueAfter("--repo"), process.cwd()), "comment list missing --repo cwd");
  assertFlag(valueAfter("--type") === "user", "comment list missing --type user");
  assertFlag(args.includes("--json"), "comment list missing --json");
  console.log(JSON.stringify({ comments: [
    { id: "c1", type: "user", filePath: "smoke.ts", newLine: 1, summary: "tighten the greeting", rationale: "the reviewed line should mention Huff", author: "human" },
    { id: "c2", type: "user", filePath: "smoke.ts", newLine: 1, summary: "keep the file tiny", rationale: "no extra scaffolding", author: "human" }
  ] }));
  process.exit(0);
}
console.error("unexpected fake hunk args: " + joined);
process.exit(2);
`,
		"utf8",
	);
	await chmod(fakeHunk, 0o755);
	await mkdir(path.join(tmp, ".pi"), { recursive: true });
	await writeFile(path.join(tmp, ".pi", "huff.json"), JSON.stringify({ hunk: { binary: fakeHunk }, maxRenderedLines: 80 }, null, 2), "utf8");

	const notifications = [];
	const statuses = new Map();
	const configureSnapshots = [];
	const ui = {
		notify: (message, type = "info") => notifications.push({ message, type }),
		setStatus: (key, text) => statuses.set(key, text),
		custom: async (factory) => {
			const comp = factory({ requestRender() {} }, fakeTheme(), {}, () => {});
		if (comp && typeof comp.render === "function") {
			configureSnapshots.push(stripAnsi(comp.render(100).join("\n")));
			comp.handleInput?.("\r");
			configureSnapshots.push(stripAnsi(comp.render(100).join("\n")));
			comp.handleInput?.("\r");
			configureSnapshots.push(stripAnsi(comp.render(100).join("\n")));
			comp.handleInput?.("\x1b[B");
			configureSnapshots.push(stripAnsi(comp.render(100).join("\n")));
			comp.handleInput?.("\x1b");
		}
			return undefined;
		},
		theme: fakeTheme(),
	};
	const tools = new Map();
	const commands = new Map();
	const handlers = new Map();
	const sentUserMessages = [];
	const pi = {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		registerShortcut() {},
		registerFlag() {},
		getFlag: () => undefined,
		registerMessageRenderer() {},
		sendMessage() {},
		sendUserMessage(content, options) {
			sentUserMessages.push({ content, options });
		},
		appendEntry() {},
		setSessionName() {},
		getSessionName: () => undefined,
		setLabel() {},
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
		getActiveTools: () => Array.from(tools.keys()),
		getAllTools: () => Array.from(tools.values()).map((definition) => ({ ...definition, sourceInfo: { type: "smoke" } })),
		setActiveTools() {},
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "high",
		setThinkingLevel() {},
		registerProvider() {},
		unregisterProvider() {},
		events: { on() {}, emit() {} },
	};

	const extensionFactory = await jiti.import(path.join(repoRoot, "src", "index.ts"), { default: true });
	await extensionFactory(pi);
	assert.ok(tools.has("write"), "write tool registered");
	assert.ok(tools.has("edit"), "edit tool registered");
	assert.ok(tools.has("huff_review_notes"), "read-only review tool registered");
	assert.ok(commands.has("huff"), "/huff command registered");

	const ctx = makeCtx(tmp, ui, true);
	for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(statuses.get("huff"), "huff ✦");
	await new Promise((resolve) => setTimeout(resolve, 50));

	const writeTool = tools.get("write");
	const writeArgs = { path: "smoke.ts", content: "hello world\n" };
	const writeResult = await writeTool.execute("smoke-write", writeArgs, undefined, undefined, ctx);
	const writeView = renderTool(writeTool, "smoke-write", writeResult, writeArgs, tmp);
	const writePlain = stripAnsi(writeView);
	assert.match(writeView, /\x1b\[/, "write renderer produced ANSI");
	assert.match(writePlain, /created/);
	assert.match(writePlain, /smoke\.ts/);
	assert.match(writePlain, /\+1/);
	assert.match(writePlain, /▎/);
	assert.doesNotMatch(writePlain, /agent-context/);

	const queuedAArgs = { path: "queued.ts", content: "one\n" };
	const queuedBArgs = { path: "queued.ts", content: "two\n" };
	const [queuedAResult, queuedBResult] = await Promise.all([
		writeTool.execute("queued-a", queuedAArgs, undefined, undefined, ctx),
		writeTool.execute("queued-b", queuedBArgs, undefined, undefined, ctx),
	]);
	const queuedAPlain = stripAnsi(renderTool(writeTool, "queued-a", queuedAResult, queuedAArgs, tmp));
	const queuedBPlain = stripAnsi(renderTool(writeTool, "queued-b", queuedBResult, queuedBArgs, tmp));
	assert.match(queuedAPlain, /created/);
	assert.match(queuedBPlain, /wrote/);
	assert.match(queuedBPlain, /one/);
	assert.match(queuedBPlain, /two/);
	assert.equal(await readFile(path.join(tmp, "queued.ts"), "utf8"), "two\n");

	const editTool = tools.get("edit");
	const editArgs = { path: "smoke.ts", edits: [{ oldText: "hello world\n", newText: "hello huff\n" }] };
	const editResult = await editTool.execute("smoke-edit", editArgs, undefined, undefined, ctx);
	const editView = renderTool(editTool, "smoke-edit", editResult, editArgs, tmp);
	const editPlain = stripAnsi(editView);
	assert.match(editPlain, /edited/);
	assert.match(editPlain, /huff/);
	assert.match(editPlain, /@@/);

	const reviewTool = tools.get("huff_review_notes");
	const reviewResult = await reviewTool.execute("smoke-review", {}, undefined, undefined, ctx);
	assert.match(reviewResult.content[0].text, /tighten the greeting/);
	assert.doesNotMatch(reviewResult.content[0].text, /Recent Huff diff:/);
	const reviewView = renderTool(reviewTool, "smoke-review", reviewResult, {}, tmp);
	const reviewPlain = stripAnsi(reviewView);
	assert.match(reviewPlain, /Hunk review notes/);
	assert.match(reviewPlain, /2 user notes/);
	assert.match(reviewPlain, /tighten the greeting/);
	assert.doesNotMatch(reviewPlain, /Recent Huff diff:/);

	await commands.get("huff").handler("auto on", ctx);
	const autoResults = [];
	for (const handler of handlers.get("before_agent_start") ?? []) {
		const result = await handler({ type: "before_agent_start", prompt: "continue" }, ctx);
		if (result) autoResults.push(result);
	}
	assert.equal(autoResults.length, 1);
	assert.match(autoResults[0].message.content, /tighten the greeting/);
	assert.match(autoResults[0].message.content, /keep the file tiny/);

	await commands.get("huff").handler("send", ctx);
	assert.equal(sentUserMessages.length, 1);
	assert.match(sentUserMessages[0].content, /tighten the greeting/);
	assert.equal(sentUserMessages[0].options.deliverAs, "followUp");

	// /huff review pairs notes with recent edits (read-only, human-facing).
	const reviewBefore = configureSnapshots.length;
	await commands.get("huff").handler("review", ctx);
	const reviewSnap = configureSnapshots.slice(reviewBefore).join("\n");
	assert.match(reviewSnap, /Hunk review/, "/huff review renders review header");
	// both smoke notes are on smoke.ts newLine 1, which the edit above touched
	assert.match(reviewSnap, /addressed/i, "/huff review marks overlapping notes addressed");

	const huffDir = path.join(tmp, ".pi", "huff");
	let sidecars = [];
	try {
		sidecars = await readdir(huffDir);
	} catch {}
	assert.equal(sidecars.filter((name) => name.endsWith(".agent-context.json") || name.endsWith(".patch")).length, 0, "no patch or agent-context sidecars written");

	const finalFile = await readFile(path.join(tmp, "smoke.ts"), "utf8");
	assert.equal(finalFile, await readFile(path.join(tmp, "smoke.ts"), "utf8"), "hello huff\n");

	const configureStart = configureSnapshots.length;
	await commands.get("huff").handler("configure", ctx);
	const cfgSnapshots = configureSnapshots.slice(configureStart);
	assert.ok(cfgSnapshots[0].includes("Huff Configuration"), "configure opens with title");
	assert.ok(cfgSnapshots[0].includes("Side colors & words"), "configure shows group nav");
	assert.ok(cfgSnapshots.some((s) => s.includes("word emphasis")), "enter descends into a group showing its settings");
	assert.ok(cfgSnapshots.some((snapshot) => /↑↓ move · Enter select/.test(snapshot)), "second enter opens a picker inside the group");

	console.log("pi-huff smoke ok");
} finally {
	await rm(tmp, { recursive: true, force: true });
}
