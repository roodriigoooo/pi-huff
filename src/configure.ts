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
import { type HunkConfig } from "./config";
import { applyHunkPreset, choicesForSpec, descriptionForSpec, hunkConfigGroups, hunkConfigPresets, isHexColor, normalizeHex, type Choice, type HunkPreset } from "./config-spec";
import { type Highlighter, createDiffView } from "./diff-view";

const CONFIGURE_LIST_ROWS = 6;
const CONFIGURE_PREVIEW_MAX_LINES = 14;

const HUNK_CONFIG_SAMPLE_PATCH = [
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
	" export const OWNER = \"hunk\";",
	" export const STATUS = \"draft\";",
	" ",
	"-export const VERSION = \"0.1.0\";",
	"+export const VERSION = \"0.2.0\";",
	"+export const RELEASE = `${CHANNEL}-preview`;",
].join("\n");

function cloneConfig(config: HunkConfig): HunkConfig {
	return { ...config, colors: { ...config.colors }, symbols: { ...config.symbols }, hunk: { ...config.hunk } };
}

async function saveProjectHunkConfig(cwd: string, config: HunkConfig): Promise<void> {
	const dir = path.join(cwd, ".pi");
	await fs.mkdir(dir, { recursive: true });
	const filePath = path.join(dir, "hunk.json");
	await fs.writeFile(filePath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function hunkSettingsHint(text: string): string {
	return text.replace("Enter/Space to change", "Enter/Space open picker").replace("Esc to cancel", "Esc to save");
}

function settingsListThemeFromUi(theme: Theme): SettingsListTheme {
	return {
		label: (text, selected) => (selected ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text)),
		value: (text, selected) => (selected ? theme.fg("toolTitle", theme.bold(text)) : theme.fg("dim", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "› "),
		hint: (text) => theme.fg("dim", hunkSettingsHint(text)),
	};
}

function resolveSettingsListTheme(theme: Theme): SettingsListTheme {
	try {
		const base = getSettingsListTheme();
		return { ...base, hint: (text) => base.hint(hunkSettingsHint(text)) };
	} catch {
		return settingsListThemeFromUi(theme);
	}
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
		this.list = new SelectList(items, Math.min(items.length, CONFIGURE_LIST_ROWS), selectListThemeFromUi(theme), { minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 52 });
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
		return isHexColor(normalized) && !this.choices.some((choice) => choice.value.toLowerCase() === normalized);
	}
}

/** Open the `/hunk configure` live-preview TUI. Presets are the primary
 *  surface; Advanced opens the per-group settings editor. Esc saves to
 *  `.pi/hunk.json` from either top-level surface. */
export async function openHunkConfig(
	ctx: ExtensionCommandContext,
	getConfig: () => HunkConfig,
	applyConfig: (next: HunkConfig) => Promise<void>,
	getHighlighter: (config: HunkConfig, invalidate?: () => void) => Highlighter | undefined,
) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/hunk configure requires TUI mode.", "error");
		return;
	}
	let draft = cloneConfig(getConfig());
	let previewDraft = cloneConfig(draft);
	const presets = hunkConfigPresets();
	const groups = hunkConfigGroups();
	let theme = ctx.ui.theme;
	let requestPreviewRender: (() => void) | undefined;
	let closeDone: ((value?: void) => void) | undefined;
	let mode: "presets" | "advanced" = "presets";
	let currentGroup = -1;
	let groupLists: SettingsList[] = [];

	function previewConfig(): HunkConfig {
		return previewDraft;
	}

	function buildPreview(): Component {
		const config = previewConfig();
		if (!config.enabled) {
			return new StaticLines(() => [
				theme.fg("muted", "pi-hunk renderer disabled."),
				theme.fg("dim", "Pi will use default tool rendering until enabled again."),
			]);
		}
		const capped = { ...config, maxRenderedLines: Math.min(config.maxRenderedLines, CONFIGURE_PREVIEW_MAX_LINES) };
		return createDiffView({
			patch: HUNK_CONFIG_SAMPLE_PATCH,
			filePath: "preview.ts",
			cwd: ctx.cwd,
			title: "preview",
			config: capped,
			highlighter: getHighlighter(capped, requestPreviewRender),
			theme,
			liveSession: true,
			invalidate: requestPreviewRender,
		});
	}

	let preview = buildPreview();
	function rebuildPreview() {
		preview = buildPreview();
	}

	function saveAndClose() {
		saveProjectHunkConfig(ctx.cwd, draft)
			.then(() => applyConfig(draft))
			.then(() => ctx.ui.notify("Saved Hunk config to .pi/hunk.json.", "info"))
			.catch((error) => ctx.ui.notify(`Failed to save Hunk config: ${String(error)}`, "error"))
			.finally(() => closeDone?.());
	}

	function previewPreset(preset: HunkPreset | undefined) {
		previewDraft = preset ? applyHunkPreset(draft, preset) : cloneConfig(draft);
		rebuildPreview();
	}

	function applyPreset(preset: HunkPreset) {
		draft = applyHunkPreset(draft, preset);
		previewDraft = cloneConfig(draft);
		groupLists = buildGroupLists();
		rebuildPreview();
	}

	const presetItems: SelectItem[] = [
		...presets.map((preset) => ({ value: `preset:${preset.id}`, label: preset.label, description: preset.description })),
		{ value: "advanced", label: "Advanced", description: "Edit every group and slot on top of the chosen preset." },
	];
	const presetNav = new SelectList(presetItems, Math.min(presetItems.length, CONFIGURE_LIST_ROWS), selectListThemeFromUi(theme), { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 32 });
	presetNav.onSelectionChange = (item) => previewPreset(presets.find((preset) => item.value === `preset:${preset.id}`));
	presetNav.onSelect = (item) => {
		const preset = presets.find((candidate) => item.value === `preset:${candidate.id}`);
		if (preset) {
			applyPreset(preset);
			ctx.ui.notify(`Applied Hunk preset: ${preset.label}.`, "info");
			return;
		}
		mode = "advanced";
		currentGroup = -1;
		previewDraft = cloneConfig(draft);
		rebuildPreview();
	};
	presetNav.onCancel = saveAndClose;

	const settingsTheme = resolveSettingsListTheme(theme);
	const groupNav = new SelectList(
		groups.map((g, i) => ({ value: String(i), label: g.label, description: g.description })),
		Math.min(groups.length, CONFIGURE_LIST_ROWS),
		selectListThemeFromUi(theme),
	);
	groupNav.onSelect = (item) => {
		currentGroup = Number(item.value);
	};
	groupNav.onCancel = () => {
		mode = "presets";
		currentGroup = -1;
		previewDraft = cloneConfig(draft);
		rebuildPreview();
	};

	function buildGroupLists(): SettingsList[] {
		return groups.map((group) => {
			const items: SettingItem[] = group.specs.map((spec) => {
				const item: SettingItem = {
					id: spec.id,
					label: spec.label,
					currentValue: spec.get(draft),
					description: descriptionForSpec(spec, draft, theme),
				};
				item.submenu = (currentValue, done) =>
					new ChoicePicker(spec.label, choicesForSpec(spec, draft, theme), theme, done, currentValue, spec.id.startsWith("colors."), (value) => {
						spec.set(draft, value);
						previewDraft = cloneConfig(draft);
						item.currentValue = spec.get(draft);
						item.description = descriptionForSpec(spec, draft, theme);
						rebuildPreview();
					});
				return item;
			});
			return new SettingsList(
				items,
				Math.min(items.length, CONFIGURE_LIST_ROWS),
				settingsTheme,
				(id, newValue) => {
					const spec = group.specs.find((s) => s.id === id);
					if (!spec) return;
					spec.set(draft, newValue);
					previewDraft = cloneConfig(draft);
					const item = items.find((i) => i.id === id);
					if (item) {
						item.currentValue = spec.get(draft);
						item.description = descriptionForSpec(spec, draft, theme);
					}
					rebuildPreview();
				},
				() => {
					currentGroup = -1;
				},
				{ enableSearch: true },
			);
		});
	}
	groupLists = buildGroupLists();

	await ctx.ui.custom<void>((tui, nextTheme, _kb, done) => {
		theme = nextTheme;
		let renderedRows = 0;
		requestPreviewRender = () => {
			rebuildPreview();
			preview.invalidate();
			tui.requestRender();
		};
		closeDone = done as ((value?: void) => void) | undefined;
		return {
			render(width: number): string[] {
				const out: string[] = [];
				out.push(`${theme.fg("accent", theme.bold("Hunk Configuration"))} ${theme.fg("dim", "· presets + live Shiki preview")}`);
				if (mode === "presets") {
					out.push(theme.fg("dim", "↑↓ preview preset · Enter apply/open Advanced · Esc saves & closes"));
				} else if (currentGroup === -1) {
					out.push(theme.fg("dim", "Advanced · Enter opens group · Esc back to presets"));
				} else {
					out.push(`${theme.fg("dim", "Esc back to groups")} ${theme.fg("dim", "·")} ${theme.fg("muted", groups[currentGroup].label)}`);
				}
				out.push("");
				if (mode === "presets") {
					out.push(...presetNav.render(width));
				} else if (currentGroup === -1) {
					out.push(...groupNav.render(width));
				} else {
					out.push(...groupLists[currentGroup].render(width));
				}
				out.push("");
				out.push(`${theme.fg("accent", "✦")} ${theme.fg("toolTitle", theme.bold("Preview"))}`);
				out.push(...preview.render(Math.max(40, width)));
				renderedRows = Math.max(renderedRows, out.length);
				while (out.length < renderedRows) out.push(" ".repeat(Math.max(0, width)));
				return out.map((line) => truncateToWidth(line, width));
			},
			invalidate() {
				presetNav.invalidate();
				groupNav.invalidate();
				groupLists.forEach((g) => g.invalidate());
				preview.invalidate();
			},
			handleInput(data: string) {
				if (mode === "presets") {
					presetNav.handleInput(data);
				} else if (currentGroup === -1) {
					groupNav.handleInput(data);
				} else {
					groupLists[currentGroup].handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
}
