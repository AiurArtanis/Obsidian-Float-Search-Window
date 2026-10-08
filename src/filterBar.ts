import {
	App,
	debounce,
	prepareFuzzySearch,
	SearchResult,
	SearchView,
	TFile,
} from "obsidian";
import { strings } from "./i18n";
import { around } from "monkey-around";

export interface FilterHost {
	settings: {
		filterIncludeBases: boolean;
		filterIncludeCanvas: boolean;
		filterStarredOnly: boolean;
		filterMatchCase: boolean;
		filterUseRegex: boolean;
	};
	saveSettings: () => Promise<void>;
	app: App;
}

const CASE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M90.86,50.89a12,12,0,0,0-21.72,0l-64,136a12,12,0,0,0,21.71,10.22L42.44,164h75.12l15.58,33.11a12,12,0,0,0,21.72-10.22ZM53.74,140,80,84.18,106.27,140ZM200,84c-13.85,0-24.77,3.86-32.45,11.48a12,12,0,1,0,16.9,17c3-3,8.26-4.52,15.55-4.52,11,0,20,7.18,20,16v4.39A47.28,47.28,0,0,0,200,124c-24.26,0-44,17.94-44,40s19.74,40,44,40a47.18,47.18,0,0,0,22-5.38A12,12,0,0,0,244,192V124C244,101.94,224.26,84,200,84Zm0,96c-11,0-20-7.18-20-16s9-16,20-16,20,7.18,20,16S211,180,200,180Z"/></svg>`;

const REGEX_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><circle cx="46" cy="128" r="22"/><g transform="translate(48 8) scale(0.78)"><path d="M212.45,107.14l-65.19,26.08,46.21,59.41a12,12,0,1,1-18.94,14.74L128,147.55,81.47,207.37a12,12,0,0,1-18.94-14.74l46.21-59.41L43.55,107.14a12,12,0,1,1,8.91-22.28L116,110.28V40a12,12,0,0,1,24,0v70.28l63.54-25.42a12,12,0,1,1,8.91,22.28Z"/></g></svg>`;

export function getBookmarkedPaths(app: App): Set<string> {
	const paths = new Set<string>();
	const inst =
		(app as any).internalPlugins?.getEnabledPluginById?.("bookmarks") ??
		(app as any).internalPlugins?.plugins?.bookmarks?.instance;
	if (!inst) return paths;
	const items = inst.getBookmarks?.() ?? [];
	const walk = (item: any) => {
		if (!item) return;
		if (item.type === "file" && typeof item.path === "string") {
			paths.add(item.path);
		}
		if (Array.isArray(item.items)) item.items.forEach(walk);
		if (Array.isArray(item.children)) item.children.forEach(walk);
	};
	if (Array.isArray(items)) items.forEach(walk);
	return paths;
}

export function isFileAllowed(
	plugin: FilterHost,
	file: TFile,
	bookmarks: Set<string> | null
): boolean {
	if (bookmarks && !bookmarks.has(file.path)) return false;
	if (file.extension === "base") return plugin.settings.filterIncludeBases;
	if (file.extension === "canvas") return plugin.settings.filterIncludeCanvas;
	return true;
}

export function compileQueryRegex(
	plugin: FilterHost,
	query: string
): RegExp | null {
	if (!plugin.settings.filterUseRegex || !query.trim()) return null;
	try {
		return new RegExp(
			query,
			plugin.settings.filterMatchCase ? "m" : "im"
		);
	} catch {
		return null;
	}
}

/** Use the native parser for regex searches, rather than filtering a literal search. */
export function buildNativeRegexQuery(plugin: FilterHost, query: string): string {
	if (!plugin.settings.filterUseRegex || !query.trim()) return query;
	const source = compileQueryRegex(plugin, query)?.source ?? "(?!)";
	// Obsidian's query tokenizer treats every unescaped slash as a delimiter,
	// including slashes inside character classes (which RegExp.source leaves raw).
	const escaped = source.replace(/\//g, (_slash, offset: number) => {
		let backslashes = 0;
		for (let i = offset - 1; i >= 0 && source[i] === "\\"; i--) backslashes++;
		return backslashes % 2 ? "/" : "\\/";
	});
	return `/${escaped}/ OR path:/${escaped}/`;
}

/** Adapt only this floating view; keep the input and persisted query unmodified. */
export function bindNativeRegexSearch(view: SearchView, plugin: FilterHost): () => void {
	const target = view as SearchView & { startSearch: () => void };
	const component = view.searchComponent;
	if (typeof target.startSearch !== "function" || typeof component?.getValue !== "function") {
		return () => {};
	}
	return around(target, {
		startSearch(old) {
			return function () {
				const getValue = component.getValue;
				// startSearch reads its query synchronously, before requesting layout saves.
				// Restore on the first read so state/history always retain the user's input.
				component.getValue = () => {
					component.getValue = getValue;
					return buildNativeRegexQuery(plugin, getValue.call(component));
				};
				try {
					return old.call(this);
				} finally {
					component.getValue = getValue;
				}
			};
		},
	});
}

export function textMatches(
	plugin: FilterHost,
	text: string,
	query: string
): boolean {
	return matchAsSearchResult(plugin, text, query) !== null;
}

export function matchAsSearchResult(
	plugin: FilterHost,
	text: string,
	query: string
): SearchResult | null {
	if (!query.trim()) return null;
	if (!plugin.settings.filterUseRegex && !plugin.settings.filterMatchCase) {
		return prepareFuzzySearch(query)(text);
	}
	if (plugin.settings.filterUseRegex) {
		const re = compileQueryRegex(plugin, query);
		if (!re) return null;
		const m = re.exec(text);
		if (!m) return null;
		return { score: 1, matches: [[m.index, m.index + m[0].length]] };
	}
	const idx = text.indexOf(query);
	if (idx < 0) return null;
	return { score: 1, matches: [[idx, idx + query.length]] };
}

export function applyNativeResultFilters(
	view: SearchView,
	plugin: FilterHost
): void {
	const bookmarks = plugin.settings.filterStarredOnly
		? getBookmarkedPaths(plugin.app)
		: null;
		const dom = (view as any).dom;
	const children: any[] =
		dom?.vChildren?._children ??
		dom?.children ??
		[];

	const applyToFile = (file: TFile | undefined, el: HTMLElement | undefined) => {
		if (!file || !el) return;
		const show = isFileAllowed(plugin, file, bookmarks);
		el.style.display = show ? "" : "none";
	};

	if (children.length) {
		for (const child of children) {
			applyToFile(
				child.file,
				child.el ?? child.containerEl ?? child.dom
			);
		}
		return;
	}

	view.containerEl.querySelectorAll(".search-result").forEach((node) => {
		const el = node as HTMLElement;
		const path =
			el.getAttribute("data-path") ||
			el.querySelector("[data-path]")?.getAttribute("data-path") ||
			"";
		const file = path
			? plugin.app.vault.getAbstractFileByPath(path)
			: null;
		if (file instanceof TFile) applyToFile(file, el);
	});
}

export function mountFilterBar(
	anchor: HTMLElement,
	plugin: FilterHost,
	onChange: () => void
): HTMLElement {
	const s = strings();
	const row = document.createElement("div");
	row.className = "float-search-filter-row";

	const addCheck = (
		label: string,
		get: () => boolean,
		set: (v: boolean) => void
	) => {
		const wrap = row.createEl("label", { cls: "fs-filter-check" });
		const input = wrap.createEl("input", { type: "checkbox" });
		input.checked = get();
		wrap.appendText(label);
		input.addEventListener("change", async () => {
			set(input.checked);
			await plugin.saveSettings();
			onChange();
		});
	};

	addCheck(
		s.filterBases,
		() => plugin.settings.filterIncludeBases,
		(v) => {
			plugin.settings.filterIncludeBases = v;
		}
	);
	addCheck(
		s.filterCanvas,
		() => plugin.settings.filterIncludeCanvas,
		(v) => {
			plugin.settings.filterIncludeCanvas = v;
		}
	);

	const seg = row.createDiv({ cls: "fs-filter-seg" });
	seg.setAttribute("role", "radiogroup");
	seg.setAttribute("aria-label", s.filterStarredOnly);
	const addSeg = (label: string, starredOnly: boolean) => {
		const btn = seg.createEl("button", { type: "button", text: label });
		if (plugin.settings.filterStarredOnly === starredOnly) {
			btn.addClass("is-active");
		}
		btn.onclick = async () => {
			plugin.settings.filterStarredOnly = starredOnly;
			seg.querySelectorAll("button").forEach((b) =>
				b.removeClass("is-active")
			);
			btn.addClass("is-active");
			await plugin.saveSettings();
			onChange();
		};
	};
	addSeg(s.filterAll, false);
	addSeg(s.filterStarredOnly, true);

	row.createDiv({ cls: "fs-filter-spacer" });

	const addIcon = (
		label: string,
		svg: string,
		get: () => boolean,
		set: (v: boolean) => void
	) => {
		const btn = row.createEl("button", { cls: "fs-filter-icon" });
		btn.type = "button";
		btn.setAttribute("aria-label", label);
		btn.setAttribute("aria-pressed", get() ? "true" : "false");
		if (get()) btn.addClass("is-active");
		btn.innerHTML = svg;
		btn.onclick = async () => {
			const next = !get();
			set(next);
			btn.toggleClass("is-active", next);
			btn.setAttribute("aria-pressed", next ? "true" : "false");
			await plugin.saveSettings();
			onChange();
		};
	};

	addIcon(
		s.filterMatchCase,
		CASE_SVG,
		() => plugin.settings.filterMatchCase,
		(v) => {
			plugin.settings.filterMatchCase = v;
		}
	);
	addIcon(
		s.filterRegex,
		REGEX_SVG,
		() => plugin.settings.filterUseRegex,
		(v) => {
			plugin.settings.filterUseRegex = v;
		}
	);

	anchor.insertAdjacentElement("afterend", row);
	return row;
}

export function watchNativeSearchResults(
	view: SearchView,
	plugin: FilterHost
): () => void {
	const run = debounce(
		() => applyNativeResultFilters(view, plugin),
		50,
		true
	);
	const observer = new MutationObserver(() => run());
	observer.observe(view.containerEl, {
		childList: true,
		subtree: true,
	});
	run();
	return () => {
		observer.disconnect();
		run.cancel();
	};
}

