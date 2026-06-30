import type { Theme } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import type { HunkConfig } from "./config";
import {
	findPatchLineAddress,
	parseUnifiedPatch,
	patchLineAddressKey,
	renderDiffLines,
	type DiffLineAnnotations,
	type Highlighter,
	type ParsedPatch,
	type PatchLineAddress,
} from "./diff-view";
import { displayPath, fileKey } from "./paths";
import type { PatchEntry, PatchSource, RefreshablePatchSource } from "./patch-source";

// ============================================================================
// Types
// ============================================================================

type HunkExecResult = { stdout: string; stderr: string; code: number };

export type HunkComment = {
	id?: string;
	filePath?: string;
	oldLine?: number;
	newLine?: number;
	summary: string;
	rationale?: string;
	author?: string;
	type?: string;
};

export type ReviewNoteLine = {
	lineKey: string;
	address: PatchLineAddress;
	comments: HunkComment[];
};

export type ReviewNoteHunk = {
	filePath: string;
	summary: string;
	hunkIndex: number;
	header: string;
	lines: ReviewNoteLine[];
};

export type ReviewNoteShape = {
	hunks: ReviewNoteHunk[];
	openComments: HunkComment[];
};

export type ReviewNotesResult = {
	live: boolean;
	comments: HunkComment[];
	message: string;
	session?: any;
	error?: string;
	hunks?: ReviewNoteHunk[];
	openComments?: HunkComment[];
};

// ============================================================================
// Hunk CLI exec
// ============================================================================

async function hunkExec(cwd: string, command: string, args: string[], timeout = 20_000, signal?: AbortSignal): Promise<HunkExecResult> {
	return await new Promise<HunkExecResult>((resolve) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: HunkExecResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
		}, timeout);
		const onAbort = () => child.kill("SIGTERM");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (d) => (stdout += d));
		child.stderr.on("data", (d) => (stderr += d));
		child.on("close", (code) => finish({ stdout, stderr, code: code ?? 1 }));
		child.on("error", (error) => finish({ stdout, stderr: String(error), code: 1 }));
	});
}

/** Run a `hunk` CLI subcommand and parse its JSON stdout. Returns undefined on
 *  non-zero exit or unparseable output. Exported so the reviewed-patch source
 *  can fetch `session review --include-patch --include-notes` through the same
 *  defensive exec path as the rest of the bridge. */
export async function runHunkJson(cwd: string, args: string[], config: HunkConfig, timeout = 20_000, signal?: AbortSignal): Promise<any | undefined> {
	const execResult = await hunkExec(cwd, config.hunk.binary, args, timeout, signal);
	if (execResult.code !== 0) return undefined;
	try {
		return JSON.parse(execResult.stdout);
	} catch {
		return undefined;
	}
}

/** Refresh a patch source's cache if it is refreshable; no-op for plain sources
 *  (e.g. the agent-edit adapter used in unit tests). */
async function refreshPatchSource(source: PatchSource, cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<void> {
	const refresh = (source as RefreshablePatchSource).refresh;
	if (typeof refresh === "function") await refresh.call(source, cwd, config, signal);
}

// ============================================================================
// Comment normalization — the defensive Hunk JSON schema tolerance
// ============================================================================

function isObject(value: unknown): value is Record<string, any> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function firstFiniteNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		if (Array.isArray(value)) {
			const n = firstFiniteNumber(...value);
			if (n !== undefined) return n;
			continue;
		}
		const n = Number(value);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const s = String(value).trim();
	return s || undefined;
}

/** Normalize a Hunk `comment list` payload into semantic comments. */
export function normalizeHunkComments(payload: any): HunkComment[] {
	const raw: Array<{ comment: any; fileHint?: string }> = [];
	const pushCollection = (items: any, fileHint?: string) => {
		if (Array.isArray(items)) for (const comment of items) raw.push({ comment, fileHint });
	};

	pushCollection(payload);
	pushCollection(payload?.comments);
	pushCollection(payload?.items);
	pushCollection(payload?.annotations);

	if (Array.isArray(payload?.files)) {
		for (const file of payload.files) {
			const fileHint = stringOrUndefined(file?.path ?? file?.filePath ?? file?.file ?? file?.name);
			pushCollection(file?.comments, fileHint);
			pushCollection(file?.annotations, fileHint);
			pushCollection(file?.items, fileHint);
		}
	}

	const seen = new Set<string>();
	const out: HunkComment[] = [];
	for (const { comment: c, fileHint } of raw) {
		if (!isObject(c)) continue;
		const location = isObject(c.location) ? c.location : undefined;
		const range = isObject(c.range) ? c.range : undefined;
		const line = isObject(c.line) ? c.line : undefined;
		const newRange = c.newRange ?? location?.newRange ?? range?.newRange;
		const oldRange = c.oldRange ?? location?.oldRange ?? range?.oldRange;
		const summary = stringOrUndefined(c.summary ?? c.text ?? c.body ?? c.message ?? c.note ?? c.title);
		if (!summary) continue;
		const filePath = stringOrUndefined(c.filePath ?? c.file ?? c.path ?? location?.filePath ?? location?.file ?? location?.path ?? fileHint);
		const comment: HunkComment = {
			id: stringOrUndefined(c.id ?? c.commentId ?? c.uuid),
			filePath,
			oldLine: firstFiniteNumber(c.oldLine, c.old_line, location?.oldLine, line?.old, oldRange),
			newLine: firstFiniteNumber(c.newLine, c.new_line, location?.newLine, line?.new, newRange),
			summary,
			rationale: stringOrUndefined(c.rationale ?? c.reason ?? c.detail ?? c.details ?? c.description),
			author: typeof c.author === "object" ? stringOrUndefined(c.author?.name ?? c.author?.id) : stringOrUndefined(c.author),
			type: stringOrUndefined(c.type ?? c.kind),
		};
		const dedupeKey = JSON.stringify([comment.id, comment.filePath, comment.oldLine, comment.newLine, comment.summary, comment.rationale]);
		if (seen.has(dedupeKey)) continue;
		seen.add(dedupeKey);
		out.push(comment);
	}

	return out.filter((c) => c.type === undefined || c.type === "user" || c.type === "live");
}

// ============================================================================
// Note shaping — pinned onto the patch a PatchSource says to use
// ============================================================================

function commentLocation(c: Pick<HunkComment, "oldLine" | "newLine">): string {
	if (c.newLine !== undefined && c.oldLine !== undefined) return `new:${c.newLine} / old:${c.oldLine}`;
	if (c.newLine !== undefined) return `new:${c.newLine}`;
	if (c.oldLine !== undefined) return `old:${c.oldLine}`;
	return "file";
}

function groupCommentsByFile(comments: HunkComment[], cwd: string): Map<string, HunkComment[]> {
	const grouped = new Map<string, HunkComment[]>();
	for (const comment of comments) {
		const file = displayPath(comment.filePath, cwd);
		const list = grouped.get(file) ?? [];
		list.push(comment);
		grouped.set(file, list);
	}
	return grouped;
}

function reviewNotesSignature(comments: HunkComment[], cwd: string): string {
	return JSON.stringify(
		comments.map((comment) => ({
			file: displayPath(comment.filePath, cwd),
			oldLine: comment.oldLine,
			newLine: comment.newLine,
			summary: comment.summary,
			rationale: comment.rationale,
		})),
	);
}

function buildReviewPrompt(comments: HunkComment[], cwd: string, shape?: ReviewNoteShape): string {
	const lines: string[] = ["Open Hunk review state (human-authored notes):"];
	let index = 1;
	if (shape?.hunks.length) {
		for (const hunk of shape.hunks) {
			lines.push(`\nFile: ${displayPath(hunk.filePath, cwd)}`);
			lines.push(`Hunk: ${hunk.header}`);
			for (const line of hunk.lines) {
				const loc = commentLocation(line.address);
				for (const comment of line.comments) {
					lines.push(`${index}. ${loc} — ${comment.summary}`);
					if (comment.rationale) lines.push(`   rationale: ${comment.rationale}`);
					if (comment.author) lines.push(`   author: ${comment.author}`);
					index++;
				}
			}
		}
	}
	const openComments = shape ? shape.openComments : comments;
	if (openComments.length) {
		const groups = groupCommentsByFile(openComments, cwd);
		for (const [file, fileComments] of groups) {
			lines.push(`\nFile: ${file}${shape ? " (no recent rendered hunk)" : ""}`);
			for (const comment of fileComments) {
				lines.push(`${index}. ${commentLocation(comment)} — ${comment.summary}`);
				if (comment.rationale) lines.push(`   rationale: ${comment.rationale}`);
				if (comment.author) lines.push(`   author: ${comment.author}`);
				index++;
			}
		}
	}
	lines.push("", "Address each note without rewriting or summarizing the user's words.");
	return lines.join("\n");
}

function parseEntryPatch(entry: PatchEntry): ParsedPatch {
	return parseUnifiedPatch(entry.patch);
}

function noteAddressInEntry(note: HunkComment, entry: PatchEntry, cwd: string, parsed = parseEntryPatch(entry)): PatchLineAddress | undefined {
	if (fileKey(note.filePath, cwd) !== fileKey(entry.filePath, cwd)) return undefined;
	return findPatchLineAddress(parsed, note, cwd);
}

function noteOverlapsEntry(note: HunkComment, entry: PatchEntry, cwd: string): boolean {
	return !!noteAddressInEntry(note, entry, cwd);
}

function sortedReviewHunks(hunks: ReviewNoteHunk[]): ReviewNoteHunk[] {
	return hunks
		.map((hunk) => ({ ...hunk, lines: [...hunk.lines].sort((a, b) => a.address.lineIndex - b.address.lineIndex) }))
		.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.hunkIndex - b.hunkIndex);
}

/** Shape notes by the rendered hunk row each one pins onto, using the patch a
 *  `PatchSource` supplies for the note's file. Pure + testable: pass any
 *  `findForFile` callback (an agent-edit source, a reviewed-patch source, or a
 *  test stub) and the shape is the same for the same patch. */
export function buildReviewNoteShape(comments: HunkComment[], findForFile: (filePath: string | undefined, cwd: string) => PatchEntry | undefined, cwd: string): ReviewNoteShape {
	const hunks = new Map<string, ReviewNoteHunk>();
	const lineMaps = new Map<string, Map<string, ReviewNoteLine>>();
	const parsedCache = new Map<PatchEntry, ParsedPatch>();
	const openComments: HunkComment[] = [];
	const parsedFor = (entry: PatchEntry) => {
		let parsed = parsedCache.get(entry);
		if (!parsed) {
			parsed = parseEntryPatch(entry);
			parsedCache.set(entry, parsed);
		}
		return parsed;
	};

	for (const comment of comments) {
		const entry = findForFile(comment.filePath, cwd);
		if (!entry) {
			openComments.push(comment);
			continue;
		}
		const parsed = parsedFor(entry);
		const address = noteAddressInEntry(comment, entry, cwd, parsed);
		const parsedHunk = address ? parsed.hunks[address.hunkIndex] : undefined;
		if (!address || !parsedHunk) {
			openComments.push(comment);
			continue;
		}
		const hunkKey = `${fileKey(entry.filePath, cwd)}:${address.hunkIndex}`;
		let hunk = hunks.get(hunkKey);
		if (!hunk) {
			hunk = { filePath: entry.filePath, summary: entry.summary, hunkIndex: address.hunkIndex, header: parsedHunk.header, lines: [] };
			hunks.set(hunkKey, hunk);
			lineMaps.set(hunkKey, new Map());
		}
		const lineKey = patchLineAddressKey(address);
		const lineMap = lineMaps.get(hunkKey)!;
		let line = lineMap.get(lineKey);
		if (!line) {
			line = { lineKey, address, comments: [] };
			lineMap.set(lineKey, line);
			hunk.lines.push(line);
		}
		line.comments.push(comment);
	}

	return { hunks: sortedReviewHunks([...hunks.values()]), openComments };
}

/** Build inline diff-line annotations for a single patch entry's notes. */
export function reviewAnnotationsForRecord(comments: HunkComment[], entry: PatchEntry, cwd: string): DiffLineAnnotations {
	const parsed = parseEntryPatch(entry);
	const annotations = new Map<string, Array<{ text: string; detail?: string; author?: string; label?: string }>>();
	for (const comment of comments) {
		const address = noteAddressInEntry(comment, entry, cwd, parsed);
		if (!address) continue;
		const key = patchLineAddressKey(address);
		const list = annotations.get(key) ?? [];
		list.push({ text: comment.summary, detail: comment.rationale, author: comment.author, label: "note" });
		annotations.set(key, list);
	}
	return annotations;
}

/** Filter notes to those overlapping any patch the source supplies. Pure + testable. */
export function notesRelevantToRecords(notes: HunkComment[], findForFile: (filePath: string | undefined, cwd: string) => PatchEntry | undefined, cwd: string): HunkComment[] {
	return notes.filter((note) => {
		const entry = findForFile(note.filePath, cwd);
		return entry ? noteOverlapsEntry(note, entry, cwd) : false;
	});
}

// ============================================================================
// ReviewBridge — live session → semantic notes, with pickup/dedup policy
// ============================================================================

export interface ReviewBridge {
	/** Probe for a live Hunk session, returning the raw session (or undefined). */
	probeSession(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<any | undefined>;
	/** Read notes once. Does not track dedup state. */
	readNotes(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<ReviewNotesResult>;
	/**
	 * Read notes and, if a new relevant review state exists, mark it for injection.
	 * Returns the result plus whether it should inject. Duplicate unchanged states
	 * are not re-injected.
	 */
	pickup(cwd: string, config: HunkConfig, signal?: AbortSignal): Promise<{ result: ReviewNotesResult; inject: boolean }>;
	/** Forget the last-seen signature (e.g. after `/hunk off`). */
	resetSignature(): void;
	/** Render notes through the shared visual language. The bridge's patch source
	 *  supplies the patch to pin each note onto; nothing is threaded by the caller. */
	renderNotesLines(result: ReviewNotesResult | undefined, cwd: string, theme: Theme, config: HunkConfig, highlighter: Highlighter | undefined): string[];
	/** Render read-only review state for the human-facing `/hunk review` view. */
	renderReviewLines(result: ReviewNotesResult | undefined, cwd: string, theme: Theme): string[];
}

/** Build a review bridge over one `PatchSource`. The source is wired once here;
 *  every correlation and render path asks it for the patch to pin against, so
 *  `findRecent` is no longer threaded through each call site. Refreshable sources
 *  (the reviewed-patch composite) are refreshed while a live session is held. */
export function createHunkBridge(patchSource: PatchSource): ReviewBridge {
	let lastSignature = "";
	const findForFile = (filePath: string | undefined, cwd: string): PatchEntry | undefined => patchSource.findForFile(filePath, cwd);

	return {
		probeSession(cwd, config, signal) {
			if (!config.hunk.enabled) return Promise.resolve(undefined);
			return runHunkJson(cwd, ["session", "get", "--repo", cwd, "--json"], config, 5_000, signal);
		},

		async readNotes(cwd, config, signal) {
			const session = await this.probeSession(cwd, config, signal);
			if (!session) {
				return {
					live: false,
					comments: [],
					message: `No live Hunk session is attached to ${cwd}. Open another terminal in this repo and run: hunk diff --watch`,
				};
			}
			// Refresh the reviewed-patch cache while we already hold a live session,
			// so correlation pins against the patch the human is actually reviewing.
			// A plain agent-edit source is not refreshable and this is a no-op.
			await refreshPatchSource(patchSource, cwd, config, signal);
			const commentsPayload = await runHunkJson(cwd, ["session", "comment", "list", "--repo", cwd, "--type", "user", "--json"], config, 20_000, signal);
			if (!commentsPayload) {
				return { live: true, session, comments: [], message: "Live Hunk session found, but no user comments were returned." };
			}
			const comments = normalizeHunkComments(commentsPayload);
			const shape = buildReviewNoteShape(comments, findForFile, cwd);
			return {
				live: true,
				session,
				comments,
				hunks: shape.hunks,
				openComments: shape.openComments,
				message: comments.length ? buildReviewPrompt(comments, cwd, shape) : "Live Hunk session found. No user Hunk comments are open.",
			};
		},

		async pickup(cwd, config, signal) {
			const result = await this.readNotes(cwd, config, signal);
			if (!config.hunk.autoReviewNotes || !result.live) return { result, inject: false };
			// Scope to notes that overlap a patch the source supplies, so notes about
			// untouched files never trigger pickup on their own.
			const relevant = notesRelevantToRecords(result.comments, findForFile, cwd);
			const shape = buildReviewNoteShape(relevant, findForFile, cwd);
			const scoped: ReviewNotesResult = relevant.length === result.comments.length ? result : { ...result, comments: relevant, hunks: shape.hunks, openComments: shape.openComments, message: buildReviewPrompt(relevant, cwd, shape) };
			if (relevant.length < 1) return { result: scoped, inject: false };
			const signature = reviewNotesSignature(scoped.comments, cwd);
			if (signature === lastSignature) return { result: scoped, inject: false };
			lastSignature = signature;
			return { result: scoped, inject: true };
		},

		resetSignature() {
			lastSignature = "";
		},

		renderNotesLines(result, cwd, theme, config, highlighter) {
			const lines: string[] = [];
			lines.push(`${theme.fg("accent", "✦")} ${theme.fg("borderMuted", "╭─")} ${theme.fg("toolTitle", theme.bold("Hunk review notes"))}`);
			if (!result) {
				lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("muted", "No result details available.")}`);
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
				return lines;
			}
			const shape = buildReviewNoteShape(result.comments, findForFile, cwd);
			const touched = shape.hunks.reduce((count, hunk) => count + hunk.lines.reduce((inner, line) => inner + line.comments.length, 0), 0);
			const status = result.live ? `${result.comments.length} user note${result.comments.length === 1 ? "" : "s"} · ${touched} pinned` : "no live session";
			lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg(result.live ? "toolDiffAdded" : "warning", status)}`);
			lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
			if (!result.live || !result.comments.length) {
				lines.push(theme.fg("muted", result.message));
				return lines;
			}
			const configNoFooter = { ...config, showHunkHint: false };
			const renderedRecords = new Set<string>();
			for (const hunk of shape.hunks) {
				const record = findForFile(hunk.filePath, cwd);
				const recordKey = record ? `${fileKey(record.filePath, cwd)}\0${record.patch}` : undefined;
				if (!record || !recordKey || renderedRecords.has(recordKey)) continue;
				renderedRecords.add(recordKey);
				const recordComments = result.comments.filter((comment) => {
					const commentRecord = findForFile(comment.filePath, cwd);
					return commentRecord ? `${fileKey(commentRecord.filePath, cwd)}\0${commentRecord.patch}` === recordKey : false;
				});
				const annotations = reviewAnnotationsForRecord(recordComments, record, cwd);
				lines.push(...renderDiffLines({ patch: record.patch, filePath: record.filePath, cwd, title: "review notes", config: configNoFooter, highlighter, theme, annotations }));
			}
			if (shape.openComments.length) {
				lines.push(`${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "notes without recent hunk")}`);
				let index = 1;
				for (const [file, comments] of groupCommentsByFile(shape.openComments, cwd)) {
					lines.push(`${theme.fg("dim", "file")} ${theme.fg("muted", file)}`);
					for (const comment of comments) {
						lines.push(`${theme.fg("warning", "○ open")} ${theme.fg("dim", String(index).padStart(2, " "))}. ${theme.fg("toolTitle", commentLocation(comment))} ${theme.fg("dim", "—")} ${comment.summary}`);
						if (comment.rationale) lines.push(`   ${theme.fg("dim", "rationale:")} ${comment.rationale}`);
						index++;
					}
				}
			}
			return lines;
		},

		renderReviewLines(result, cwd, theme) {
			const lines: string[] = [];
			lines.push(`${theme.fg("accent", "✦")} ${theme.fg("borderMuted", "╭─")} ${theme.fg("toolTitle", theme.bold("Hunk review"))}`);
			if (!result) {
				lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("muted", "No result details available.")}`);
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
				return lines;
			}
			if (!result.live) {
				lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("warning", "no live session")}`);
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
				lines.push(theme.fg("muted", result.message));
				return lines;
			}
			if (!result.comments.length) {
				lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("muted", "no user notes")}`);
				lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
				return lines;
			}
			const shape = buildReviewNoteShape(result.comments, findForFile, cwd);
			const touched = shape.hunks.reduce((count, hunk) => count + hunk.lines.reduce((inner, line) => inner + line.comments.length, 0), 0);
			const open = shape.openComments.length;
			lines.push(`${theme.fg("borderMuted", "│")} ${theme.fg("toolDiffAdded", `${touched} touched`)} ${theme.fg("dim", "·")} ${theme.fg("warning", `${open} open`)}`);
			lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
			let index = 1;
			for (const hunk of shape.hunks) {
				lines.push(`${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "notes")} ${theme.fg("dim", "·")} ${theme.fg("muted", `${displayPath(hunk.filePath, cwd)} ${hunk.header}`)}`);
				for (const line of hunk.lines) {
					for (const comment of line.comments) {
						lines.push(`${theme.fg("dim", String(index).padStart(2, " "))}. ${theme.fg("toolDiffAdded", "✓ touched")} ${theme.fg("toolTitle", commentLocation(line.address))} ${theme.fg("dim", "—")} ${comment.summary}`);
						if (comment.rationale) lines.push(`   ${theme.fg("dim", "rationale:")} ${comment.rationale}`);
						index++;
					}
				}
			}
			if (shape.openComments.length) {
				for (const [file, comments] of groupCommentsByFile(shape.openComments, cwd)) {
					lines.push(`${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "open notes")} ${theme.fg("dim", "·")} ${theme.fg("muted", file)}`);
					for (const comment of comments) {
						lines.push(`${theme.fg("dim", String(index).padStart(2, " "))}. ${theme.fg("warning", "○ open")} ${theme.fg("toolTitle", commentLocation(comment))} ${theme.fg("dim", "—")} ${comment.summary}`);
						if (comment.rationale) lines.push(`   ${theme.fg("dim", "rationale:")} ${comment.rationale}`);
						index++;
					}
				}
			}
			return lines;
		},
	};
}

export function stringOr(value: unknown): string | undefined {
	return stringOrUndefined(value);
}
