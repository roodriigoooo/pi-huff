import {
	createEditToolDefinition,
	createWriteToolDefinition,
	type EditToolDetails,
	type EditToolInput,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
	type ToolRenderContext,
	type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createHighlighter } from "shiki";
import fs from "node:fs/promises";
import { Type } from "typebox";
import { COMMON_LANGS, type HuffConfig, highlighterKey, loadConfig, mergeConfig } from "./config";
import { openHuffConfig } from "./configure";
import { createDiffView, DiffComponent, type Highlighter, writePatch } from "./diff-view";
import { createHunkBridge, type ReviewNotesResult, stringOr } from "./hunk-bridge";
import { displayPath, resolveUserPath } from "./paths";
import { createRenderRecordStore, type RenderRecord } from "./render-records";

// ============================================================================
// /huff command dispatch (status · send · auto on|off)
// ============================================================================

async function handleHuffCommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	getConfig: () => HuffConfig,
	setConfig: (config: HuffConfig) => void,
	setLiveSession: (live: boolean) => void,
	resetAutoSignature: () => void,
	recordCount: () => number,
	bridge: ReturnType<typeof createHunkBridge>,
) {
	const config = getConfig();
	const [sub = "status", arg = ""] = args.trim().split(/\s+/).filter(Boolean);
	if (!config.hunk.enabled && sub !== "status" && sub !== "help") {
		ctx.ui.notify("Huff's Hunk integration is disabled in config.", "warning");
		return;
	}
	if (sub === "status" || sub === "help") {
		const session = await bridge.probeSession(ctx.cwd, config, ctx.signal);
		const live = !!session;
		setLiveSession(live);
		const auto = config.hunk.autoReviewNotes ? `on (min ${config.hunk.autoReviewNotesMin})` : "off";
		if (live) {
			const id = stringOr(session?.id ?? session?.sessionId ?? session?.session?.id);
			ctx.ui.notify(`Huff is active. Recent diffs: ${recordCount()}. Auto review notes: ${auto}. Live Hunk session${id ? `: ${id}` : " detected"}. Commands: /huff status, /huff send, /huff auto on|off.`, "info");
		} else {
			ctx.ui.notify(`Huff is active. Recent diffs: ${recordCount()}. Auto review notes: ${auto}. No live Hunk session. Open another terminal in this repo and run: hunk diff --watch`, "info");
		}
		return;
	}
	if (sub === "auto") {
		if (arg === "on") {
			setConfig(mergeConfig(config, { hunk: { autoReviewNotes: true, autoReviewNotesMin: Math.max(2, config.hunk.autoReviewNotesMin || 2) } }));
			resetAutoSignature();
			ctx.ui.notify("Huff auto review pickup enabled for 2+ user notes.", "info");
			return;
		}
		if (arg === "off") {
			setConfig(mergeConfig(config, { hunk: { autoReviewNotes: false } }));
			resetAutoSignature();
			ctx.ui.notify("Huff auto review pickup disabled.", "info");
			return;
		}
		ctx.ui.notify(`Auto review pickup is ${config.hunk.autoReviewNotes ? `on (min ${config.hunk.autoReviewNotesMin})` : "off"}. Use /huff auto on or /huff auto off.`, "info");
		return;
	}
	if (sub === "send") {
		const notes = await bridge.readNotes(ctx.cwd, config, ctx.signal);
		setLiveSession(notes.live);
		if (!notes.live) {
			ctx.ui.notify(notes.message, "warning");
			return;
		}
		if (!notes.comments.length) {
			ctx.ui.notify("No user Hunk comments to send.", "info");
			return;
		}
		pi.sendUserMessage(notes.message, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
		ctx.ui.notify(`Sent ${notes.comments.length} Hunk comment(s) to the agent as ${ctx.isIdle() ? "a follow-up" : "steering"}.`, "info");
		return;
	}
	ctx.ui.notify(`Unknown /huff command: ${sub}. Try /huff status, /huff send, /huff auto on|off, or /huff configure.`, "warning");
}

// ============================================================================
// Extension entry
// ============================================================================

export default async function (pi: ExtensionAPI) {
	let config = await loadConfig(process.cwd());
	let highlighter: Highlighter | undefined;
	let highlighterLoadedKey = "";
	let highlighterRefresh: Promise<void> | undefined;
	let liveHunkSession = false;

	const records = createRenderRecordStore();
	const bridge = createHunkBridge((filePath, cwd) => records.findRecent(filePath, cwd));

	async function rebuildHighlighter(nextConfig: HuffConfig): Promise<void> {
		const key = highlighterKey(nextConfig);
		try {
			highlighter = (await createHighlighter({
				themes: Array.from(new Set([nextConfig.shikiDarkTheme, nextConfig.shikiLightTheme])),
				langs: [...COMMON_LANGS],
			})) as Highlighter;
			highlighterLoadedKey = key;
		} catch {
			highlighter = undefined;
			highlighterLoadedKey = key;
		}
	}

	function kickHighlighter(nextConfig: HuffConfig, invalidate?: () => void): Highlighter | undefined {
		if (highlighterLoadedKey === highlighterKey(nextConfig)) return highlighter;
		if (!highlighterRefresh) {
			highlighterRefresh = rebuildHighlighter(nextConfig).finally(() => {
				highlighterRefresh = undefined;
				invalidate?.();
			});
		}
		return highlighter;
	}

	await rebuildHighlighter(config);

	const editBase = createEditToolDefinition(process.cwd());
	const writeBase = createWriteToolDefinition(process.cwd());

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx.cwd);
		await rebuildHighlighter(config);
		ctx.ui.setStatus("huff", config.enabled ? "huff ✦" : undefined);
		bridge
			.probeSession(ctx.cwd, config, ctx.signal)
			.then((session) => {
				liveHunkSession = !!session;
			})
			.catch(() => {
				liveHunkSession = false;
			});
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!config.hunk.enabled || !config.hunk.reviewTool || !config.hunk.autoReviewNotes) return;
		const { result, inject } = await bridge.pickup(ctx.cwd, config, ctx.signal);
		liveHunkSession = result.live;
		if (!inject) return;
		ctx.ui.notify(`Picked up ${result.comments.length} Hunk review note(s).`, "info");
		return {
			message: {
				customType: "huff-review-notes",
				content: result.message,
				display: false,
				details: { comments: result.comments.length },
			},
		};
	});

	pi.registerCommand("huff", {
		description: "Huff diff renderer and read-only Hunk review bridge (/huff status, /huff send, /huff auto on|off, /huff configure)",
		handler: async (args, ctx) => {
			const [sub] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "configure") {
				await openHuffConfig(
					ctx,
					() => config,
					async (nextConfig) => {
						config = nextConfig;
						await rebuildHighlighter(nextConfig);
					},
					(nextConfig, invalidate) => kickHighlighter(nextConfig, invalidate),
				);
				return;
			}
			await handleHuffCommand(
				args,
				ctx,
				pi,
				() => config,
				(nextConfig) => (config = nextConfig),
				(live) => (liveHunkSession = live),
				() => bridge.resetSignature(),
				() => records.recentCount(),
				bridge,
			);
		},
	});

	pi.registerTool({
		name: "huff_review_notes",
		label: "Huff Review Notes",
		description: "Read human-authored Hunk review comments for the current repo. This is read-only and only returns comments with type=user from a live Hunk session.",
		promptSnippet: "Read human-authored Hunk review notes for the current repo (read-only).",
		promptGuidelines: [
			"Use huff_review_notes only to read human-authored Hunk review notes; never use it to create, apply, edit, remove, or clear comments.",
			"When huff_review_notes returns notes, address them comment-by-comment and preserve the user's intent.",
		],
		parameters: Type.Object({}),
		renderShell: "self",
		async execute(_toolCallId, _params, signal, _onUpdate, ctx: ExtensionContext) {
			if (!config.hunk.enabled || !config.hunk.reviewTool) {
				return { content: [{ type: "text", text: "Huff's read-only Hunk review tool is disabled in config." }], details: { live: false, comments: [], message: "disabled" } satisfies ReviewNotesResult };
			}
			const notes = await bridge.readNotes(ctx.cwd, config, signal);
			liveHunkSession = notes.live;
			return { content: [{ type: "text", text: notes.message }], details: notes };
		},
		renderCall(_args, theme: Theme) {
			return new Text(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("huff_review_notes"))} ${theme.fg("dim", "· read-only")}`, 0, 0);
		},
		renderResult(result, _options, theme: Theme, context: ToolRenderContext<any, Record<string, never>>) {
			return new DiffComponent(() => bridge.renderNotesLines(result.details as ReviewNotesResult | undefined, context.cwd, theme));
		},
	});

	pi.registerTool({
		...editBase,
		name: "edit",
		label: "Edit ✦ Huff",
		async execute(toolCallId, params: EditToolInput, signal, onUpdate, ctx: ExtensionContext) {
			const tool = createEditToolDefinition(ctx.cwd);
			const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			const details = result.details as EditToolDetails | undefined;
			if (details?.patch) {
				const filePath = resolveUserPath(params.path, ctx.cwd);
				const record: RenderRecord = {
					tool: "edit",
					filePath,
					patch: details.patch,
					summary: `Edited ${displayPath(filePath, ctx.cwd)} (${params.edits.length} replacement${params.edits.length === 1 ? "" : "s"})`,
				};
				records.record(toolCallId, record);
			}
			return result;
		},
		renderCall(args: EditToolInput, theme: Theme) {
			return new Text(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("muted", args.path)} ${theme.fg("dim", `· ${args.edits?.length ?? 0} block(s)`)}`, 0, 0);
		},
		renderResult(result, _options, theme: Theme, context: ToolRenderContext<any, EditToolInput>) {
			const details = result.details as EditToolDetails | undefined;
			const record = records.get(context.toolCallId);
			const patch = record?.patch ?? details?.patch;
			const filePath = record?.filePath ?? resolveUserPath(context.args.path, context.cwd);
			if (!config.enabled || !patch) return new Text(details?.diff ?? "Edited file", 0, 0);
			const activeHighlighter = kickHighlighter(config, context.invalidate);
			return createDiffView({ patch, filePath, cwd: context.cwd, title: "edited", config, highlighter: activeHighlighter, theme, liveSession: liveHunkSession });
		},
	});

	pi.registerTool({
		...writeBase,
		name: "write",
		label: "Write ✦ Huff",
		renderShell: "self",
		async execute(toolCallId, params: WriteToolInput, signal, onUpdate, ctx: ExtensionContext) {
			const filePath = resolveUserPath(params.path, ctx.cwd);
			let before = "";
			let existed = false;
			const tool = createWriteToolDefinition(ctx.cwd, {
				operations: {
					mkdir: async (dir) => {
						await fs.mkdir(dir, { recursive: true });
					},
					writeFile: async (absolutePath, content) => {
						try {
							before = await fs.readFile(absolutePath, "utf8");
							existed = true;
						} catch {
							before = "";
							existed = false;
						}
						await fs.writeFile(absolutePath, content, "utf8");
					},
				},
			});
			const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			const rel = displayPath(filePath, ctx.cwd);
			const patch = writePatch(existed ? `a/${rel}` : "/dev/null", `b/${rel}`, before, params.content);
			const record: RenderRecord = {
				tool: "write",
				filePath,
				patch,
				summary: `${existed ? "Rewrote" : "Created"} ${rel}`,
			};
			records.record(toolCallId, record);
			return result;
		},
		renderCall(args: WriteToolInput, theme: Theme) {
			const lines = args.content?.split("\n").length ?? 0;
			return new Text(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("muted", args.path)} ${theme.fg("dim", `· ${lines} line(s)`)}`, 0, 0);
		},
		renderResult(_result, _options, theme: Theme, context: ToolRenderContext<any, WriteToolInput>) {
			const record = records.get(context.toolCallId);
			if (!config.enabled || !record?.patch) return new Text("Wrote file", 0, 0);
			const activeHighlighter = kickHighlighter(config, context.invalidate);
			return createDiffView({
				patch: record.patch,
				filePath: record.filePath,
				cwd: context.cwd,
				title: record.summary.startsWith("Created") ? "created" : "wrote",
				config,
				highlighter: activeHighlighter,
				theme,
				liveSession: liveHunkSession,
			});
		},
	});
}
