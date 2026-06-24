# pi-huff

[![npm version](https://img.shields.io/npm/v/@roodriigoooo/pi-huff.svg)](https://www.npmjs.com/package/@roodriigoooo/pi-huff)

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
pi install git:github.com/roodriigoooo/pi-huff@v0.2.0
```

You need the `hunk` CLI on your PATH only if you use the review bridge. The diff renderer works on its own.

## Commands

- `/huff status` probes `hunk session get --repo <cwd>` and reports whether a live Hunk session is attached.
- `/huff send` reads `hunk session comment list --repo <cwd> --type user --json`, shapes the user notes by file and line, and sends them to the agent as a follow-up when idle or as steering when streaming.
- `/huff auto on|off` opts in to automatic pickup before each agent turn. `on` sends notes only when at least two user notes exist, and unchanged duplicate notes are not re-sent. Pickup is scoped to notes that overlap a recent edit by file and line, so notes about untouched files do not trigger injection on their own.
- `/huff review` opens a read-only view that pairs each open user note with whether a recent edit touched its line (`✓ addressed`) or not (`○ pending`). It never sends anything to the agent.
- `/huff configure` opens the configuration TUI.

## LLM-callable tool

- `huff_review_notes` gives the model read-only, live-session-gated access to the same `type=user` notes. It returns semantic notes, not raw CLI access. The tool's prompt guidelines tell the model to address notes comment-by-comment and to never create, apply, edit, remove, or clear comments.

## Checks

```bash
npm run check
```

Runs two scripts:

- `scripts/units.mjs` tests the exposed seams directly: `parseUnifiedPatch` for structure, line numbers, word-emphasis ranges, side-aware strike highlighting, tint persistence across Shiki token resets, and no phantom trailing line; `normalizeHunkComments` for shape tolerance, dedup, and the `type=user` filter.
- `scripts/smoke.mjs` loads the extension through pi's Jiti runtime, drives synthetic `write` and `edit` calls, verifies ANSI rendering, verifies no sidecars are written, tests auto review pickup, exercises the `/huff configure` live-preview UI, and dry-runs the Hunk comment parser against a fake live session.

The check scripts locate pi by `PI_CODING_AGENT_ROOT` or a few common install paths (global npm, `node_modules`, `~/.pi/agent/npm`). Set `PI_CODING_AGENT_ROOT` if pi lives somewhere else.

## Project layout

- `src/config.ts` config types, defaults, value menus, legacy migration, palette resolution, and shiki theme selection.
- `src/paths.ts` path resolution and display helpers.
- `src/render-records.ts` in-memory store of recent rendered edits.
- `src/diff-view.ts` the DiffView module: unified-patch parser, word-emphasis model, and renderer.
- `src/hunk-bridge.ts` the ReviewBridge module: Hunk CLI exec, comment normalization, note shaping, pickup and dedup policy, note-to-edit correlation, and the read-only review pairing.
- `src/configure.ts` the `/huff configure` TUI.
- `src/index.ts` extension entry: wires modules and registers tools, commands, and events.

## License

MIT