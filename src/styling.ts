import type { Theme } from "@earendil-works/pi-coding-agent";
import { type HighlighterGeneric } from "shiki";
import { ansiFg, type DiffSide, type HunkConfig, type WordHighlight } from "./config";

// ============================================================================
// Token styling — the single adapter point for Shiki color → ANSI
// ============================================================================
//
// Side color, word emphasis, and Shiki token-reset recovery live here so future
// Shiki color-replacement work has one place to change, not hidden renderer
// logic. The load-bearing invariant is **tint surviving token resets**: every
// emphasized token is emitted as `start + text + reset + sideAnsi`, so a side
// background tint (or side foreground) is re-applied after each Shiki reset and
// never bleeds away mid-line. `styleToken` is the only function that wraps a
// token this way; `renderCodeLine` is the only function that assembles a line
// from tokens. Keep it that way.

export type Highlighter = HighlighterGeneric<string, string>;

/** One Shiki token line: a list of `{ content, color }` tokens. */
export type ShikiTokenLine = ReturnType<Highlighter["codeToTokensBase"]>[number];

export type Range = { start: number; end: number };

export const ANSI_RESET = "\x1b[0m";

/** ANSI sequence for a word-emphasis style on a given side. Empty when `none`. */
export function wordHighlightAnsi(style: WordHighlight, side: DiffSide, theme: Theme): string {
	if (style === "none") return "";
	if (style === "bold") return "\x1b[1m";
	if (style === "underline") return "\x1b[1;4m";
	if (style === "inverse") return "\x1b[1;7m";
	if (style === "strike") return side === "remove" ? "\x1b[1;9m" : "\x1b[1;4m";
	if (style === "color") return side === "add" ? theme.getFgAnsi("accent") || "" : theme.getFgAnsi("warning") || theme.getFgAnsi("error") || "";
	return "";
}

export function inRanges(index: number, ranges: Range[]): boolean {
	return ranges.some((r) => index >= r.start && index < r.end);
}

/** Style a single Shiki token character, re-applying `sideAnsi` after the reset.
 *  This is the tint-survives-resets seam: `start + text + reset + sideAnsi`. */
export function styleToken(text: string, color: string | undefined, emph: boolean, side: DiffSide, config: HunkConfig, theme: Theme, sideAnsi: string): string {
	let start = ansiFg(color);
	if (emph) start += wordHighlightAnsi(config.wordHighlight, side, theme);
	if (!start) return text;
	return `${start}${text}${ANSI_RESET}${sideAnsi}`;
}

/** Render a code line from Shiki tokens, mapping word-emphasis ranges onto the
 *  token stream. Falls back to a plain side-coloured line when tokenization is
 *  unavailable. `sideAnsi` (side color, optionally carrying a tint background)
 *  is prepended and re-applied after every token reset. */
export function renderCodeLine(
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
