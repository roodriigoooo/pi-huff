import { getLanguageFromPath, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createTwoFilesPatch, diffWordsWithSpace } from "diff";
import { type HighlighterGeneric } from "shiki";
import {
	ansiFg,
	type DiffSide,
	displayTheme,
	type HunkConfig,
	gutterColor,
	resolvePalette,
	tintBgAnsi,
	TOKENIZE_MAX_LINE_LENGTH,
	TOKENIZE_TIME_LIMIT_MS,
	type WordHighlight,
} from "./config";
import { displayPath, fileKey } from "./paths";

export type Highlighter = HighlighterGeneric<string, string>;

// ============================================================================
// Patch model (single source of truth for renderer + bridge correlation)
// ============================================================================

export type Range = { start: number; end: number };

export type DiffLine = {
	kind: "add" | "remove" | "context" | "meta";
	text: string;
	oldLine?: number;
	newLine?: number;
	removeRanges?: Range[];
	addRanges?: Range[];
};

export type ParsedHunk = {
	header: string;
	oldStart: number;
	newStart: number;
	lines: DiffLine[];
};

export type ParsedPatch = {
	oldFile?: string;
	newFile?: string;
	hunks: ParsedHunk[];
};

export type PatchLineLocation = {
	filePath?: string;
	oldLine?: number;
	newLine?: number;
};

export type PatchLineAddress = {
	hunkIndex: number;
	lineIndex: number;
	kind: DiffLine["kind"];
	oldLine?: number;
	newLine?: number;
};

export type DiffLineAnnotation = {
	text: string;
	detail?: string;
	author?: string;
	label?: string;
};

export type DiffLineAnnotations = ReadonlyMap<string, readonly DiffLineAnnotation[]>;

export function patchLineAddressKey(address: Pick<PatchLineAddress, "hunkIndex" | "lineIndex">): string {
	return `${address.hunkIndex}:${address.lineIndex}`;
}

function patchMatchesFile(parsed: ParsedPatch, filePath: string | undefined, cwd: string | undefined): boolean {
	if (!filePath || !cwd) return true;
	const target = fileKey(filePath, cwd);
	return [parsed.newFile, parsed.oldFile].some((patchFile) => fileKey(patchFile, cwd) === target);
}

export function findPatchLineAddress(parsed: ParsedPatch, location: PatchLineLocation, cwd?: string): PatchLineAddress | undefined {
	if (!patchMatchesFile(parsed, location.filePath, cwd)) return undefined;
	const findBy = (side: "newLine" | "oldLine") => {
		const target = location[side];
		if (target === undefined) return undefined;
		for (let hunkIndex = 0; hunkIndex < parsed.hunks.length; hunkIndex++) {
			const hunk = parsed.hunks[hunkIndex];
			for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex++) {
				const line = hunk.lines[lineIndex];
				if (line[side] !== target) continue;
				return { hunkIndex, lineIndex, kind: line.kind, oldLine: line.oldLine, newLine: line.newLine } satisfies PatchLineAddress;
			}
		}
		return undefined;
	};
	return findBy("newLine") ?? findBy("oldLine");
}

function parseFileHeader(raw: string): string {
	return raw.slice(4).trim().replace(/\t.*$/, "");
}

function parseHunkHeader(header: string): { oldStart: number; newStart: number } | undefined {
	const m = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(header);
	if (!m) return undefined;
	return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

function wordRanges(oldText: string, newText: string): { oldRanges: Range[]; newRanges: Range[] } {
	let oldIndex = 0;
	let newIndex = 0;
	const oldRanges: Range[] = [];
	const newRanges: Range[] = [];
	for (const part of diffWordsWithSpace(oldText, newText)) {
		const len = part.value.length;
		if (part.removed) {
			oldRanges.push({ start: oldIndex, end: oldIndex + len });
			oldIndex += len;
		} else if (part.added) {
			newRanges.push({ start: newIndex, end: newIndex + len });
			newIndex += len;
		} else {
			oldIndex += len;
			newIndex += len;
		}
	}
	return { oldRanges, newRanges };
}

function emphasizeChangeBlocks(lines: DiffLine[]): void {
	let i = 0;
	while (i < lines.length) {
		if (lines[i].kind !== "remove" && lines[i].kind !== "add") {
			i++;
			continue;
		}
		const start = i;
		while (i < lines.length && (lines[i].kind === "remove" || lines[i].kind === "add")) i++;
		const block = lines.slice(start, i);
		const removed = block.filter((l) => l.kind === "remove");
		const added = block.filter((l) => l.kind === "add");
		const pairCount = Math.min(removed.length, added.length);
		for (let j = 0; j < pairCount; j++) {
			const ranges = wordRanges(removed[j].text, added[j].text);
			removed[j].removeRanges = ranges.oldRanges;
			added[j].addRanges = ranges.newRanges;
		}
		for (let j = pairCount; j < removed.length; j++) removed[j].removeRanges = [{ start: 0, end: removed[j].text.length }];
		for (let j = pairCount; j < added.length; j++) added[j].addRanges = [{ start: 0, end: added[j].text.length }];
	}
}

/** Parse a unified diff patch into hunks with word-level emphasis ranges. */
export function parseUnifiedPatch(patch: string): ParsedPatch {
	const parsed: ParsedPatch = { hunks: [] };
	let current: ParsedHunk | undefined;
	let oldLine = 0;
	let newLine = 0;

	const rawLines = patch.split("\n");
	if (rawLines[rawLines.length - 1] === "") rawLines.pop();

	for (const raw of rawLines) {
		if (raw.startsWith("--- ")) {
			parsed.oldFile = parseFileHeader(raw);
			continue;
		}
		if (raw.startsWith("+++ ")) {
			parsed.newFile = parseFileHeader(raw);
			continue;
		}
		if (raw.startsWith("@@")) {
			const h = parseHunkHeader(raw) ?? { oldStart: 0, newStart: 0 };
			current = { header: raw, oldStart: h.oldStart, newStart: h.newStart, lines: [] };
			parsed.hunks.push(current);
			oldLine = h.oldStart;
			newLine = h.newStart;
			continue;
		}
		if (!current) continue;
		if (raw.startsWith("\\")) {
			current.lines.push({ kind: "meta", text: raw });
			continue;
		}
		const prefix = raw[0];
		const text = raw.slice(1);
		if (prefix === "+") {
			current.lines.push({ kind: "add", text, newLine });
			newLine++;
		} else if (prefix === "-") {
			current.lines.push({ kind: "remove", text, oldLine });
			oldLine++;
		} else {
			current.lines.push({ kind: "context", text, oldLine, newLine });
			oldLine++;
			newLine++;
		}
	}
	for (const hunk of parsed.hunks) emphasizeChangeBlocks(hunk.lines);
	return parsed;
}

function countStats(parsed: ParsedPatch): { added: number; removed: number; files: number; hunks: number } {
	let added = 0;
	let removed = 0;
	for (const h of parsed.hunks) {
		for (const l of h.lines) {
			if (l.kind === "add") added++;
			else if (l.kind === "remove") removed++;
		}
	}
	return { added, removed, files: 1, hunks: parsed.hunks.length };
}

function filteredHunkLines(hunk: ParsedHunk, config: HunkConfig, hunkIndex = 0, annotatedLineKeys?: ReadonlySet<string>): Array<DiffLine | { kind: "skip"; count: number }> {
	if (!config.compactUnchanged) return hunk.lines;
	const changed = new Set<number>();
	for (let i = 0; i < hunk.lines.length; i++) {
		if (hunk.lines[i].kind === "add" || hunk.lines[i].kind === "remove") {
			for (let j = Math.max(0, i - config.contextRadius); j <= Math.min(hunk.lines.length - 1, i + config.contextRadius); j++) changed.add(j);
		}
		if (annotatedLineKeys?.has(patchLineAddressKey({ hunkIndex, lineIndex: i }))) changed.add(i);
	}
	const out: Array<DiffLine | { kind: "skip"; count: number }> = [];
	let skipped = 0;
	for (let i = 0; i < hunk.lines.length; i++) {
		if (changed.has(i)) {
			if (skipped) out.push({ kind: "skip", count: skipped });
			skipped = 0;
			out.push(hunk.lines[i]);
		} else {
			skipped++;
		}
	}
	if (skipped) out.push({ kind: "skip", count: skipped });
	return out;
}

// ============================================================================
// Hunk tokenization — whole-side, grammar state carried across lines
// ============================================================================

type ShikiTokenLine = ReturnType<Highlighter["codeToTokensBase"]>[number];

const lazyLanguageLoads = new WeakMap<Highlighter, Set<string>>();
const lazyLanguageFailures = new WeakMap<Highlighter, Set<string>>();

function isSpecialLanguage(lang: string): boolean {
	return lang === "text" || lang === "plain" || lang === "ansi";
}

function loadedLanguageName(highlighter: Highlighter, lang: string): string | undefined {
	if (isSpecialLanguage(lang)) return lang;
	const loaded = typeof highlighter.getLoadedLanguages === "function" ? highlighter.getLoadedLanguages() : undefined;
	if (!loaded) return lang;
	if (loaded.includes(lang)) return lang;
	try {
		const resolved = highlighter.resolveLangAlias(lang);
		return loaded.includes(resolved) ? resolved : undefined;
	} catch {
		return undefined;
	}
}

function scheduleLazyLanguageLoad(highlighter: Highlighter, lang: string, invalidate?: () => void): void {
	if (isSpecialLanguage(lang) || typeof highlighter.loadLanguage !== "function") return;
	if (loadedLanguageName(highlighter, lang)) return;
	let failed = lazyLanguageFailures.get(highlighter);
	if (failed?.has(lang)) return;
	let loading = lazyLanguageLoads.get(highlighter);
	if (!loading) {
		loading = new Set();
		lazyLanguageLoads.set(highlighter, loading);
	}
	if (loading.has(lang)) return;
	loading.add(lang);
	void highlighter
		.loadLanguage(lang)
		.then(() => invalidate?.())
		.catch(() => {
			failed = lazyLanguageFailures.get(highlighter);
			if (!failed) {
				failed = new Set();
				lazyLanguageFailures.set(highlighter, failed);
			}
			failed.add(lang);
		})
		.finally(() => loading?.delete(lang));
}

function hunkHasTooLongLine(hunk: ParsedHunk): boolean {
	return hunk.lines.some((line) => line.text.length > TOKENIZE_MAX_LINE_LENGTH);
}

/** Tokenize each side of a hunk as one string so multi-line constructs (template
 *  literals, block comments, JSX, triple-quoted strings) keep their grammar
 *  state across continuation lines. Returns undefined when there is no
 *  highlighter or tokenization fails; the renderer then falls back to plain. */
function tokenizeHunkSides(
	hunk: ParsedHunk,
	highlighter: Highlighter | undefined,
	lang: string,
	shikiTheme: string,
	invalidate?: () => void,
): { oldTokens: ShikiTokenLine[]; newTokens: ShikiTokenLine[] } | undefined {
	if (!highlighter) return undefined;
	if (hunkHasTooLongLine(hunk)) return undefined;
	if (!loadedLanguageName(highlighter, lang)) {
		scheduleLazyLanguageLoad(highlighter, lang, invalidate);
		return undefined;
	}
	try {
		const oldLines: string[] = [];
		const newLines: string[] = [];
		for (const line of hunk.lines) {
			if (line.kind === "context") {
				oldLines.push(line.text);
				newLines.push(line.text);
			} else if (line.kind === "remove") {
				oldLines.push(line.text);
			} else if (line.kind === "add") {
				newLines.push(line.text);
			}
		}
		const tokenOptions = { lang, theme: shikiTheme, tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH, tokenizeTimeLimit: TOKENIZE_TIME_LIMIT_MS };
		const oldTokens = highlighter.codeToTokensBase(oldLines.join("\n") || " ", tokenOptions);
		const newTokens = highlighter.codeToTokensBase(newLines.join("\n") || " ", tokenOptions);
		return { oldTokens, newTokens };
	} catch {
		return undefined;
	}
}

/** Pick the pre-tokenized token line for a rendered diff line.
 *  Remove lines index into the old side; add and context into the new side
 *  (context is identical text; the new side matches the file's final form). */
function tokensForLine(
	line: DiffLine,
	hunk: ParsedHunk,
	sides: { oldTokens: ShikiTokenLine[]; newTokens: ShikiTokenLine[] } | undefined,
): ShikiTokenLine | undefined {
	if (!sides) return undefined;
	if (line.kind === "remove") {
		const idx = line.oldLine !== undefined ? line.oldLine - hunk.oldStart : -1;
		return idx >= 0 && idx < sides.oldTokens.length ? sides.oldTokens[idx] : undefined;
	}
	const idx = line.newLine !== undefined ? line.newLine - hunk.newStart : -1;
	return idx >= 0 && idx < sides.newTokens.length ? sides.newTokens[idx] : undefined;
}

// ============================================================================
// Token styling
// ============================================================================

const ANSI_RESET = "\x1b[0m";

function visibleSlice(input: string, width: number): string {
	if (visibleWidth(input) <= width) return input;
	return truncateToWidth(input, Math.max(0, width - 1)) + "…";
}

function wordHighlightAnsi(style: WordHighlight, side: DiffSide, theme: Theme): string {
	if (style === "none") return "";
	if (style === "bold") return "\x1b[1m";
	if (style === "underline") return "\x1b[1;4m";
	if (style === "inverse") return "\x1b[1;7m";
	if (style === "strike") return side === "remove" ? "\x1b[1;9m" : "\x1b[1;4m";
	if (style === "color") return side === "add" ? theme.getFgAnsi("accent") || "" : theme.getFgAnsi("warning") || theme.getFgAnsi("error") || "";
	return "";
}

function inRanges(index: number, ranges: Range[]): boolean {
	return ranges.some((r) => index >= r.start && index < r.end);
}

function styleToken(text: string, color: string | undefined, emph: boolean, side: DiffSide, config: HunkConfig, theme: Theme, sideAnsi: string): string {
	let start = ansiFg(color);
	if (emph) start += wordHighlightAnsi(config.wordHighlight, side, theme);
	if (!start) return text;
	return `${start}${text}${ANSI_RESET}${sideAnsi}`;
}

function renderCodeLine(
	line: string,
	tokens: ShikiTokenLine | undefined,
	theme: Theme,
	config: HunkConfig,
	side: DiffSide,
	ranges: Range[],
	sideAnsi: string,
): string {
	if (!tokens) return sideAnsi + line + ANSI_RESET;
	try {
		let out = sideAnsi;
		let cursor = 0;
		for (const token of tokens) {
			const content = token.content;
			for (const ch of content) {
				const emph = inRanges(cursor, ranges);
				out += styleToken(ch, token.color, emph, side, config, theme, sideAnsi);
				cursor += ch.length;
			}
		}
		return out + ANSI_RESET;
	} catch {
		return sideAnsi + line + ANSI_RESET;
	}
}

// ============================================================================
// Line furniture
// ============================================================================

function lineNoText(line: DiffLine, palette: { lineNo: string }, mode: HunkConfig["lineNumbers"]): string {
	const isChanged = line.kind === "add" || line.kind === "remove";
	if (mode === "changed" && !isChanged) return "     ";
	const old = line.oldLine === undefined ? "    " : String(line.oldLine).padStart(4, " ");
	const neu = line.newLine === undefined ? "    " : String(line.newLine).padStart(4, " ");
	return `${palette.lineNo}${old}${ANSI_RESET} ${palette.lineNo}${neu}${ANSI_RESET}`;
}

function hunkCaption(hunk: ParsedHunk, filePath: string, cwd: string, theme: Theme): string {
	const loc = `${displayPath(filePath, cwd)}:${hunk.newStart || hunk.oldStart || "?"}`;
	return `${theme.fg("accent", "@@")} ${theme.fg("toolTitle", "hunk")} ${theme.fg("dim", "·")} ${theme.fg("muted", loc)}`;
}

function hunkFooter(config: HunkConfig, theme: Theme, hasLiveSession: boolean): string[] {
	if (!config.showHunkHint || !config.hunk.enabled || !hasLiveSession) return [];
	const toolHint = config.hunk.reviewTool ? ` ${theme.fg("dim", "·")} ${theme.fg("muted", "hunk_review_notes")}` : "";
	return [`${theme.fg("accent", "Hunk ✦")} ${theme.fg("muted", "/hunk review")} opens review state ${theme.fg("dim", "·")} ${theme.fg("muted", "/hunk send")} attaches it${toolHint}`];
}

function annotationText(annotation: DiffLineAnnotation): string {
	const text = annotation.text.replace(/\s+/g, " ").trim();
	const detail = annotation.detail?.replace(/\s+/g, " ").trim();
	const author = annotation.author?.replace(/\s+/g, " ").trim();
	return `${author ? `${author}: ` : ""}${text}${detail ? ` (${detail})` : ""}`;
}

function renderLineAnnotations(annotations: readonly DiffLineAnnotation[] | undefined, theme: Theme): string {
	if (!annotations?.length) return "";
	const label = annotations[0].label ?? "note";
	const body = annotations.map(annotationText).join(theme.fg("dim", " · "));
	return ` ${theme.fg("dim", "│")} ${theme.fg("accent", label)} ${body}`;
}

// ============================================================================
// DiffView — config + patch + theme + highlighter → rendered lines
// ============================================================================

export type DiffViewInput = {
	patch: string;
	filePath: string;
	cwd: string;
	title: string;
	config: HunkConfig;
	highlighter: Highlighter | undefined;
	theme: Theme;
	liveSession?: boolean;
	annotations?: DiffLineAnnotations;
	invalidate?: () => void;
};

export function renderDiffLines(input: DiffViewInput): string[] {
	const { patch, filePath, cwd, title, config, highlighter, theme, liveSession, annotations, invalidate } = input;
	const parsed = parseUnifiedPatch(patch);
	const stats = countStats(parsed);
	const lang = getLanguageFromPath(filePath) ?? "text";
	const shikiTheme = displayTheme(config, theme);
	const palette = resolvePalette(config, theme);
	const symbols = config.symbols;
	const lines: string[] = [];
	const accent = theme.fg("accent", "✦");
	const headerColor = palette.header;
	const pathLabel = `${headerColor}${theme.bold(displayPath(filePath, cwd))}${ANSI_RESET}`;
	const statsLabel = `${palette.add}+${stats.added}${ANSI_RESET} ${palette.remove}-${stats.removed}${ANSI_RESET} ${theme.fg("muted", `${stats.hunks} hunk${stats.hunks === 1 ? "" : "s"}`)}`;

	if (config.header === "minimal") {
		lines.push(`${accent} ${pathLabel}`);
	} else if (config.header === "compact") {
		lines.push(`${accent} ${headerColor}${theme.bold(title)}${ANSI_RESET} ${theme.fg("dim", "·")} ${pathLabel}  ${statsLabel}`);
	} else {
		lines.push(`${accent} ${theme.fg("borderMuted", "╭─")} ${headerColor}${theme.bold(title)}${ANSI_RESET} ${theme.fg("dim", "·")} ${pathLabel}`);
		lines.push(`${theme.fg("borderMuted", "│")} ${statsLabel}`);
		lines.push(theme.fg("borderMuted", "╰" + "─".repeat(32)));
	}

	const lineNoMode = config.lineNumbers;
	const isChanged = (item: DiffLine) => item.kind === "add" || item.kind === "remove";

	const annotatedLineKeys = annotations ? new Set(annotations.keys()) : undefined;
	let rendered = 0;
	let truncated = false;
	for (let hunkIndex = 0; hunkIndex < parsed.hunks.length; hunkIndex++) {
		const hunk = parsed.hunks[hunkIndex];
		if (rendered >= config.maxRenderedLines) {
			truncated = true;
			break;
		}
		const sides = tokenizeHunkSides(hunk, highlighter, lang, shikiTheme, invalidate);
		lines.push(hunkCaption(hunk, filePath, cwd, theme));
		rendered++;
		for (const item of filteredHunkLines(hunk, config, hunkIndex, annotatedLineKeys)) {
			if (rendered >= config.maxRenderedLines) {
				truncated = true;
				break;
			}
			if (item.kind === "skip") {
				lines.push(`${palette.meta}   ${symbols.fold} ${item.count} unchanged line${item.count === 1 ? "" : "s"}${ANSI_RESET}`);
				rendered++;
				continue;
			}
			if (item.kind === "meta") {
				lines.push(`${palette.meta}     ${item.text}${ANSI_RESET}`);
				rendered++;
				continue;
			}
			const side: DiffSide = item.kind === "add" ? "add" : item.kind === "remove" ? "remove" : "context";
			const sideAnsi = side === "add" ? palette.add : side === "remove" ? palette.remove : palette.context;
			const sign = item.kind === "add" ? symbols.add : item.kind === "remove" ? symbols.remove : symbols.context;
			const signStyled = `${sideAnsi}${sign}${ANSI_RESET}`;
			const changed = isChanged(item);
			let marker = " ";
			if (changed) {
				if (config.lineHighlight === "bar") marker = `${gutterColor(config, side, theme)}${"│"}${ANSI_RESET}`;
				else if (config.lineHighlight === "gutter") marker = `${gutterColor(config, side, theme)}${symbols.gutter}${ANSI_RESET}`;
			}
			const nums = lineNoMode ? lineNoText(item, palette, lineNoMode) + " " : "";
			const ranges = config.wordHighlight !== "none" ? (item.kind === "add" ? item.addRanges ?? [] : item.kind === "remove" ? item.removeRanges ?? [] : []) : [];
			const lineAnsi = changed && config.lineHighlight === "tint" ? `${tintBgAnsi(side)}${sideAnsi}` : sideAnsi;
			const tokens = tokensForLine(item, hunk, sides);
			const code = renderCodeLine(item.text, tokens, theme, config, side, ranges, lineAnsi);
			const lineIndex = hunk.lines.indexOf(item);
			const noteMargin = lineIndex >= 0 ? renderLineAnnotations(annotations?.get(patchLineAddressKey({ hunkIndex, lineIndex })), theme) : "";
			lines.push(`${marker} ${nums}${signStyled} ${code}${noteMargin}`);
			rendered++;
		}
		if (truncated) break;
	}

	if (truncated) lines.push(`${palette.meta}… truncated after ${config.maxRenderedLines} rendered diff rows${ANSI_RESET}`);
	const footer = hunkFooter(config, theme, !!liveSession);
	if (footer.length) {
		lines.push(theme.fg("borderMuted", "─".repeat(24)));
		lines.push(...footer);
	}
	return lines;
}

/** Width-cached component wrapping a line producer. */
export class DiffComponent implements Component {
	private cachedWidth?: number;
	private cachedLines?: string[];
	constructor(private readonly getLines: () => string[]) {}
	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		this.cachedWidth = width;
		this.cachedLines = this.getLines().map((line) => visibleSlice(line, Math.max(20, width)));
		return this.cachedLines;
	}
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Build a renderable DiffComponent from a patch + render context. */
export function createDiffView(input: DiffViewInput): DiffComponent {
	return new DiffComponent(() => renderDiffLines(input));
}

/** Build a unified patch from before/after text (the write tool's patch source). */
export function writePatch(oldFile: string, newFile: string, oldText: string, newText: string): string {
	return createTwoFilesPatch(oldFile, newFile, oldText, newText, "before", "after", { context: 9999 });
}
