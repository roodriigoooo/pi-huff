import { getSettingsListTheme, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	SelectList,
	SettingsList,
	matchesKey,
	truncateToWidth,
	type Component,
	type SelectItem,
	type SelectListTheme,
	type SettingItem,
	type SettingsListTheme,
} from "@earendil-works/pi-tui";
import fs from "node:fs/promises";
import path from "node:path";
import { bundledThemesInfo } from "shiki";
import {
	BOOL_VALUES,
	HEADER_VALUES,
	type HuffConfig,
	LINE_HIGHLIGHT_VALUES,
	LINE_NUMBERS_VALUES,
	resolveColorAnsi,
	type ColorSlots,
	type SymbolSlots,
	WORD_HIGHLIGHT_VALUES,
} from "./config";
import { type Highlighter, createDiffView } from "./diff-view";

const HUFF_CONFIG_SAMPLE_PATCH = [
	"--- a/preview.ts",
	"+++ b/preview.ts",
	"@@ -1,22 +1,23 @@",
	" import { palette } from \"./theme\";",
	" import { titleCase } from \"./text\";",
	" ",
	" const CHANNEL = \"alpha\";",
	" const RETRIES = 2;",
	" const TIMEOUT_MS = 1200;",
	" ",
	" export function greet(name: string) {",
	"-  const message = `hello ${name}`;",
	"-  return { message, excited: false };",
	"+  const displayName = titleCase(name.trim());",
	"+  const message = `hi ${displayName}`;",
	"+  return { message, tone: palette.accent, excited: true };",
	" }",
	" ",
	" export function retryDelay(attempt: number) {",
	"   return Math.min(attempt * TIMEOUT_MS, 8000);",
	" }",
	" ",
	" export const FLAGS = { compact: true, preview: true };",
	" export const OWNER = \"huff\";",
	" export const STATUS = \"draft\";",
	" ",
	"-export const VERSION = \"0.1.0\";",
	"+export const VERSION = \"0.2.0\";",
	"+export const RELEASE = `${CHANNEL}-preview`;",
].join("\n");

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

type Choice = { value: string; label?: string; description?: string };
type ChoiceFactory = (config: HuffConfig, theme: Theme) => Choice[];
type ConfigSpec = {
	id: string;
	label: string;
	values?: string[];
	choices?: Choice[] | ChoiceFactory;
	get: (c: HuffConfig) => string;
	set: (c: HuffConfig, v: string) => void;
	describe?: (value: string, config: HuffConfig, theme: Theme) => string;
};

function normalizeHex(value: string): string {
	const hex = value.startsWith("#") ? value : `#${value}`;
	return hex.toLowerCase();
}

function boolSpec(id: string, label: string, get: (c: HuffConfig) => boolean, set: (c: HuffConfig, v: boolean) => void, detail?: string): ConfigSpec {
	return {
		id,
		label,
		values: BOOL_VALUES,
		get: (c) => (get(c) ? "true" : "false"),
		set: (c, v) => set(c, v === "true"),
		describe: (value) => `${value === "true" ? "enabled" : "disabled"}${detail ? ` — ${detail}` : ""}`,
	};
}

function numSpec(id: string, label: string, values: string[], get: (c: HuffConfig) => number, set: (c: HuffConfig, v: number) => void, detail: string): ConfigSpec {
	return { id, label, values, get: (c) => String(get(c)), set: (c, v) => set(c, Number(v)), describe: () => detail };
}

function choiceSpec(id: string, label: string, choices: Choice[] | ChoiceFactory, get: (c: HuffConfig) => string, set: (c: HuffConfig, v: string) => void, detail?: string): ConfigSpec {
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
		values: SYMBOL_PRESETS[slot],
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

function swatch(ref: string, fallbackSlot: string, theme: Theme, label: string): string {
	const ansi = resolveColorAnsi(ref, fallbackSlot, theme) || theme.getFgAnsi("muted") || "";
	return `${ansi}●${ANSI_RESET} ${label}`;
}

function colorChoices(slot: keyof ColorSlots, theme: Theme): Choice[] {
	const fallback = COLOR_FALLBACKS[slot];
	const autoDescription = slot === "gutter" ? "Follow the current row side: add, remove, or context." : `Follow pi theme slot ${fallback}.`;
	const aliases: Choice[] = [
		{ value: "auto", label: swatch("auto", fallback, theme, "auto"), description: autoDescription },
		{ value: "green", label: swatch("green", fallback, theme, "green"), description: "Alias for pi's addition color." },
		{ value: "red", label: swatch("red", fallback, theme, "red"), description: "Alias for pi's removal color." },
		{ value: "gray", label: swatch("gray", fallback, theme, "gray"), description: "Alias for diff context text; readable neutral." },
		{ value: "muted", label: swatch("muted", fallback, theme, "muted"), description: "Secondary UI text; calmer than gray." },
		{ value: "dim", label: swatch("dim", fallback, theme, "dim"), description: "Tertiary UI text; lowest contrast." },
		{ value: "accent", label: swatch("accent", fallback, theme, "accent"), description: "Primary pi accent color." },
		{ value: "title", label: swatch("title", fallback, theme, "title"), description: "Tool title color." },
		{ value: "warning", label: swatch("warning", fallback, theme, "warning"), description: "Warning/yellow emphasis." },
		{ value: "error", label: swatch("error", fallback, theme, "error"), description: "Error/red emphasis." },
	];
	const themeSlots: Choice[] = [
		["theme:toolDiffAdded", "theme added", "Exact pi diff addition slot."],
		["theme:toolDiffRemoved", "theme removed", "Exact pi diff removal slot."],
		["theme:toolDiffContext", "theme context", "Exact pi diff context slot."],
		["theme:toolTitle", "theme title", "Tool title foreground."],
		["theme:accent", "theme accent", "Current pi accent."],
		["theme:muted", "theme muted", "Current pi muted text."],
		["theme:dim", "theme dim", "Current pi dim text."],
		["theme:warning", "theme warning", "Current pi warning color."],
		["theme:error", "theme error", "Current pi error color."],
		["theme:borderMuted", "theme border", "Muted border color."],
	].map(([value, label, description]) => ({ value, label: swatch(value, fallback, theme, label), description }));
	const hexes: Choice[] = [
		["#80dc78", "mint", "Soft green, good for additions."],
		["#ff6b6b", "coral", "Warm red, good for removals."],
		["#61afef", "sky", "Cool blue accent."],
		["#c678dd", "violet", "Vivid violet accent."],
		["#e5c07b", "gold", "Warm amber metadata."],
		["#56b6c2", "cyan", "Cool cyan marker."],
		["#abb2bf", "stone", "Readable neutral foreground."],
		["#7f849c", "slate", "Muted neutral foreground."],
		["#f5c2e7", "rose", "Soft pink highlight."],
		["#a6e3a1", "sage", "Pastel green highlight."],
	].map(([value, name, description]) => ({ value, label: swatch(value, fallback, theme, `${name} · ${value}`), description }));
	return uniqueChoices([...aliases, ...themeSlots, ...hexes]);
}

function uniqueChoices(choices: Choice[]): Choice[] {
	const seen = new Set<string>();
	return choices.filter((choice) => {
		if (seen.has(choice.value)) return false;
		seen.add(choice.value);
		return true;
	});
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

function choicesForSpec(spec: Pick<ConfigSpec, "choices" | "values" | "get" | "describe">, config: HuffConfig, theme: Theme): Choice[] {
	const choices = spec.choices
		? typeof spec.choices === "function"
			? spec.choices(config, theme)
			: spec.choices
		: (spec.values ?? []).map((value) => ({ value, label: value, description: spec.describe?.(value, config, theme) }));
	const current = spec.get(config);
	if (choices.some((choice) => choice.value === current)) return choices;
	return [{ value: current, label: `${current} · current custom value`, description: "Current value from config; not in the built-in picker list." }, ...choices];
}

function descriptionForSpec(spec: ConfigSpec, config: HuffConfig, theme: Theme): string {
	const value = spec.get(config);
	const detail = spec.describe?.(value, config, theme) ?? choiceDescription(choicesForSpec(spec, config, theme), value);
	return detail ? `Current: ${value} — ${detail}` : `Current: ${value}`;
}

function selectListThemeFromUi(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", theme.bold(text)),
		description: (text) => theme.fg("dim", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

class StaticLines implements Component {
	constructor(private readonly getLines: () => string[]) {}
	render(width: number): string[] {
		return this.getLines().map((line) => truncateToWidth(line, width));
	}
	invalidate(): void {}
}

class ChoicePicker implements Component {
	private readonly list: SelectList;
	private filter = "";

	constructor(
		private readonly title: string,
		private readonly choices: Choice[],
		private readonly theme: Theme,
		private readonly done: (selectedValue?: string) => void,
		private readonly originalValue: string,
		private readonly allowHex: boolean,
		private readonly onPreview: (value: string) => void,
	) {
		const items: SelectItem[] = choices.map((choice) => ({ value: choice.value, label: choice.label ?? choice.value, description: choice.description }));
		this.list = new SelectList(items, Math.min(items.length, 8), selectListThemeFromUi(theme), { minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 42 });
		const selected = choices.findIndex((choice) => choice.value === originalValue);
		this.list.setSelectedIndex(selected === -1 ? 0 : selected);
		this.list.onSelectionChange = (item) => this.onPreview(item.value);
		this.list.onSelect = (item) => {
			this.onPreview(item.value);
			this.done(item.value);
		};
		this.list.onCancel = () => {
			this.onPreview(this.originalValue);
			this.done(undefined);
		};
	}

	render(width: number): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold(this.title)));
		lines.push(this.theme.fg("dim", this.allowHex ? "Type to filter; #RRGGBB + Enter accepts custom truecolor." : "Type to filter by value."));
		if (this.filter) lines.push(this.theme.fg("muted", `filter: ${this.filter}`));
		lines.push("");
		lines.push(...this.list.render(width));
		if (this.allowHex && this.isCustomHex()) lines.push(this.theme.fg("accent", `  use custom ${normalizeHex(this.filter)}`));
		lines.push("");
		lines.push(this.theme.fg("dim", "↑↓ move · Enter select · type filter · Backspace edit · Esc back"));
		return lines.map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape)) {
			if (this.filter) {
				this.setFilter("");
				return;
			}
			this.onPreview(this.originalValue);
			this.done(undefined);
			return;
		}
		if (matchesKey(data, Key.backspace)) {
			this.setFilter(this.filter.slice(0, -1));
			return;
		}
		if (matchesKey(data, Key.enter) || data === " ") {
			if (this.allowHex && this.isCustomHex()) {
				const value = normalizeHex(this.filter);
				this.onPreview(value);
				this.done(value);
				return;
			}
			const selected = this.list.getSelectedItem();
			if (selected) {
				this.onPreview(selected.value);
				this.done(selected.value);
			}
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			this.list.handleInput(data);
			return;
		}
		if (data.length === 1 && data >= "!" && data <= "~") {
			this.setFilter(this.filter + data);
		}
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private setFilter(next: string): void {
		this.filter = next;
		this.list.setFilter(next);
		if (this.allowHex && this.isCustomHex()) {
			this.onPreview(normalizeHex(this.filter));
			return;
		}
		this.onPreview(this.list.getSelectedItem()?.value ?? this.originalValue);
	}

	private isCustomHex(): boolean {
		const normalized = normalizeHex(this.filter);
		return HEX_COLOR_RE.test(normalized) && !this.choices.some((choice) => choice.value.toLowerCase() === normalized);
	}
}

function huffConfigSpecs(): ConfigSpec[] {
	return [
		boolSpec("enabled", "renderer · enabled", (c) => c.enabled, (c, v) => (c.enabled = v), "Turn Huff diff rendering on/off."),
		choiceSpec("diffTheme", "theme · diff mode", DIFF_MODE_CHOICES, (c) => c.diffTheme, (c, v) => (c.diffTheme = v as any)),
		choiceSpec("shikiDarkTheme", "theme · shiki dark", () => shikiThemeChoices("dark"), (c) => c.shikiDarkTheme, (c, v) => (c.shikiDarkTheme = v), "Enter opens bundled dark Shiki themes."),
		choiceSpec("shikiLightTheme", "theme · shiki light", () => shikiThemeChoices("light"), (c) => c.shikiLightTheme, (c, v) => (c.shikiLightTheme = v), "Enter opens bundled light Shiki themes."),
		choiceSpec("header", "layout · header", HEADER_CHOICES, (c) => c.header, (c, v) => (c.header = v as any)),
		choiceSpec("lineNumbers", "layout · line numbers", LINE_NUMBER_CHOICES, (c) => String(c.lineNumbers), (c, v) => (c.lineNumbers = v === "true" ? true : v === "false" ? false : "changed")),
		boolSpec("compactUnchanged", "layout · compact unchanged", (c) => c.compactUnchanged, (c, v) => (c.compactUnchanged = v), "Fold unchanged regions around edits."),
		boolSpec("showHunkHint", "layout · hunk hint", (c) => c.showHunkHint, (c, v) => (c.showHunkHint = v), "Show /huff send hint when a live Hunk session exists."),
		choiceSpec("lineHighlight", "lines · highlight", LINE_HIGHLIGHT_CHOICES, (c) => c.lineHighlight, (c, v) => (c.lineHighlight = v as any)),
		choiceSpec("wordHighlight", "words · highlight", WORD_HIGHLIGHT_CHOICES, (c) => c.wordHighlight, (c, v) => (c.wordHighlight = v as any)),
		colorSpec("colors.add", "colors · add", "add"),
		colorSpec("colors.remove", "colors · remove", "remove"),
		colorSpec("colors.context", "colors · context", "context"),
		colorSpec("colors.meta", "colors · meta", "meta"),
		colorSpec("colors.header", "colors · header", "header"),
		colorSpec("colors.gutter", "colors · gutter", "gutter"),
		colorSpec("colors.lineNo", "colors · line no", "lineNo"),
		symbolSpec("symbols.add", "symbols · add", "add"),
		symbolSpec("symbols.remove", "symbols · remove", "remove"),
		symbolSpec("symbols.context", "symbols · context", "context"),
		symbolSpec("symbols.fold", "symbols · fold", "fold"),
		symbolSpec("symbols.gutter", "symbols · gutter", "gutter"),
		numSpec("maxRenderedLines", "limits · max rows", ["12", "24", "60", "120", "260", "500", "1000"], (c) => c.maxRenderedLines, (c, v) => (c.maxRenderedLines = v), "Maximum rendered diff rows before truncation."),
		numSpec("contextRadius", "limits · context radius", ["2", "3", "6", "10"], (c) => c.contextRadius, (c, v) => (c.contextRadius = v), "Unchanged lines kept around each change when compaction is on."),
		boolSpec("hunk.enabled", "hunk · enabled", (c) => c.hunk.enabled, (c, v) => (c.hunk.enabled = v), "Enable read-only Hunk session integration."),
		boolSpec("hunk.reviewTool", "hunk · review tool", (c) => c.hunk.reviewTool, (c, v) => (c.hunk.reviewTool = v), "Expose huff_review_notes to the model."),
		boolSpec("hunk.autoReviewNotes", "hunk · auto pickup", (c) => c.hunk.autoReviewNotes, (c, v) => (c.hunk.autoReviewNotes = v), "Inject new human notes before agent turns."),
		numSpec("hunk.autoReviewNotesMin", "hunk · auto min notes", ["1", "2", "3", "5"], (c) => c.hunk.autoReviewNotesMin, (c, v) => (c.hunk.autoReviewNotesMin = v), "Minimum user notes required for automatic pickup."),
	];
}

function cloneConfig(config: HuffConfig): HuffConfig {
	return { ...config, colors: { ...config.colors }, symbols: { ...config.symbols }, hunk: { ...config.hunk } };
}

async function saveProjectHuffConfig(cwd: string, config: HuffConfig): Promise<void> {
	const dir = path.join(cwd, ".pi");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "huff.json");
	await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function huffSettingsHint(text: string): string {
	return text.replace("Enter/Space to change", "Enter/Space open picker").replace("Esc to cancel", "Esc to save");
}

function settingsListThemeFromUi(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text)),
		value: (text, selected) => (selected ? theme.fg("toolTitle", theme.bold(text)) : theme.fg("dim", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "› "),
		hint: (text) => theme.fg("dim", huffSettingsHint(text)),
	};
}

function resolveSettingsListTheme(theme: Theme): SettingsListTheme {
	try {
		const base = getSettingsListTheme();
		return { ...base, hint: (text) => base.hint(huffSettingsHint(text)) };
	} catch {
		return settingsListThemeFromUi(theme);
	}
}

/** Open the `/huff configure` live-preview TUI. Esc saves to `.pi/huff.json`. */
export async function openHuffConfig(
	ctx: ExtensionCommandContext,
	getConfig: () => HuffConfig,
	applyConfig: (next: HuffConfig) => Promise<void>,
	getHighlighter: (config: HuffConfig, invalidate?: () => void) => Highlighter | undefined,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/huff configure requires TUI mode.", "error");
		return;
	}
	const draft = cloneConfig(getConfig());
	const specs = huffConfigSpecs();
	let theme = ctx.ui.theme;
	let requestPreviewRender: (() => void) | undefined;
	function buildPreview(): Component {
		if (!draft.enabled) {
			return new StaticLines(() => [
				theme.fg("muted", "Huff renderer disabled."),
				theme.fg("dim", "Pi will use default tool rendering until enabled again."),
			]);
		}
		return createDiffView({
			patch: HUFF_CONFIG_SAMPLE_PATCH,
			filePath: "preview.ts",
			cwd: ctx.cwd,
			title: "preview",
			config: draft,
			highlighter: getHighlighter(draft, requestPreviewRender),
			theme,
			liveSession: true,
		});
	}

	let preview = buildPreview();

	function rebuildPreview() {
		preview = buildPreview();
	}

	const items: SettingItem[] = specs.map((spec) => {
		const item: SettingItem = {
			id: spec.id,
			label: spec.label,
			currentValue: spec.get(draft),
			description: descriptionForSpec(spec, draft, theme),
		};
		item.submenu = (currentValue, done) =>
			new ChoicePicker(spec.label, choicesForSpec(spec, draft, theme), theme, done, currentValue, spec.id.startsWith("colors."), (value) => {
				spec.set(draft, value);
				item.currentValue = spec.get(draft);
				item.description = descriptionForSpec(spec, draft, theme);
				rebuildPreview();
			});
		return item;
	});

	const settingsTheme = resolveSettingsListTheme(theme);
	let closeDone: ((value?: void) => void) | undefined;
	const settingsList = new SettingsList(
		items,
		Math.min(items.length, 8),
		settingsTheme,
		(id, newValue) => {
			const spec = specs.find((s) => s.id === id);
			if (!spec) return;
			spec.set(draft, newValue);
			const item = items.find((i) => i.id === id);
			if (item) {
				item.currentValue = spec.get(draft);
				item.description = descriptionForSpec(spec, draft, theme);
			}
			rebuildPreview();
		},
		() => {
			saveProjectHuffConfig(ctx.cwd, draft)
				.then(() => applyConfig(draft))
				.then(() => ctx.ui.notify("Saved Huff config to .pi/huff.json.", "info"))
				.catch((error) => ctx.ui.notify(`Failed to save Huff config: ${String(error)}`, "error"))
				.finally(() => closeDone?.());
		},
		{ enableSearch: true },
	);

	await ctx.ui.custom<void>((tui, nextTheme, _kb, done) => {
		theme = nextTheme;
		requestPreviewRender = () => {
			rebuildPreview();
			preview.invalidate();
			tui.requestRender();
		};
		closeDone = done as ((value?: void) => void) | undefined;
		return {
			render(width: number): string[] {
				const out: string[] = [];
				out.push(`${theme.fg("accent", theme.bold("Huff Configuration"))} ${theme.fg("dim", "· live Shiki preview")}`);
				out.push(theme.fg("dim", "Enter/Space opens picker · type filters settings · Esc saves project config"));
				out.push("");
				out.push(...settingsList.render(width));
				out.push("");
				out.push(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("Preview"))}`);
				out.push(...preview.render(Math.max(40, width)));
				return out;
			},
			invalidate() {
				settingsList.invalidate();
				preview.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
