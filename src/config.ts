import type { Theme } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// ============================================================================
// Types
// ============================================================================

export type EmphStyle = "none" | "auto" | "underline" | "inverse" | "strikethrough" | "bold";

export type WordHighlight = "none" | "bold" | "underline" | "inverse" | "strike" | "color";
export type LineHighlight = "none" | "gutter" | "bar" | "tint";
export type HeaderStyle = "compact" | "box" | "minimal";
export type LineNumbersMode = false | true | "changed";
export type ColorRef = string;

export type ColorSlots = {
	add: ColorRef;
	remove: ColorRef;
	context: ColorRef;
	meta: ColorRef;
	header: ColorRef;
	gutter: ColorRef;
	lineNo: ColorRef;
};

export type SymbolSlots = {
	add: string;
	remove: string;
	context: string;
	fold: string;
	gutter: string;
};

/** Resolved ANSI foreground strings, ready to emit. */
export type Palette = { add: string; remove: string; context: string; meta: string; header: string; lineNo: string };

export type HunkConfig = {
	enabled: boolean;
	diffTheme: "auto" | "dark" | "light";
	shikiDarkTheme: string;
	shikiLightTheme: string;
	maxRenderedLines: number;
	contextRadius: number;
	lineNumbers: LineNumbersMode;
	compactUnchanged: boolean;
	/** Legacy fields, migrated to wordHighlight by normalizeConfig. */
	wordHighlights?: boolean;
	emphStyle?: EmphStyle;
	wordHighlight: WordHighlight;
	lineHighlight: LineHighlight;
	header: HeaderStyle;
	colors: ColorSlots;
	symbols: SymbolSlots;
	showHunkHint: boolean;
	hunk: {
		enabled: boolean;
		binary: string;
		reviewTool: boolean;
		autoReviewNotes: boolean;
		/** Legacy count gate retained for config compatibility; pickup now uses any relevant note. */
		autoReviewNotesMin: number;
	};
};

// ============================================================================
// Defaults and value menus
// ============================================================================

export const COLOR_ALIASES: Record<string, string> = {
	auto: "",
	green: "toolDiffAdded",
	red: "toolDiffRemoved",
	gray: "toolDiffContext",
	dim: "dim",
	muted: "muted",
	accent: "accent",
	title: "toolTitle",
	warning: "warning",
	error: "error",
};

export const DEFAULT_COLORS: ColorSlots = {
	add: "auto",
	remove: "auto",
	context: "auto",
	meta: "dim",
	header: "title",
	gutter: "auto",
	lineNo: "dim",
};

export const DEFAULT_SYMBOLS: SymbolSlots = {
	add: "+",
	remove: "−",
	context: " ",
	fold: "⋯",
	gutter: "▎",
};

export const TOKENIZE_MAX_LINE_LENGTH = 2000;
export const TOKENIZE_TIME_LIMIT_MS = 500;

export const WORD_HIGHLIGHT_VALUES: WordHighlight[] = ["bold", "none", "underline", "inverse", "strike", "color"];
export const LINE_HIGHLIGHT_VALUES: LineHighlight[] = ["gutter", "bar", "tint", "none"];
export const HEADER_VALUES: HeaderStyle[] = ["box", "compact", "minimal"];
export const LINE_NUMBERS_VALUES: string[] = ["true", "false", "changed"];
export const COLOR_VALUES: string[] = ["auto", "green", "red", "gray", "dim", "muted", "accent", "title", "warning", "error"];
export const BOOL_VALUES: string[] = ["true", "false"];

export const DEFAULT_CONFIG: HunkConfig = {
	enabled: true,
	diffTheme: "auto",
	shikiDarkTheme: "github-dark",
	shikiLightTheme: "github-light",
	maxRenderedLines: 260,
	contextRadius: 6,
	lineNumbers: true,
	compactUnchanged: true,
	wordHighlight: "bold",
	lineHighlight: "gutter",
	header: "box",
	colors: { ...DEFAULT_COLORS },
	symbols: { ...DEFAULT_SYMBOLS },
	showHunkHint: true,
	hunk: {
		enabled: true,
		binary: "hunk",
		reviewTool: true,
		autoReviewNotes: false,
		autoReviewNotesMin: 1,
	},
};

export const COMMON_LANGS = [
	"bash",
	"c",
	"cpp",
	"css",
	"diff",
	"go",
	"html",
	"java",
	"javascript",
	"json",
	"jsx",
	"markdown",
	"python",
	"rust",
	"shellscript",
	"tsx",
	"typescript",
	"yaml",
	"toml",
] as const;

// ============================================================================
// Legacy migration + merge
// ============================================================================

function legacyWordHighlight(emphStyle: EmphStyle | undefined, wordHighlights: boolean | undefined): WordHighlight | undefined {
	if (emphStyle === "none" || wordHighlights === false) return "none";
	if (emphStyle === "bold") return "bold";
	if (emphStyle === "underline") return "underline";
	if (emphStyle === "inverse") return "inverse";
	if (emphStyle === "strikethrough") return "strike";
	if (emphStyle === "auto") return "bold";
	return undefined;
}

export function normalizeConfig(config: HunkConfig): HunkConfig {
	const legacy = legacyWordHighlight(config.emphStyle, config.wordHighlights);
	if (legacy && (!config.wordHighlight || config.wordHighlight === "bold") && config.emphStyle !== undefined) {
		config.wordHighlight = legacy;
	}
	if (config.wordHighlights === false && (!config.emphStyle || config.emphStyle === "bold")) {
		config.wordHighlight = "none";
	}
	return config;
}

export function mergeConfig(base: HunkConfig, next?: Partial<HunkConfig>): HunkConfig {
	if (!next) return base;
	const merged: HunkConfig = {
		...base,
		...next,
		colors: { ...base.colors, ...(next.colors ?? {}) },
		symbols: { ...base.symbols, ...(next.symbols ?? {}) },
		hunk: { ...base.hunk, ...(next.hunk ?? {}) },
	};
	return normalizeConfig(merged);
}

async function loadJsonFile(filePath: string): Promise<Partial<HunkConfig> | undefined> {
	try {
		if (!existsSync(filePath)) return undefined;
		return JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<HunkConfig>;
	} catch {
		return undefined;
	}
}

async function loadFirstJsonFile(filePaths: string[]): Promise<Partial<HunkConfig> | undefined> {
	for (const filePath of filePaths) {
		const config = await loadJsonFile(filePath);
		if (config) return config;
	}
	return undefined;
}

export async function loadConfig(cwd: string): Promise<HunkConfig> {
	const globalConfig = await loadFirstJsonFile([
		path.join(os.homedir(), ".pi", "agent", "hunk.json"),
		path.join(os.homedir(), ".pi", "agent", "huff.json"),
	]);
	const projectConfig = await loadFirstJsonFile([
		path.join(cwd, ".pi", "hunk.json"),
		path.join(cwd, ".pi", "huff.json"),
	]);
	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

export async function readJsonFile(filePath: string): Promise<Partial<HunkConfig> | undefined> {
	return loadJsonFile(filePath);
}

// ============================================================================
// Palette resolution — the single place a ColorRef becomes ANSI
// ============================================================================

export function ansiFg(hex: string | undefined): string {
	if (!hex) return "";
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return "";
	const n = Number.parseInt(m[1], 16);
	const r = (n >> 16) & 255;
	const g = (n >> 8) & 255;
	const b = n & 255;
	return `\x1b[38;2;${r};${g};${b}m`;
}

export function resolveColorAnsi(ref: ColorRef, fallbackSlot: string, theme: Theme): string {
	if (!ref || ref === "auto") return theme.getFgAnsi(fallbackSlot) || "";
	if (ref.startsWith("theme:")) return theme.getFgAnsi(ref.slice(6)) || theme.getFgAnsi(fallbackSlot) || "";
	if (ref.startsWith("#") || /^[0-9a-fA-F]{6}$/.test(ref)) return ansiFg(ref);
	const aliased = COLOR_ALIASES[ref];
	if (aliased === "") return theme.getFgAnsi(fallbackSlot) || "";
	if (aliased) return theme.getFgAnsi(aliased) || theme.getFgAnsi(fallbackSlot) || "";
	return theme.getFgAnsi(ref) || theme.getFgAnsi(fallbackSlot) || "";
}

export function resolvePalette(config: HunkConfig, theme: Theme): Palette {
	return {
		add: resolveColorAnsi(config.colors.add, "toolDiffAdded", theme),
		remove: resolveColorAnsi(config.colors.remove, "toolDiffRemoved", theme),
		context: resolveColorAnsi(config.colors.context, "toolDiffContext", theme),
		meta: resolveColorAnsi(config.colors.meta, "dim", theme),
		header: resolveColorAnsi(config.colors.header, "toolTitle", theme),
		lineNo: resolveColorAnsi(config.colors.lineNo, "dim", theme),
	};
}

export type DiffSide = "add" | "remove" | "context";

/** Gutter follows the side color when `auto`, else the configured ref. */
export function gutterColor(config: HunkConfig, side: DiffSide, theme: Theme): string {
	const ref = config.colors.gutter;
	if (!ref || ref === "auto") {
		const palette = resolvePalette(config, theme);
		return side === "add" ? palette.add : side === "remove" ? palette.remove : palette.context;
	}
	return resolveColorAnsi(ref, side === "add" ? "toolDiffAdded" : side === "remove" ? "toolDiffRemoved" : "toolDiffContext", theme);
}

export function tintBgAnsi(side: DiffSide): string {
	return side === "add" ? "\x1b[48;2;26;44;28m" : side === "remove" ? "\x1b[48;2;46;26;28m" : "";
}

// ============================================================================
// Shiki theme selection
// ============================================================================

export function displayTheme(config: HunkConfig, theme: Theme): string {
	if (config.diffTheme === "light") return config.shikiLightTheme;
	if (config.diffTheme === "dark") return config.shikiDarkTheme;
	const name = (theme.name ?? "").toLowerCase();
	return name.includes("light") ? config.shikiLightTheme : config.shikiDarkTheme;
}

export function highlighterKey(config: HunkConfig): string {
	return JSON.stringify([config.shikiDarkTheme, config.shikiLightTheme]);
}
