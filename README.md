# pi-huff

`huff` = hunk + diff. A pi extension that replaces pi's default `write` and `edit` tool output with Shiki-highlighted, word-emphasised terminal diffs, and adds a read-only bridge so a human can review those changes in a live [Hunk](https://github.com/hunk) session and feed their inline notes back to the agent.

## Two halves

1. **Diff renderer.** Every `write` and `edit` result renders through Huff with Shiki syntax tokenisation, word-level highlights via `diffWordsWithSpace`, compact folding of unchanged regions, line numbers, hunk captions, changed-line gutter bars, and a bordered file header.
2. **Read-only Hunk bridge.** While the agent works, you run `hunk diff --watch` in a second terminal on the same repo and add comments with `c`. Huff reads only the comments you authored (`type=user`) and sends them to the agent. Huff never creates, edits, applies, removes, or clears Hunk comments, and it writes no patch or sidecar files.

## Install

```bash
pi install npm:@roodriigoooo/pi-huff
```

Then restart pi (or run `/reload`). To install a pinned git ref instead:

```bash
pi install git:github.com/roodriigoooo/pi-huff@v0.1.0
```

You need the `hunk` CLI on your PATH only if you use the review bridge. The diff renderer works on its own.

## Commands

- `/huff status` probes `hunk session get --repo <cwd>` and reports whether a live Hunk session is attached.
- `/huff send` reads `hunk session comment list --repo <cwd> --type user --json`, shapes the user notes by file and line, and sends them to the agent as a follow-up when idle or as steering when streaming.
- `/huff auto on|off` opts in to automatic pickup before each agent turn. `on` sends notes only when at least two user notes exist, and unchanged duplicate notes are not re-sent.
- `/huff configure` opens a live-preview configuration TUI. Cycle values with Enter or Space, filter by typing, and Esc writes `.pi/huff.json` and applies it immediately. A sample diff previews every change.

## LLM-callable tool

- `huff_review_notes` gives the model read-only, live-session-gated access to the same `type=user` notes. It returns semantic notes, not raw CLI access. The tool's prompt guidelines tell the model to address notes comment-by-comment and to never create, apply, edit, remove, or clear comments.

## Configuration

Huff merges global config from `~/.pi/agent/huff.json` with project config from `.pi/huff.json`. Project config wins.

```json
{
  "diffTheme": "auto",
  "shikiDarkTheme": "github-dark",
  "shikiLightTheme": "github-light",
  "maxRenderedLines": 260,
  "contextRadius": 6,
  "lineNumbers": true,
  "compactUnchanged": true,
  "wordHighlight": "bold",
  "lineHighlight": "gutter",
  "header": "box",
  "colors": {
    "add": "auto",
    "remove": "auto",
    "context": "auto",
    "meta": "dim",
    "header": "title",
    "gutter": "auto",
    "lineNo": "dim"
  },
  "symbols": {
    "add": "+",
    "remove": "−",
    "context": " ",
    "fold": "⋯",
    "gutter": "▎"
  },
  "showHunkHint": true,
  "hunk": {
    "enabled": true,
    "binary": "hunk",
    "reviewTool": true,
    "autoReviewNotes": false,
    "autoReviewNotesMin": 2
  }
}
```

### Colors

Color slots are semantic refs, not raw ANSI. Each accepts:

- `auto` to derive from the pi theme
- a friendly alias: `green`, `red`, `gray`, `dim`, `muted`, `accent`, `title`, `warning`
- a theme slot like `theme:toolDiffAdded`
- a hex color like `#80dc78`

Slots: `colors.add`, `colors.remove`, `colors.context` for diff side colors; `colors.meta` for fold and meta lines; `colors.header` for the file header; `colors.gutter` for the change marker, where `auto` follows the side; `colors.lineNo` for line numbers.

### Style options

- `lineHighlight`: `none` | `gutter` | `bar` | `tint` (how changed lines are marked)
- `wordHighlight`: `none` | `bold` | `underline` | `inverse` | `strike` | `color` (default `bold`)
- `symbols`: `add`, `remove`, `context`, `fold`, `gutter` glyphs
- `header`: `box` | `compact` | `minimal`
- `lineNumbers`: `false` | `true` | `changed`

Legacy `emphStyle` and `wordHighlights` still work and migrate to `wordHighlight`.

## Checks

```bash
npm run check
```

Runs two scripts:

- `scripts/units.mjs` tests the exposed seams directly: `parseUnifiedPatch` for structure, line numbers, word-emphasis ranges, and no phantom trailing line; `normalizeHunkComments` for shape tolerance, dedup, and the `type=user` filter.
- `scripts/smoke.mjs` loads the extension through pi's Jiti runtime, drives synthetic `write` and `edit` calls, verifies ANSI rendering, verifies no sidecars are written, tests auto review pickup, exercises the `/huff configure` live-preview UI, and dry-runs the Hunk comment parser against a fake live session.

The check scripts locate pi by `PI_CODING_AGENT_ROOT` or a few common install paths (global npm, `node_modules`, `~/.pi/agent/npm`). Set `PI_CODING_AGENT_ROOT` if pi lives somewhere else.

## Project layout

- `src/config.ts` config types, defaults, value menus, legacy migration, palette resolution, and shiki theme selection.
- `src/paths.ts` path resolution and display helpers.
- `src/render-records.ts` in-memory store of recent rendered edits.
- `src/diff-view.ts` the DiffView module: unified-patch parser, word-emphasis model, and renderer.
- `src/hunk-bridge.ts` the ReviewBridge module: Hunk CLI exec, comment normalization, note shaping, and pickup and dedup policy.
- `src/configure.ts` the `/huff configure` live-preview TUI.
- `src/index.ts` extension entry: wires modules and registers tools, commands, and events.

## License

MIT