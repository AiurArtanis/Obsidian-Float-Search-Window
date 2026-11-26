import { SearchView, WorkspaceLeaf, debounce } from "obsidian";
import { around } from "monkey-around";
import { getActiveLeaf } from "./activeLeaf";
import type FloatSearchPlugin from "./floatSearchIndex";
import { EmbeddedView, isEmebeddedLeaf, spawnLeafView } from "./leafView";
import { openVaultFile } from "./openFile";
import { isComposingEvent, resolveResultItem } from "./searchResults";

export function attachNativeSearchPreview(plugin: FloatSearchPlugin, view: SearchView): (() => void) | undefined {
	const input = view.searchComponent?.inputEl;
	const dom = view.dom;
	if (!input || !dom || isEmebeddedLeaf(view.leaf)) return;

	const { workspace } = plugin.app;
	let pane: HTMLElement | undefined;
	let leaf: WorkspaceLeaf | undefined;
	let embedded: EmbeddedView | undefined;
	let key: string | undefined;
	let request = 0;
	let queue = Promise.resolve();

	const close = () => {
		request++;
		follow.cancel();
		leaf?.detach();
		embedded?.unload();
		pane?.remove();
		view.containerEl.removeClass("float-search-has-preview");
		pane = undefined;
		leaf = undefined;
		embedded = undefined;
		key = undefined;
	};

	const show = (focus: boolean) => {
		const result = resolveResultItem(dom.focusedItem);
		if (!result) return;
		if (leaf && key === result.key) {
			if (focus) workspace.setActiveLeaf(leaf, { focus: true });
			return;
		}
		const sequence = ++request;
		queue = queue.then(async () => {
			if (sequence !== request) return;
			if (!pane) {
				pane = view.containerEl.createDiv({ cls: "float-search-native-preview" });
				view.containerEl.addClass("float-search-has-preview");
				pane.addEventListener("keydown", (event) => {
					if (isComposingEvent(event)) return;
					const back = (event.ctrlKey && (event.key === "g" || event.key === "Tab")) ||
						(event.shiftKey && event.key === "Tab") || event.key === "Escape";
					if (!back) return;
					event.preventDefault();
					event.stopPropagation();
					workspace.setActiveLeaf(view.leaf, { focus: false });
					input.focus();
				}, true);
				const previous = getActiveLeaf(workspace);
				[leaf, embedded] = spawnLeafView(plugin, pane, view.leaf);
				if (previous && getActiveLeaf(workspace) !== previous) {
					workspace.setActiveLeaf(previous, { focus: false });
				}
				leaf.setPinned(true);
			}
			if (!leaf) return;
			await openVaultFile(plugin.app, result.file, { leaf, active: false, eState: result.eState, preview: true });
			if (sequence === request) key = result.key;
		}).catch((error: unknown) => {
			if (sequence === request) close();
			console.error("Float Search Window: failed to preview search result", error);
		});
	};

	const follow = debounce(() => { if (pane) show(false); }, 150, true);
	const unpatch = around(dom, {
		setFocusedItem(old) {
			return function (this: typeof dom, item) {
				old.call(this, item);
				if (pane && !item) close();
				else if (pane) follow();
			};
		},
	});
	const onTab = (event: KeyboardEvent) => {
		if (event.key !== "Tab" || event.ctrlKey || event.metaKey || event.altKey ||
			isComposingEvent(event) || pane?.contains(input.ownerDocument.activeElement)) return;
		if (event.shiftKey ? !pane : !dom.focusedItem) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.shiftKey) close();
		else show(true);
	};
	view.containerEl.addEventListener("keydown", onTab, true);
	input.addEventListener("input", close);
	return () => {
		close();
		unpatch();
		view.containerEl.removeEventListener("keydown", onTab, true);
		input.removeEventListener("input", close);
	};
}
