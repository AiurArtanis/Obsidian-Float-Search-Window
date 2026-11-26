import { Keymap, SearchResult, SuggestModal, TFile, WorkspaceLeaf, debounce, normalizePath, renderResults, requireApiVersion, setIcon } from "obsidian";
import type FloatSearchPlugin from "./floatSearchIndex";
import { getBookmarkedPaths, isFileAllowed, matchAsSearchResult, mountFilterBar } from "./filterBar";
import { EmbeddedView, spawnLeafView } from "./leafView";
import { openVaultFile } from "./openFile";
import { strings } from "./i18n";
import { isComposingEvent } from "./searchResults";

interface CmdkFileResult {
	file: TFile;
	nameMatch: SearchResult | null;
	pathMatch: SearchResult | null;
	heading?: string;
	headingMatch?: SearchResult | null;
	content?: string;
	contentMatch?: SearchResult | null;
	line?: number;
	type: "file" | "heading" | "content";
}

interface CmdkCreateResult {
	type: "create";
	createQuery: string;
}

type CmdkResult = CmdkFileResult | CmdkCreateResult;

interface SearchChooser {
	setSuggestions(results: CmdkResult[]): void;
	addSuggestion(result: CmdkResult): void;
}

export class FloatSearchCmdkModal extends SuggestModal<CmdkResult> {
	plugin: FloatSearchPlugin;
	private bodyEl: HTMLElement;
	private isComposing = false;
	private previewEl: HTMLElement | undefined;
	private fileLeaf: WorkspaceLeaf | undefined;
	private fileEmbeddedView: EmbeddedView | undefined;
	private searchAbort: AbortController | null = null;
	private readonly compositionStart = () => {
		this.isComposing = true;
		this.searchAbort?.abort();
		this.onSelectedChange.cancel();
		this.previewRequest++;
	};
	private readonly onInputKeyDown = (event: KeyboardEvent) => {
		if (this.isComposing || isComposingEvent(event)) event.stopPropagation();
	};
	private readonly compositionEnd = () => {
		this.isComposing = false;
		this.updateSuggestions();
	};
	private closed = false;
	private previewRequest = 0;
	private previewQueue: Promise<void> = Promise.resolve();

	constructor(plugin: FloatSearchPlugin) {
		super(plugin.app);
		this.plugin = plugin;
		this.limit = 50;
		const s = strings();
		this.setPlaceholder(s.cmdkPlaceholder);
		this.setInstructions([
			{ command: "↑↓", purpose: s.cmdkNavigate },
			{ command: "↵", purpose: s.cmdkOpen },
			{ command: "Shift ↵", purpose: s.cmdkNewTab },
			{ command: "esc", purpose: s.cmdkClose },
		]);
		this.modalEl.addClass("float-search-cmdk");
		this.containerEl.addClass("float-search-cmdk-container");
	}

	onOpen() {
		this.closed = false;
		void super.onOpen();
		this.isComposing = false;
		this.inputEl.addEventListener("compositionstart", this.compositionStart);
		this.inputEl.addEventListener("compositionend", this.compositionEnd);
		this.inputEl.addEventListener("keydown", this.onInputKeyDown);
		this.bodyEl = createDiv("float-search-cmdk-body");
		this.modalEl.insertBefore(this.bodyEl, this.resultContainerEl);
		this.bodyEl.appendChild(this.resultContainerEl);
		const inputWrap = this.inputEl.closest<HTMLElement>(
			".prompt-input-container"
		);
		if (inputWrap) {
			mountFilterBar(inputWrap, this.plugin, () =>
				this.updateSuggestions()
			);
		}
	}

	// Required by SuggestModal but unused — we drive the chooser directly
	getSuggestions(_query: string): CmdkResult[] {
		return [];
	}

	// Override to use progressive rendering via chooser.addSuggestion
	updateSuggestions() {
		if (this.closed || this.isComposing) return;
		this.onSelectedChange.cancel();
		this.hidePreview();
		// Cancel previous in-flight search
		this.searchAbort?.abort();
		const abort = (this.searchAbort = new AbortController());
		const { signal } = abort;

		const { chooser } = this as unknown as { chooser: SearchChooser };
		const query = this.inputEl.value;

		const bookmarks = this.plugin.settings.filterStarredOnly
			? getBookmarkedPaths(this.app)
			: null;
		const files = this.app.vault.getFiles().filter((f: TFile) =>
			isFileAllowed(this.plugin, f, bookmarks)
		);

		// Empty query — show recent files
		if (!query.trim()) {
			const recent = files
				.sort((a: TFile, b: TFile) => b.stat.mtime - a.stat.mtime)
				.slice(0, this.limit)
				.map((file: TFile) => ({
					file,
					nameMatch: null,
					pathMatch: null,
					type: "file" as const,
				}));
			chooser.setSuggestions(recent);
			return;
		}

		// Phase 1: file name/path (sync, instant)
		const fileResults: CmdkFileResult[] = [];

		for (const file of files) {
			const nameMatch = matchAsSearchResult(
				this.plugin,
				file.basename,
				query
			);
			const pathMatch = matchAsSearchResult(
				this.plugin,
				file.path,
				query
			);
			if (nameMatch || pathMatch) {
				fileResults.push({
					file,
					nameMatch,
					pathMatch,
					type: "file",
				});
			}
		}

		fileResults.sort((a, b) => {
			const sa = Math.max(
				a.nameMatch?.score ?? -Infinity,
				(a.pathMatch?.score ?? -Infinity) * 0.5
			);
			const sb = Math.max(
				b.nameMatch?.score ?? -Infinity,
				(b.pathMatch?.score ?? -Infinity) * 0.5
			);
			return sb - sa;
		});

		// Check if there is an exact name match (for quick-create gating)
		const queryLower = query.trim().toLowerCase();
		const hasExactMatch = fileResults.some(
			(r) => r.file.basename.toLowerCase() === queryLower
		);

		const resultsToShow: CmdkResult[] = fileResults.slice(0, this.limit);

		// Append "quick create" option when enabled and no exact match
		if (
			this.plugin.settings.cmdkQuickCreate &&
			!hasExactMatch &&
			query.trim().length > 0
		) {
			resultsToShow.push({
				type: "create",
				createQuery: query.trim(),
			});
		}

		// Render file results immediately
		chooser.setSuggestions(resultsToShow);

		// Phase 2: heading search — progressive, batched via setTimeout
		if (query.trim().length >= 2) {
			this.progressiveHeadingSearch(
				files,
				query,
				chooser,
				signal
			);

			// Phase 3: content search — progressive, async (reads file content)
			this.progressiveContentSearch(
				files,
				query,
				chooser,
				signal
			);
		}
	}

	private progressiveHeadingSearch(
		files: TFile[],
		query: string,
		chooser: SearchChooser,
		signal: AbortSignal
	) {
		const BATCH_SIZE = 50; // files per tick
		let idx = 0;
		let added = 0;
		const MAX_HEADING_RESULTS = 20;

		const processBatch = () => {
			if (signal.aborted) return;

			const end = Math.min(idx + BATCH_SIZE, files.length);
			for (; idx < end; idx++) {
				if (added >= MAX_HEADING_RESULTS) return;
				const file = files[idx];
				const cache =
					this.app.metadataCache.getFileCache(file);
				if (!cache?.headings) continue;

				for (const h of cache.headings) {
					const headingMatch = matchAsSearchResult(
						this.plugin,
						h.heading,
						query
					);
					if (headingMatch) {
						chooser.addSuggestion({
							file,
							nameMatch: null,
							pathMatch: null,
							heading: h.heading,
							headingMatch,
							type: "heading",
						});
						added++;
						if (added >= MAX_HEADING_RESULTS) return;
					}
				}
			}

			// More files to process — yield to event loop
			if (idx < files.length && added < MAX_HEADING_RESULTS) {
				window.setTimeout(() => { void processBatch(); }, 0);
			}
		};

		// Start first batch on next microtask so file results render first
		window.setTimeout(() => { void processBatch(); }, 0);
	}

	private progressiveContentSearch(
		files: TFile[],
		query: string,
		chooser: SearchChooser,
		signal: AbortSignal
	) {
		const BATCH_SIZE = 50;
		const MAX_CONTENT_RESULTS = 20;
		const DURATION_LIMIT = 5; // ms before yielding
		const simpleSearch = (text: string) =>
			matchAsSearchResult(this.plugin, text, query);
		let idx = 0;
		let added = 0;

		const processBatch = async () => {
			if (signal.aborted) return;
			const start = performance.now();

			for (; idx < files.length; idx++) {
				if (signal.aborted || added >= MAX_CONTENT_RESULTS) return;

				// Adaptive yielding: check time every BATCH_SIZE items
				if (idx % BATCH_SIZE === 0 && idx > 0) {
					if (performance.now() - start > DURATION_LIMIT) {
						window.setTimeout(() => { void processBatch(); }, 0);
						return;
					}
				}

				const file = files[idx];
				if (file.extension !== "md") continue;

				let text: string;
				try {
					if (file.stat.size > 2_000_000) continue;
					text = await this.app.vault.cachedRead(file);
				} catch {
					continue;
				}

				if (signal.aborted || this.closed) return;
				const result = simpleSearch(text);
				if (!result) continue;

				// Compute line number and context from first match offset
				const matchStart = result.matches[0][0];
				let line = 0;
				let lineStart = 0;
				for (let i = 0; i < matchStart; i++) {
					if (text.charCodeAt(i) === 10) {
						line++;
						lineStart = i + 1;
					}
				}
				let lineEnd = text.indexOf("\n", lineStart);
				if (lineEnd === -1) lineEnd = text.length;
				const lineText = text.substring(lineStart, lineEnd).trim();

				// Recompute match on the line for highlight offsets
				const lineMatch = simpleSearch(lineText);

				chooser.addSuggestion({
					file,
					nameMatch: null,
					pathMatch: null,
					content: lineText,
					contentMatch: lineMatch,
					line,
					type: "content",
				});
				added++;
				if (added >= MAX_CONTENT_RESULTS) return;
			}
		};

		// Start after heading search has a chance to render
		window.setTimeout(() => { void processBatch(); }, 50);
	}

	renderSuggestion(result: CmdkResult, el: HTMLElement) {
		el.addClass("mod-complex");

		if (result.type === "create") {
			el.addClass("float-search-cmdk-create-item");
			const contentEl = el.createDiv("suggestion-content");
			const titleEl = contentEl.createDiv("suggestion-title");
			titleEl.setText(strings().cmdkCreateNote);
			const noteEl = contentEl.createDiv("suggestion-note");
			const folder =
				this.plugin.settings.cmdkQuickCreateFolder || "/";
			noteEl.setText(
				`"${result.createQuery}" → ${folder}`
			);
			const auxEl = el.createDiv("suggestion-aux");
			const flair = auxEl.createSpan("suggestion-flair");
			setIcon(flair, "plus");
			return;
		}

		const contentEl = el.createDiv("suggestion-content");

		if (result.type === "content" && result.content) {
			const titleEl = contentEl.createDiv("suggestion-title");
			if (result.contentMatch) {
				renderResults(titleEl, result.content, result.contentMatch);
			} else {
				titleEl.setText(result.content);
			}
			const noteEl = contentEl.createDiv("suggestion-note");
			noteEl.setText(result.file.path);
		} else if (result.type === "heading" && result.heading) {
			const titleEl = contentEl.createDiv("suggestion-title");
			if (result.headingMatch) {
				renderResults(titleEl, result.heading, result.headingMatch);
			} else {
				titleEl.setText(result.heading);
			}
			const noteEl = contentEl.createDiv("suggestion-note");
			noteEl.setText(result.file.path);
		} else {
			const titleEl = contentEl.createDiv("suggestion-title");
			if (result.nameMatch) {
				renderResults(
					titleEl,
					result.file.basename,
					result.nameMatch
				);
			} else {
				titleEl.setText(result.file.basename);
			}

			const noteEl = contentEl.createDiv("suggestion-note");
			const parentPath = result.file.parent?.path || "/";
			if (result.pathMatch) {
				renderResults(noteEl, parentPath, result.pathMatch);
			} else {
				noteEl.setText(parentPath);
			}
		}

		if (result.file.extension !== "md") {
			el.createDiv("suggestion-aux")
				.createSpan("suggestion-flair")
				.setText(result.file.extension);
		}
	}

	onChooseSuggestion(
		result: CmdkResult,
		evt: MouseEvent | KeyboardEvent
	) {
		if ("key" in evt && (this.isComposing || isComposingEvent(evt))) return;
		if (result.type === "create") {
			void this.quickCreateNote(result.createQuery, evt);
			return;
		}

		const eState: Record<string, unknown> = {};
		if (result.type === "heading" && result.heading) {
			eState.subpath = "#" + result.heading;
		} else if (result.type === "content" && result.line != null) {
			eState.line = result.line;
		}

		void openVaultFile(this.app, result.file, {
			newTab: Keymap.isModEvent(evt),
			eState,
		});
	}

	private async quickCreateNote(
		content: string,
		evt: MouseEvent | KeyboardEvent
	) {
		const settings = this.plugin.settings;
		const fmt = settings.cmdkQuickCreateTitleFormat || "YYYYMMDDHHmmss";
		const title = this.formatTimestamp(new Date(), fmt);

		// Resolve target folder
		const { vault } = this.app;
		const folderPath = normalizePath(settings.cmdkQuickCreateFolder.trim());
		if (folderPath && folderPath !== "/" && !vault.getAbstractFileByPath(folderPath)) {
			if (requireApiVersion("1.4.0")) {
				await vault.createFolder(folderPath);
			} else {
				let current = "";
				for (const part of folderPath.split("/")) {
					current = current ? `${current}/${part}` : part;
					if (!(await vault.adapter.exists(current))) await vault.adapter.mkdir(current);
				}
			}
		}

		const filePath = folderPath && folderPath !== "/"
			? `${folderPath}/${title}.md`
			: `${title}.md`;

		const file = await vault.create(filePath, content);

		const leaf = Keymap.isModEvent(evt)
			? this.app.workspace.getLeaf("tab")
			: this.app.workspace.getMostRecentLeaf() ??
				this.app.workspace.getLeaf();

		await leaf.setViewState({
			type: "markdown",
			state: { file: file.path },
			active: true,
		});
	}

	private formatTimestamp(date: Date, fmt: string): string {
		const pad = (n: number, len = 2) =>
			String(n).padStart(len, "0");
		const tokens: Record<string, string> = {
			YYYY: String(date.getFullYear()),
			YY: String(date.getFullYear()).slice(-2),
			MM: pad(date.getMonth() + 1),
			DD: pad(date.getDate()),
			HH: pad(date.getHours()),
			mm: pad(date.getMinutes()),
			ss: pad(date.getSeconds()),
		};
		let result = fmt;
		// Replace longest tokens first to avoid partial matches
		for (const token of ["YYYY", "YY", "MM", "DD", "HH", "mm", "ss"]) {
			result = result.split(token).join(tokens[token]);
		}
		return result;
	}

	// Called by internal Chooser on selection change
	onSelectedChange = debounce(
		(result: CmdkResult | null, _evt: Event | null) => {
			if (result?.type === "create" || !result?.file) {
				this.hidePreview();
			} else {
				void this.showPreview(result);
			}
		},
		100
	);

	private hidePreview() {
		this.previewRequest++;
		this.modalEl.removeClass("float-search-cmdk-expanded");
		if (this.previewEl) {
			this.previewEl.hide();
		}
	}

	async showPreview(result: CmdkResult) {
		if (this.closed || result.type === "create") return;
		this.previewEl?.hide();
		const request = ++this.previewRequest;
		this.previewQueue = this.previewQueue.catch(() => {}).then(async () => {
			if (this.closed || request !== this.previewRequest) return;
			await this.renderPreview(result, request);
		});
		await this.previewQueue;
	}

	private async renderPreview(result: CmdkFileResult, request: number) {
		if (!this.previewEl) {
			this.previewEl = this.bodyEl.createDiv(
				"float-search-cmdk-preview"
			);
			const [leaf, view] = spawnLeafView(
				this.plugin,
				this.previewEl
			);
			this.fileLeaf = leaf;
			this.fileEmbeddedView = view;
			this.fileLeaf.setPinned(true);
		}

		this.previewEl.hide();

		const file = result.file;
		const eState: Record<string, unknown> = {};
		if (result.type === "heading" && result.heading) {
			eState.subpath = "#" + result.heading;
		} else if (result.type === "content" && result.line != null) {
			eState.line = result.line;
		}

		await openVaultFile(this.app, file, {
			leaf: this.fileLeaf!,
			active: false,
			eState,
			preview: true,
		});
		if (this.closed || request !== this.previewRequest) return;
		if (eState.subpath || eState.line != null) {
			this.fileLeaf?.setEphemeralState(eState);
		}
		this.previewEl.show();
		this.modalEl.addClass("float-search-cmdk-expanded");

		if (!this.isComposing && this.inputEl.ownerDocument?.activeElement !== this.inputEl) {
			this.inputEl.focus();
		}
	}

	onClose() {
		this.closed = true;
		this.searchAbort?.abort();
		this.searchAbort = null;
		this.onSelectedChange.cancel();
		this.hidePreview();
		this.fileLeaf?.detach();
		this.fileEmbeddedView?.unload();
		this.fileLeaf = undefined;
		this.fileEmbeddedView = undefined;
		this.previewEl?.remove();
		this.previewEl = undefined;
		this.inputEl.removeEventListener("compositionstart", this.compositionStart);
		this.inputEl.removeEventListener("compositionend", this.compositionEnd);
		this.inputEl.removeEventListener("keydown", this.onInputKeyDown);
	}
}
