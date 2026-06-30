import { type HunkConfig, loadConfig } from "./config";
import { createHighlighterCache, type HighlighterCache } from "./highlighter-cache";
import { createHunkBridge, runHunkJson, type ReviewBridge } from "./hunk-bridge";
import { createPatchSource, createReviewedPatchSource, type PatchSource, type ReviewedPatchSource } from "./patch-source";
import { createAgentEditPatchSource, createRenderRecordStore, type RenderRecordStore } from "./render-records";

// ============================================================================
// ExtensionState — one handle for the extension's mutable closure state
// ============================================================================
//
// `session_start`, `before_agent_start`, the `/hunk` command, the edit/write
// renders, and the review tool all depend on this one seam instead of scattered
// closure captures and long handler parameter lists. Config + live-session are
// getters/setters so every handler reads the latest value; the highlighter
// cache, record store, and bridge are wired once here and never re-threaded.

export interface ExtensionState {
	getConfig(): HunkConfig;
	setConfig(next: HunkConfig): void;
	getLiveSession(): boolean;
	setLiveSession(live: boolean): void;
	readonly highlighters: HighlighterCache;
	readonly records: RenderRecordStore;
	readonly patchSource: PatchSource;
	readonly reviewedSource: ReviewedPatchSource;
	readonly bridge: ReviewBridge;
	/** Reload config for a session cwd and refresh the highlighter cache. */
	reloadConfig(cwd: string): Promise<HunkConfig>;
}

/** Build the extension state: load config, create the highlighter cache, the
 *  record store, the patch-source composite (reviewed patch preferred, agent-edit
 *  fallback), and the bridge over that one source. */
export async function createExtensionState(): Promise<ExtensionState> {
	let config = await loadConfig(process.cwd());
	let liveSession = false;

	const highlighters = createHighlighterCache();
	const records = createRenderRecordStore();
	const agentEditSource = createAgentEditPatchSource(records);
	const reviewedSource = createReviewedPatchSource((cwd, cfg, signal) =>
		runHunkJson(cwd, ["session", "review", "--repo", cwd, "--include-patch", "--include-notes", "--json"], cfg, 20_000, signal),
	);
	const patchSource = createPatchSource(reviewedSource, agentEditSource);
	const bridge = createHunkBridge(patchSource);

	await highlighters.refresh(config);

	return {
		getConfig: () => config,
		setConfig: (next) => {
			config = next;
		},
		getLiveSession: () => liveSession,
		setLiveSession: (live) => {
			liveSession = live;
		},
		highlighters,
		records,
		patchSource,
		reviewedSource,
		bridge,
		async reloadConfig(cwd) {
			config = await loadConfig(cwd);
			await highlighters.refresh(config);
			return config;
		},
	};
}
