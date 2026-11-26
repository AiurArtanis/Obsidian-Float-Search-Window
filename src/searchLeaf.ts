import { App, PaneType, SearchView, WorkspaceLeaf, requireApiVersion } from "obsidian";
import { DEFAULT_SETTINGS, searchState } from "./floatSearchTypes";
import { isEmebeddedLeaf } from "./leafView";

export function isSidebarLeaf(leaf: WorkspaceLeaf): boolean {
	const side = leaf.getRoot()?.side;
	return side === "left" || side === "right";
}

export function isPopoutLeaf(leaf: WorkspaceLeaf): boolean {
	return leaf.getContainer?.()?.type === "window";
}

/** Search leaves that live in the workspace (not inside a float search modal or preview). */
export function getWorkspaceSearchLeaves(app: App): WorkspaceLeaf[] {
	return app.workspace
		.getLeavesOfType("search")
		.filter((leaf) => !isEmebeddedLeaf(leaf));
}

export function findSidebarSearchLeaf(app: App): WorkspaceLeaf | null {
	const leaves = getWorkspaceSearchLeaves(app).filter(isSidebarLeaf);
	// Prefer the left sidebar (where the core search lives by default).
	return (
		leaves.find((leaf) => leaf.getRoot()?.side === "left") ??
		leaves[0] ??
		null
	);
}

export function focusSearchInput(leaf: WorkspaceLeaf | null | undefined) {
	const view = leaf?.view as SearchView | undefined;
	const inputEl =
		view?.searchComponent?.inputEl ??
		leaf?.containerEl.querySelector<HTMLInputElement>("input");
	inputEl?.focus();
}

export function nativeSearchState(state: searchState): searchState {
	if (state.sortOrder === "byRelevance" && !requireApiVersion("1.15.1")) {
		return { ...state, sortOrder: DEFAULT_SETTINGS.searchViewState.sortOrder };
	}
	return state;
}

export async function revealSearchLeaf(app: App, leaf: WorkspaceLeaf): Promise<void> {
	const { workspace } = app;
	if (requireApiVersion("1.7.2") && typeof workspace.revealLeaf === "function") {
		await workspace.revealLeaf(leaf);
		return;
	}
	const root = leaf.getRoot() as { side?: string; expand?: () => void } | null;
	if (root?.side) root.expand?.();
	workspace.setActiveLeaf(leaf, { focus: true });
}

/** Reuse the native sidebar search before creating a workspace view. */
export async function initSearchViewWithLeaf(
	app: App,
	type: PaneType | "sidebar",
	state?: Partial<searchState>
): Promise<WorkspaceLeaf | null> {
	let leaf: WorkspaceLeaf | null;
	if (type === "sidebar") {
		leaf = findSidebarSearchLeaf(app) ?? app.workspace.getLeftLeaf(false);
	} else {
		leaf = app.workspace.getLeaf(type);
		leaf?.setPinned(true);
	}
	if (!leaf) return null;

	await leaf.setViewState({
		type: "search",
		active: true,
		state: nativeSearchState({ ...DEFAULT_SETTINGS.searchViewState, ...state, triggerBySelf: true }),
	});
	await revealSearchLeaf(app, leaf);

	if (leaf.view.getViewType() !== "search" || !leaf.containerEl.isConnected) return leaf;
	focusSearchInput(leaf);
	const inputEl = (leaf.view as SearchView).searchComponent?.inputEl;
	if (inputEl && state) {
		const cursor = state.cursor ?? (state.current ? 0 : inputEl.value.length);
		inputEl.setSelectionRange(cursor, cursor);
	}
	return leaf;
}
