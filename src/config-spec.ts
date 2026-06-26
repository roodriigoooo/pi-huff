import type { Theme } from "@earendil-works/pi-coding-agent";
import { bundledThemesInfo } from "shiki";
import {
	BOOL_VALUES,
	DEFAULT_COLORS,
	DEFAULT_SYMBOLS,
	HEADER_VALUES,
	type HunkConfig,
	LINE_HIGHLIGHT_VALUES,
	LINE_NUMBERS_VALUES,
	mergeConfig,
	resolveColorAnsi,
	type ColorSlots,
	type SymbolSlots,
	WORD_HIGHLIGHT_VALUES,
} from "./config";

const ANSI_RESET = "\x1b[0m";
const HEX_COLOR_RE = /^#?[0-9a-f]{6}$/i;

const SYMBOL_PRESETS: Record<keyof SymbolSlots, string[]> = {
	add: ["+", "▶", "•", "*"],
	remove: ["−", "◀", "✕", "-"],
	context: [" ", "·"],
	fold: ["⋯", "…", "··"],
	gutter: ["▎", "│", "║", " "],
};

const COLOR_FALLBACKS: Record<keyof ColorSlots, string> = {
	add: "toolDiffAdded",
	remove: "toolDiffRemoved",
	context: "toolDiffContext",
	meta: "dim",
	header: "toolTitle",
	gutter: "toolDiffAdded",
	lineNo: "dim",
};

export type Choice = { value: string; label?: string; description?: string };
export type HunkPreset = { id: string; label: string; description: string; config: Partial<HunkConfig> };
type ChoiceFactory = (config: HunkConfig, theme: Theme) => Choice[];

export type ConfigSpec = {
	id: string;
	label: string;
	values?: string[];
	choices?: Choice[] | ChoiceFactory;
	get: (c: HunkConfig) => string;
	set: (c: HunkConfig, v: string) => void;
	describe?: (value: string, config: HunkConfig, theme: Theme) => string;
};

export type ConfigGroup = {
	id: string;
	label: string;
	description: string;
	specs: ConfigSpec[];
};

export function normalizeHex(value: string): string {
	const hex = value.startsWith("#") ? value : `#${value}`;
	return hex.toLowerCase();
}

export function isHexColor(value: string): boolean {
	return HEX_COLOR_RE.test(value);
}

function boolSpec(id: string, label: string, get: (c: HunkConfig) => boolean, set: (c: HunkConfig, v: boolean) => void, detail?: string): ConfigSpec {
	return {
		id,
		label,
		values: BOOL_VALUES,
		get: (c) => (get(c) ? "true" : "false"),
		set: (c, v) => set(c, v === "true"),
		describe: (value) => `${value === "true" ? "enabled" : "disabled"}${detail ? ` — ${detail}` : ""}`,
	};
}

function numSpec(id: string, label: string, values: string[], get: (c: HunkConfig) => number, set: (c: HunkConfig, v: number) => void, detail: string): ConfigSpec {
	return { id, label, values, get: (c) => String(get(c)), set: (c, v) => set(c, Number(v)), describe: () => detail };
}

function choiceSpec(id: string, label: string, choices: Choice[] | ChoiceFactory, get: (c: HunkConfig) => string, set: (c: HunkConfig, v: string) => void, detail?: string): ConfigSpec {
	return {
		id,
		label,
		choices,
		get,
		set,
		describe: (value, config, theme) => choiceDescription(choicesForSpec({ choices, get }, config, theme), value) ?? detail ?? "Enter opens choices with descriptions.",
	};
}

function colorSpec(id: string, label: string, slot: keyof ColorSlots): ConfigSpec {
	return {
		id,
		label,
		choices: (_config, theme) => colorChoices(slot, theme),
		get: (c) => c.colors[slot],
		set: (c, v) => (c.colors[slot] = v),
		describe: (value, _config, theme) => colorDescription(slot, value, theme),
	};
}

function symbolSpec(id: string, label: string, slot: keyof SymbolSlots): ConfigSpec {
	return {
		id,
		label,
		choices: (_config, theme) => symbolChoices(slot, theme),
		get: (c) => c.symbols[slot],
		set: (c, v) => (c.symbols[slot] = v),
		describe: () => `Cycles glyphs used for ${slot} rows.`,
	};
}

const DIFF_MODE_CHOICES: Choice[] = [
	{ value: "auto", label: "auto · follow pi theme", description: "Use light Shiki theme in light pi themes, dark Shiki theme otherwise." },
	{ value: "dark", label: "dark · force dark", description: "Always use the configured dark Shiki theme." },
	{ value: "light", label: "light · force light", description: "Always use the configured light Shiki theme." },
];

const HEADER_CHOICES: Choice[] = HEADER_VALUES.map((value) => ({
	value,
	label: value === "box" ? "box · framed" : value === "compact" ? "compact · single row" : "minimal · path only",
	description: value === "box" ? "Three-line title with stats; strongest scan target." : value === "compact" ? "One-line title, path, and stats; best default density." : "Smallest possible header for narrow terminals.",
}));

const LINE_NUMBER_CHOICES: Choice[] = LINE_NUMBERS_VALUES.map((value) => ({
	value,
	label: value === "true" ? "true · old + new" : value === "changed" ? "changed · changed rows only" : "false · hidden",
	description: value === "true" ? "Show old and new line numbers on every rendered row." : value === "changed" ? "Reserve the column but only show numbers beside additions/removals." : "Hide line number columns entirely.",
}));

const LINE_HIGHLIGHT_DETAILS: Record<string, Omit<Choice, "value">> = {
	gutter: { label: "gutter · slim change rail", description: "Colored glyph in the left rail. Elegant, quiet, readable." },
	bar: { label: "bar · structural marker", description: "Vertical bar beside changed rows. Stronger than gutter, still low-noise." },
	tint: { label: "tint · soft row wash", description: "Background tint behind changed code while preserving Shiki token colors." },
	none: { label: "none · syntax only", description: "No line-level marker; word and side colors carry the diff." },
};
const LINE_HIGHLIGHT_CHOICES: Choice[] = LINE_HIGHLIGHT_VALUES.map((value) => ({ value, ...LINE_HIGHLIGHT_DETAILS[value] }));

const WORD_HIGHLIGHT_DETAILS: Record<string, Omit<Choice, "value">> = {
	bold: { label: "bold · editorial mark", description: "Bold changed words on both sides. Good default." },
	none: { label: "none · side color only", description: "Disable word-level decorations; keep line-level diff colors." },
	underline: { label: "underline · precise mark", description: "Underline changed words without changing foreground color." },
	inverse: { label: "inverse · high contrast", description: "Invert changed words for maximum contrast." },
	strike: { label: "strike · deletion-aware", description: "Strike removed words; underline added words so insertions stay readable." },
	color: { label: "color · semantic accent", description: "Use accent for inserted words and warning/error for removed words." },
};
const WORD_HIGHLIGHT_CHOICES: Choice[] = WORD_HIGHLIGHT_VALUES.map((value) => ({ value, ...WORD_HIGHLIGHT_DETAILS[value] }));

function shikiThemeChoices(type: "dark" | "light"): Choice[] {
	return bundledThemesInfo
		.filter((info) => info.type === type)
		.map((info) => ({ value: info.id, label: `${info.displayName} · ${info.id}`, description: `Bundled Shiki ${type} theme.` }));
}

function colorSample(ref: string, fallbackSlot: string, theme: Theme, label: string): string {
	const ansi = resolveColorAnsi(ref, fallbackSlot, theme) || theme.getFgAnsi("muted") || "";
	return `${ansi}+ const tone = vivid${ANSI_RESET} ${theme.fg("dim", "·")} ${label}`;
}

function symbolSample(slot: keyof SymbolSlots, value: string, theme: Theme): string {
	if (slot === "fold") return `${theme.fg("dim", `  ${value} 3 unchanged lines`)}`;
	const gutter = slot === "gutter" ? value : "▎";
	const sign = slot === "add" ? value : slot === "remove" ? value : slot === "context" ? value : "+";
	const code = sign.trim() ? "const x = 1;" : "const stable = true;";
	return `${theme.fg("muted", gutter)} ${theme.fg("accent", sign)}   ${code}`;
}

function symbolChoices(slot: keyof SymbolSlots, theme: Theme): Choice[] {
	return SYMBOL_PRESETS[slot].map((value) => ({
		value,
		label: symbolSample(slot, value, theme),
		description: `Render ${value === " " ? "blank space" : value} in a representative diff row.`,
	}));
}

/** Per-slot color choices: auto (follow role) + six UI-semantic colors + freeform hex.
 *  Cross-role diff colors and theme-slot duplicates are intentionally omitted —
 *  `auto` already follows the role, and custom hex covers anything else. */
function colorChoices(slot: keyof ColorSlots, theme: Theme): Choice[] {
	const fallback = COLOR_FALLBACKS[slot];
	const autoDescription = slot === "gutter" ? "Follow the current row side: add, remove, or context." : `Follow pi theme slot ${fallback}.`;
	const semantic: Array<[string, string]> = [
		["accent", "Primary pi accent color."],
		["muted", "Secondary UI text; calm neutral."],
		["dim", "Tertiary UI text; lowest contrast."],
		["title", "Tool title foreground."],
		["warning", "Warning/yellow emphasis."],
		["error", "Error/red emphasis."],
	];
	return [
		{ value: "auto", label: colorSample("auto", fallback, theme, "auto"), description: autoDescription },
		...semantic.map(([value, description]) => ({ value, label: colorSample(value, fallback, theme, value), description })),
	];
}

function choiceDescription(choices: Choice[], value: string): string | undefined {
	return choices.find((choice) => choice.value === value)?.description;
}

function colorDescription(slot: keyof ColorSlots, value: string, theme: Theme): string {
	if (value === "auto") return slot === "gutter" ? "Auto follows add/remove/context side color." : `Auto follows ${COLOR_FALLBACKS[slot]}.`;
	if (value.startsWith("theme:")) return `Uses pi theme slot ${value.slice(6)}.`;
	if (HEX_COLOR_RE.test(value)) return `Custom truecolor ${normalizeHex(value)}.`;
	return choiceDescription(colorChoices(slot, theme), value) ?? "Resolved as a pi theme color name if present.";
}

export function choicesForSpec(spec: Pick<ConfigSpec, "choices" | "values" | "get" | "describe">, config: HunkConfig, theme: Theme): Choice[] {
	const choices = spec.choices
		? typeof spec.choices === "function"
			? spec.choices(config, theme)
			: spec.choices
		: (spec.values ?? []).map((value) => ({ value, label: value, description: spec.describe?.(value, config, theme) }));
	const current = spec.get(config);
	if (choices.some((choice) => choice.value === current)) return choices;
	return [{ value: current, label: `${current} · current custom value`, description: "Current value from config; not in the built-in picker list." }, ...choices];
}

export function descriptionForSpec(spec: ConfigSpec, config: HunkConfig, theme: Theme): string {
	const value = spec.get(config);
	const detail = spec.describe?.(value, config, theme) ?? choiceDescription(choicesForSpec(spec, config, theme), value);
	return detail ? `Current: ${value} — ${detail}` : `Current: ${value}`;
}

export function hunkConfigPresets(): HunkPreset[] {
	return [
		{
			id: "pi-native",
			label: "pi native",
			description: "Follow pi theme slots, bold changed words, gutter rail, boxed header.",
			config: {
				enabled: true,
				diffTheme: "auto",
				lineNumbers: true,
				compactUnchanged: true,
				contextRadius: 6,
				maxRenderedLines: 260,
				wordHighlight: "bold",
				lineHighlight: "gutter",
				header: "box",
				colors: { ...DEFAULT_COLORS },
				symbols: { ...DEFAULT_SYMBOLS },
			},
		},
		{
			id: "high-contrast-mono",
			label: "high-contrast mono",
			description: "Neutral side colors, inverse words, structural bar, minimal header.",
			config: {
				enabled: true,
				lineNumbers: "changed",
				compactUnchanged: true,
				contextRadius: 3,
				wordHighlight: "inverse",
				lineHighlight: "bar",
				header: "minimal",
				colors: { add: "muted", remove: "muted", context: "dim", meta: "dim", header: "title", gutter: "accent", lineNo: "dim" },
				symbols: { ...DEFAULT_SYMBOLS, gutter: "│" },
			},
		},
		{
			id: "warm-editorial",
			label: "warm editorial",
			description: "Soft truecolor sides, underlined words, quiet gutter, compact header.",
			config: {
				enabled: true,
				lineNumbers: true,
				compactUnchanged: true,
				contextRadius: 6,
				wordHighlight: "underline",
				lineHighlight: "gutter",
				header: "compact",
				colors: { add: "#80dc78", remove: "#ff6b6b", context: "muted", meta: "dim", header: "title", gutter: "auto", lineNo: "dim" },
				symbols: { ...DEFAULT_SYMBOLS },
			},
		},
		{
			id: "syntax-only",
			label: "syntax-only",
			description: "No word or line markers; Shiki syntax and compact chrome carry the view.",
			config: {
				enabled: true,
				lineNumbers: true,
				compactUnchanged: true,
				contextRadius: 6,
				wordHighlight: "none",
				lineHighlight: "none",
				header: "compact",
				colors: { ...DEFAULT_COLORS },
				symbols: { ...DEFAULT_SYMBOLS },
			},
		},
	];
}

export function applyHunkPreset(base: HunkConfig, preset: HunkPreset): HunkConfig {
	return mergeConfig(base, preset.config);
}

/** All config specs grouped by what the user sees, not by config key. */
export function hunkConfigGroups(): ConfigGroup[] {
	return [
		{
			id: "words",
			label: "Side colors & words",
			description: "Word emphasis style and add/remove/context colors.",
			specs: [
				choiceSpec("wordHighlight", "word emphasis", WORD_HIGHLIGHT_CHOICES, (c) => c.wordHighlight, (c, v) => (c.wordHighlight = v as any)),
				colorSpec("colors.add", "add color", "add"),
				colorSpec("colors.remove", "remove color", "remove"),
				colorSpec("colors.context", "context color", "context"),
			],
		},
		{
			id: "rail",
			label: "Change rail",
			description: "Left-edge markers: line highlight, gutter, add/remove signs.",
			specs: [
				choiceSpec("lineHighlight", "line marker", LINE_HIGHLIGHT_CHOICES, (c) => c.lineHighlight, (c, v) => (c.lineHighlight = v as any)),
				colorSpec("colors.gutter", "gutter color", "gutter"),
				symbolSpec("symbols.gutter", "gutter glyph", "gutter"),
				symbolSpec("symbols.add", "add sign", "add"),
				symbolSpec("symbols.remove", "remove sign", "remove"),
			],
		},
		{
			id: "header",
			label: "Header & line numbers",
			description: "File header style, line numbers, and chrome colors.",
			specs: [
				choiceSpec("header", "header style", HEADER_CHOICES, (c) => c.header, (c, v) => (c.header = v as any)),
				choiceSpec("lineNumbers", "line numbers", LINE_NUMBER_CHOICES, (c) => String(c.lineNumbers), (c, v) => (c.lineNumbers = v === "true" ? true : v === "false" ? false : "changed")),
				colorSpec("colors.header", "header color", "header"),
				colorSpec("colors.lineNo", "line number color", "lineNo"),
				colorSpec("colors.meta", "meta color", "meta"),
			],
		},
		{
			id: "symbols",
			label: "Symbols",
			description: "Glyphs for context and folded rows.",
			specs: [
				symbolSpec("symbols.context", "context glyph", "context"),
				symbolSpec("symbols.fold", "fold glyph", "fold"),
			],
		},
		{
			id: "folding",
			label: "Folding & limits",
			description: "Compact unchanged regions, context radius, max rows.",
			specs: [
				boolSpec("compactUnchanged", "compact unchanged", (c) => c.compactUnchanged, (c, v) => (c.compactUnchanged = v), "Fold unchanged regions around edits."),
				numSpec("contextRadius", "context radius", ["2", "3", "6", "10"], (c) => c.contextRadius, (c, v) => (c.contextRadius = v), "Unchanged lines kept around each change when compaction is on."),
				numSpec("maxRenderedLines", "max rows", ["12", "24", "60", "120", "260", "500", "1000"], (c) => c.maxRenderedLines, (c, v) => (c.maxRenderedLines = v), "Maximum rendered diff rows before truncation."),
			],
		},
		{
			id: "shiki",
			label: "Shiki theme",
			description: "Dark/light Shiki themes and auto mode.",
			specs: [
				choiceSpec("diffTheme", "diff mode", DIFF_MODE_CHOICES, (c) => c.diffTheme, (c, v) => (c.diffTheme = v as any)),
				choiceSpec("shikiDarkTheme", "dark theme", () => shikiThemeChoices("dark"), (c) => c.shikiDarkTheme, (c, v) => (c.shikiDarkTheme = v), "Enter opens bundled dark Shiki themes."),
				choiceSpec("shikiLightTheme", "light theme", () => shikiThemeChoices("light"), (c) => c.shikiLightTheme, (c, v) => (c.shikiLightTheme = v), "Enter opens bundled light Shiki themes."),
			],
		},
		{
			id: "bridge",
			label: "Renderer & Hunk bridge",
			description: "Master toggle, hunk hint, and read-only Hunk integration.",
			specs: [
				boolSpec("enabled", "renderer", (c) => c.enabled, (c, v) => (c.enabled = v), "Turn pi-hunk diff rendering on/off."),
				boolSpec("showHunkHint", "hunk hint", (c) => c.showHunkHint, (c, v) => (c.showHunkHint = v), "Show /hunk review hint when a live Hunk session exists."),
				boolSpec("hunk.enabled", "hunk bridge", (c) => c.hunk.enabled, (c, v) => (c.hunk.enabled = v), "Enable read-only Hunk session integration."),
				boolSpec("hunk.reviewTool", "review tool", (c) => c.hunk.reviewTool, (c, v) => (c.hunk.reviewTool = v), "Expose hunk_review_notes to the model."),
				boolSpec("hunk.autoReviewNotes", "auto pickup", (c) => c.hunk.autoReviewNotes, (c, v) => (c.hunk.autoReviewNotes = v), "Attach new relevant human notes before agent turns."),
			],
		},
	];
}
