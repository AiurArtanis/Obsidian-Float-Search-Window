import { TFile } from "obsidian";

type MatchRange = [number, number];

/** The parts of Obsidian's (internal) search result tree items that this plugin relies on. */
export interface SearchResultItem {
	el: HTMLElement;
	dom?: HTMLElement;
	containerEl?: HTMLElement;
	/** Set on file items. */
	file?: TFile;
	/** For match items this is the owning file item. */
	parent?: SearchResultItem;
	content?: string;
	matches?: MatchRange[];
	result?: { content?: MatchRange[]; properties?: unknown };
	match?: unknown;
	vChildren?: SearchResultCollection;
	collapsible?: boolean;
	collapseEl?: HTMLElement;
	setCollapse?(collapsed: boolean, animate?: boolean): void;
	mutateEState?(eState: Record<string, unknown>): void;
}

export interface SearchResultCollection {
	children: SearchResultItem[];
	_children?: SearchResultItem[];
}

export interface SearchResultDom {
	el: HTMLElement;
	focusedItem: SearchResultItem | null;
	vChildren: SearchResultCollection;
	resultDomLookup: Map<TFile, SearchResultItem>;
	children?: SearchResultItem[];
	addResult?(file: TFile, ...args: unknown[]): SearchResultItem | undefined;
	removeResult?(file: TFile): SearchResultItem | undefined;
	setFocusedItem(item: SearchResultItem | null): void;
	changeFocusedItem(direction: "forwards" | "backwards"): void;
}

export interface ResolvedResult {
	file: TFile;
	/** Ephemeral state that scrolls to / highlights the match, when the item is a match. */
	eState?: Record<string, unknown>;
	/** Identifies the exact result, so a repeated preview of the same result can be detected. */
	key: string;
}

/**
 * The legacy `keyCode` of a key event. WebKit (Obsidian on iOS) fires the
 * keydown that commits an IME composition after `compositionend`, with
 * `isComposing` false and `key` "Enter": only its keyCode, 229, tells.
 */
type LegacyKeyCode = { readonly keyCode?: number };

export function isComposingEvent(e: KeyboardEvent): boolean {
	// keyCode 229 is what IMEs report while a composition is in progress.
	return e.isComposing || e.key === "Process" || (e as LegacyKeyCode).keyCode === 229;
}

export function resolveResultItem(
	item: SearchResultItem | null | undefined
): ResolvedResult | null {
	if (!item) return null;
	if (item.file instanceof TFile) {
		return { file: item.file, key: item.file.path };
	}
	const file = item.parent?.file;
	if (!(file instanceof TFile)) return null;
	const eState: Record<string, unknown> = {
		match: { content: item.content, matches: item.matches ?? [] },
	};
	item.mutateEState?.(eState);
	return {
		file,
		eState,
		key: `${file.path}#${item.matches?.[0]?.[0] ?? ""}`,
	};
}
