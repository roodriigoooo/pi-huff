# pi-hunk

[![npm version](https://img.shields.io/npm/v/@roodriigoooo/pi-hunk.svg)](https://www.npmjs.com/package/@roodriigoooo/pi-hunk)

A pi extension that replaces pi's default `write` and `edit` tool output with Shiki-highlighted, word-emphasised terminal diffs, and adds a read-only bridge so a human can review those changes in a live [Hunk](https://github.com/modem-dev/hunk) session and attach their inline review state to the agent.

## Two halves

1. **Diff renderer.** Every `write` and `edit` result renders through pi-hunk with Shiki syntax tokenisation, word-level highlights via `diffWordsWithSpace`, compact folding of unchanged regions, line numbers, hunk captions, changed-line gutter bars, and a bordered file header.
2. **Read-only Hunk bridge.** While the agent works, you run `hunk diff --watch` in a second terminal on the same repo and add comments with `c`. pi-hunk reads only the comments you authored (`type=user`) and attaches them to the agent as review state. pi-hunk never creates, edits, applies, removes, or clears Hunk comments, and it writes no patch or sidecar files.

## Install

```bash
pi install npm:@roodriigoooo/pi-hunk
```

Then restart pi (or run `/reload`). To install a pinned git ref instead:

```bash
pi install git:github.com/roodriigoooo/pi-hunk@v0.6.0
```

You need the `hunk` CLI on your PATH only if you use the review bridge. The diff renderer works on its own.

## Commands

- `/hunk status` probes `hunk session get --repo <cwd>` and reports whether a live Hunk session is attached.
- `/hunk send` reads `hunk session comment list --repo <cwd> --type user --json`, shapes the open review state by file and line, and attaches it to the agent as a follow-up when idle or as steering when streaming.
- `/hunk on|off` opts in/out of automatic pickup before each agent turn. Pickup is scoped to notes that overlap a recent edit by file and line, and unchanged duplicate review states are not re-attached. `/hunk auto on|off` remains accepted for compatibility.
- `/hunk review` opens a read-only view that pairs each open user note with whether a recent edit touched its line (`✓ touched`) or not (`○ open`). It never sends anything to the agent.
- `/hunk configure` opens the preset-first configuration TUI; Advanced keeps per-setting control.

## LLM-callable tool

- `hunk_review_notes` gives the model read-only, live-session-gated access to the same `type=user` notes. It returns semantic notes, not raw CLI access. The tool's prompt guidelines tell the model to address notes comment-by-comment and to never create, apply, edit, remove, or clear comments.

## Checks

```bash
npm run check
```

Runs two scripts:

- `scripts/units.mjs` tests the exposed seams directly: `parseUnifiedPatch` for structure, line numbers, word-emphasis ranges, side-aware strike highlighting, tint persistence across Shiki token resets, and no phantom trailing line; `normalizeHunkComments` for shape tolerance, dedup, and the `type=user` filter.
- `scripts/smoke.mjs` loads the extension through pi's Jiti runtime, drives synthetic `write` and `edit` calls, verifies ANSI rendering, verifies no sidecars are written, tests auto review pickup, exercises the `/hunk configure` live-preview UI, and dry-runs the Hunk comment parser against a fake live session.

The check scripts locate pi by `PI_CODING_AGENT_ROOT` or a few common install paths (global npm, `node_modules`, `~/.pi/agent/npm`). Set `PI_CODING_AGENT_ROOT` if pi lives somewhere else.

## Project layout

- `src/config.ts` config types, defaults, value menus, legacy migration, palette resolution, and shiki theme selection.
- `src/paths.ts` path resolution and display helpers.
- `src/render-records.ts` in-memory store of recent rendered edits.
- `src/diff-view.ts` the DiffView module: unified-patch parser, word-emphasis model, and renderer.
- `src/hunk-bridge.ts` the ReviewBridge module: Hunk CLI exec, comment normalization, note shaping, pickup and dedup policy, note-to-edit correlation, and the read-only review pairing.
- `src/configure.ts` the `/hunk configure` TUI.
- `src/index.ts` extension entry: wires modules and registers tools, commands, and events.

## License

MIT