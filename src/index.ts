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
import { Text, truncateToWidth, wrapTextWithAnsi, type AutocompleteItem } from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import { Type } from "typebox";
import { mergeConfig } from "./config";
import { openHunkConfig } from "./configure";
import { createDiffView, DiffComponent, writePatch } from "./diff-view";
import { createExtensionState, type ExtensionState } from "./extension-state";
import { type ReviewNotesResult, stringOr } from "./hunk-bridge";
import { displayPath, resolveUserPath } from "./paths";
import { type RenderRecord } from "./render-records";

// ============================================================================
// /hunk command dispatch (status · send · on|off · review · configure)
// ============================================================================

const HUNK_SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "status", label: "status", description: "Show pi-hunk and live Hunk session status." },
	{ value: "send", label: "send", description: "Attach open human review notes to the agent." },
	{ value: "on", label: "on", description: "Enable auto review pickup before agent turns." },
	{ value: "off", label: "off", description: "Disable auto review pickup." },
	{ value: "review", label: "review", description: "Open read-only review pairing notes with recent edits." },
	{ value: "configure", label: "configure", description: "Open the configuration TUI." },
];

function hunkArgumentCompletions(prefix: string): AutocompleteItem[] {
	const trimmed = prefix.trim();
	if (!trimmed) return HUNK_SUBCOMMANDS;
	const [first, ...rest] = trimmed.split(/\s+/);
	if (first === "auto") {
		const sub = rest.join("").trim();
		const opts: AutocompleteItem[] = [
			{ value: "auto on", label: "on", description: "Enable auto review pickup before agent turns." },
			{ value: "auto off", label: "off", description: "Disable auto review pickup." },
		];
		return sub ? opts.filter((o) => o.label.startsWith(sub)) : opts;
	}
	return HUNK_SUBCOMMANDS.filter((c) => c.value.startsWith(first));
}

async function handleHunkCommand(args: string, ctx: ExtensionCommandContext, pi: ExtensionAPI, state: ExtensionState) {
	const config = state.getConfig();
	const [sub = "status", arg = ""] = args.trim().split(/\s+/).filter(Boolean);
	const wantsAutoOn = sub === "on" || (sub === "auto" && arg === "on");
	const wantsAutoOff = sub === "off" || (sub === "auto" && arg === "off");
	if (!config.hunk.enabled && sub !== "status" && sub !== "help") {
		ctx.ui.notify("Hunk integration is disabled in config.", "warning");
		return;
	}
	if (sub === "status" || sub === "help") {
		const session = await state.bridge.probeSession(ctx.cwd, config, ctx.signal);
		const live = !!session;
		state.setLiveSession(live);
		const auto = config.hunk.autoReviewNotes ? "on" : "off";
		if (live) {
			const id = stringOr(session?.id ?? session?.sessionId ?? session?.session?.id);
			ctx.ui.notify(`pi-hunk is active. Recent diffs: ${state.records.recentCount()}. Auto review pickup: ${auto}. Live Hunk session${id ? `: ${id}` : " detected"}. Commands: /hunk status, /hunk send, /hunk on|off, /hunk review, /hunk configure.`, "info");
		} else {
			ctx.ui.notify(`pi-hunk is active. Recent diffs: ${state.records.recentCount()}. Auto review pickup: ${auto}. No live Hunk session. Open another terminal in this repo and run: hunk diff --watch`, "info");
		}
		return;
	}
	if (wantsAutoOn) {
		state.setConfig(mergeConfig(config, { hunk: { autoReviewNotes: true, autoReviewNotesMin: 1 } }));
		state.bridge.resetSignature();
		ctx.ui.notify("Hunk auto review pickup enabled. New relevant notes attach before the next agent turn; no turn starts by itself.", "info");
		return;
	}
	if (wantsAutoOff) {
		state.setConfig(mergeConfig(config, { hunk: { autoReviewNotes: false } }));
		state.bridge.resetSignature();
		ctx.ui.notify("Hunk auto review pickup disabled.", "info");
		return;
	}
	if (sub === "auto") {
		ctx.ui.notify(`Auto review pickup is ${config.hunk.autoReviewNotes ? "on" : "off"}. Use /hunk on or /hunk off.`, "info");
		return;
	}
	if (sub === "send") {
		const notes = await state.bridge.readNotes(ctx.cwd, config, ctx.signal);
		state.setLiveSession(notes.live);
		if (!notes.live) {
			ctx.ui.notify(notes.message, "warning");
			return;
		}
		if (!notes.comments.length) {
			ctx.ui.notify("No open Hunk review notes to attach.", "info");
			return;
		}
		pi.sendUserMessage(notes.message, { deliverAs: ctx.isIdle() ? "followUp" : "steer" });
		ctx.ui.notify(`Attached ${notes.comments.length} Hunk review note(s) to the agent as ${ctx.isIdle() ? "a follow-up" : "steering"}.`, "info");
		return;
	}
	if (sub === "review") {
		let notes = await state.bridge.readNotes(ctx.cwd, config, ctx.signal);
		state.setLiveSession(notes.live);
		if (ctx.mode !== "tui") {
			ctx.ui.notify(notes.live ? `${notes.comments.length} user note(s).` : notes.message, notes.live ? "info" : "warning");
			return;
		}
		let theme = ctx.ui.theme;
		await ctx.ui.custom<void>((tui, nextTheme, _kb, done) => {
			theme = nextTheme;
			const refresh = () => {
				state.bridge
					.readNotes(ctx.cwd, config, ctx.signal)
					.then((next) => {
						notes = next;
						state.setLiveSession(notes.live);
						tui.requestRender();
					})
					.catch(() => {});
			};
			return {
				render(width: number): string[] {
					const w = Math.max(20, width);
					const lines = state.bridge.renderReviewLines(notes, ctx.cwd, theme);
					return lines.flatMap((line) => wrapTextWithAnsi(line, w)).map((line) => truncateToWidth(line, w));
				},
				invalidate() {},
				handleInput(data: string) {
					if (data === "\x1b" || data === "\r" || data === "q") {
						done();
						return;
					}
					if (data === "r" || data === "R") {
						refresh();
						return;
					}
					tui.requestRender();
				},
			};
		});
		return;
	}
	ctx.ui.notify(`Unknown /hunk command: ${sub}. Try /hunk status, /hunk send, /hunk on|off, /hunk review, or /hunk configure.`, "warning");
}

// ============================================================================
// Extension entry
// ============================================================================

export default async function (pi: ExtensionAPI) {
	const state = await createExtensionState();

	const editBase = createEditToolDefinition(process.cwd());
	const writeBase = createWriteToolDefinition(process.cwd());

	pi.on("session_start", async (_event, ctx) => {
		await state.reloadConfig(ctx.cwd);
		ctx.ui.setStatus("hunk", state.getConfig().enabled ? "hunk ✦" : undefined);
		state.bridge
			.probeSession(ctx.cwd, state.getConfig(), ctx.signal)
			.then((session) => state.setLiveSession(!!session))
			.catch(() => state.setLiveSession(false));
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const config = state.getConfig();
		if (!config.hunk.enabled || !config.hunk.reviewTool || !config.hunk.autoReviewNotes) return;
		const { result, inject } = await state.bridge.pickup(ctx.cwd, config, ctx.signal);
		state.setLiveSession(result.live);
		if (!inject) return;
		ctx.ui.notify(`Picked up ${result.comments.length} Hunk review note(s).`, "info");
		return {
			message: {
				customType: "hunk-review-notes",
				content: result.message,
				display: false,
				details: { comments: result.comments.length },
			},
		};
	});

	pi.registerCommand("hunk", {
		description: "pi-hunk diff renderer and read-only Hunk review bridge (/hunk status, /hunk send, /hunk on|off, /hunk review, /hunk configure)",
		getArgumentCompletions: (argumentPrefix: string) => hunkArgumentCompletions(argumentPrefix),
		handler: async (args, ctx) => {
			const [sub] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "configure") {
				if (!ctx.isIdle()) {
					ctx.ui.notify("/hunk configure cannot open while the agent is responding. Wait for the response to finish, then run it again.", "warning");
					return;
				}
				await openHunkConfig(
					ctx,
					() => state.getConfig(),
					async (nextConfig) => {
						state.setConfig(nextConfig);
						await state.highlighters.refresh(nextConfig);
					},
					(nextConfig, invalidate) => state.highlighters.get(nextConfig, invalidate),
				);
				return;
			}
			await handleHunkCommand(args, ctx, pi, state);
		},
	});

	pi.registerTool({
		name: "hunk_review_notes",
		label: "Hunk Review Notes",
		description: "Read human-authored Hunk review comments for the current repo. This is read-only and only returns comments with type=user from a live Hunk session.",
		promptSnippet: "Read human-authored Hunk review notes for the current repo (read-only).",
		promptGuidelines: [
			"Use hunk_review_notes only to read human-authored Hunk review notes; never use it to create, apply, edit, remove, or clear comments.",
			"When hunk_review_notes returns notes, address them comment-by-comment and preserve the user's intent.",
		],
		parameters: Type.Object({}),
		renderShell: "self",
		async execute(_toolCallId, _params, signal, _onUpdate, ctx: ExtensionContext) {
			const config = state.getConfig();
			if (!config.hunk.enabled || !config.hunk.reviewTool) {
				return { content: [{ type: "text", text: "pi-hunk's read-only Hunk review tool is disabled in config." }], details: { live: false, comments: [], message: "disabled" } satisfies ReviewNotesResult };
			}
			const notes = await state.bridge.readNotes(ctx.cwd, config, signal);
			state.setLiveSession(notes.live);
			return { content: [{ type: "text", text: notes.message }], details: notes };
		},
		renderCall(_args, theme: Theme) {
			return new Text(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("hunk_review_notes"))} ${theme.fg("dim", "· read-only")}`, 0, 0);
		},
		renderResult(result, _options, theme: Theme, context: ToolRenderContext<any, Record<string, never>>) {
			const config = state.getConfig();
			return new DiffComponent(() => state.bridge.renderNotesLines(result.details as ReviewNotesResult | undefined, context.cwd, theme, config, state.highlighters.get(config, context.invalidate)));
		},
	});

	pi.registerTool({
		...editBase,
		name: "edit",
		label: "Edit ✦ Hunk",
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
				state.records.record(toolCallId, record);
			}
			return result;
		},
		renderCall(args: EditToolInput, theme: Theme) {
			return new Text(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("muted", args.path)} ${theme.fg("dim", `· ${args.edits?.length ?? 0} block(s)`)}`, 0, 0);
		},
		renderResult(result, _options, theme: Theme, context: ToolRenderContext<any, EditToolInput>) {
			const config = state.getConfig();
			const details = result.details as EditToolDetails | undefined;
			const record = state.records.get(context.toolCallId);
			const patch = record?.patch ?? details?.patch;
			const filePath = record?.filePath ?? resolveUserPath(context.args.path, context.cwd);
			if (!config.enabled || !patch) return new Text(details?.diff ?? "Edited file", 0, 0);
			const activeHighlighter = state.highlighters.get(config, context.invalidate);
			return createDiffView({ patch, filePath, cwd: context.cwd, title: "edited", config, highlighter: activeHighlighter, theme, liveSession: state.getLiveSession(), invalidate: context.invalidate });
		},
	});

	pi.registerTool({
		...writeBase,
		name: "write",
		label: "Write ✦ Hunk",
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
			state.records.record(toolCallId, record);
			return result;
		},
		renderCall(args: WriteToolInput, theme: Theme) {
			const lines = args.content?.split("\n").length ?? 0;
			return new Text(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("muted", args.path)} ${theme.fg("dim", `· ${lines} line(s)`)}`, 0, 0);
		},
		renderResult(_result, _options, theme: Theme, context: ToolRenderContext<any, WriteToolInput>) {
			const config = state.getConfig();
			const record = state.records.get(context.toolCallId);
			if (!config.enabled || !record?.patch) return new Text("Wrote file", 0, 0);
			const activeHighlighter = state.highlighters.get(config, context.invalidate);
			return createDiffView({
				patch: record.patch,
				filePath: record.filePath,
				cwd: context.cwd,
				title: record.summary.startsWith("Created") ? "created" : "wrote",
				config,
				highlighter: activeHighlighter,
				theme,
				liveSession: state.getLiveSession(),
				invalidate: context.invalidate,
			});
		},
	});
}
