import { Keymap, Modal, SearchView, TFile, WorkspaceLeaf, debounce } from "obsidian";
import type FloatSearchPlugin from "./floatSearchIndex";
import { EmbeddedView, spawnLeafView } from "./leafView";
import type { searchState } from "./floatSearchTypes";
import { nativeSearchState } from "./searchLeaf";
import { isComposingEvent, resolveResultItem, SearchResultItem } from "./searchResults";
import { applyNativeResultFilters, bindNativeRegexSearch, mountFilterBar, watchNativeSearchResults } from "./filterBar";
import { openVaultFile, usesMarkdownView } from "./openFile";
import { strings } from "./i18n";

function createInstructionElement(
	parentEl: HTMLElement,
	divCls: string,
	keyText: string,
	text: string
) {
	const divEl = parentEl.createDiv({ cls: divCls });
	const iconEl = divEl.createSpan({
		cls: "float-search-modal-instructions-key",
	});
	const textEl = divEl.createSpan({
		cls: "float-search-modal-instructions-text",
	});

	iconEl.setText(keyText);
	textEl.setText(text);

	return { divEl, iconEl, textEl };
}

export class FloatSearchModal extends Modal {
	private readonly plugin: FloatSearchPlugin;
	private searchEmbeddedView: EmbeddedView;
	private fileEmbeddedView: EmbeddedView | undefined;

	searchLeaf: WorkspaceLeaf;
	fileLeaf: WorkspaceLeaf | undefined;

	private cb: (state: searchState) => void;
	private state: searchState;

	private searchCtnEl: HTMLElement;
	private unwatchFilters: (() => void) | null = null;
	private unbindNativeQuery: (() => void) | null = null;
	private instructionsEl: HTMLElement;
	private fileEl: HTMLElement;

	private focusdItem: SearchResultItem | null | undefined;
	private closed = false;
	private previewRequest = 0;
	private previewQueue: Promise<void> = Promise.resolve();
	private inputCleanup: (() => void) | null = null;

	private debouncedAutoPreview = debounce(() => {
		this.autoPreviewFocusedItem();
	}, 150);

	constructor(
		cb: (state: searchState) => void,
		plugin: FloatSearchPlugin,
		state: searchState
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.cb = cb;
		this.state = state;
	}

	async onOpen() {
		this.closed = false;
		const { contentEl, containerEl, modalEl } = this;

		this.searchCtnEl = contentEl.createDiv({
			cls: "float-search-modal-search-ctn",
		});
		this.instructionsEl = modalEl.createDiv({
			cls: "float-search-modal-instructions",
		});

		this.initInstructions(this.instructionsEl);
		this.initCss(contentEl, modalEl, containerEl);
		await this.initSearchView(this.searchCtnEl);
		if (this.closed) {
			this.searchLeaf?.detach();
			return;
		}
		this.initFilterBar();
		this.initInput();
		this.initContent();
	}

	onClose() {
		this.closed = true;
		this.debouncedAutoPreview.cancel();
		this.inputCleanup?.();
		this.inputCleanup = null;
		this.clearPreview();
		const { contentEl } = this;
		this.unwatchFilters?.();
		this.unwatchFilters = null;
		this.unbindNativeQuery?.();
		this.unbindNativeQuery = null;

		if (this.searchLeaf?.view) {
			const state = { ...this.state, ...this.searchLeaf.view.getState() };
			// On older hosts the fallback must not overwrite a preference from a newer host.
			if (this.state.sortOrder !== nativeSearchState(this.state).sortOrder) state.sortOrder = this.state.sortOrder;
			delete state.cursor;
			delete state.current;
			delete state.triggerBySelf;
			this.cb(state);
		}

		this.searchLeaf?.detach();
		this.fileLeaf?.detach();
		this.searchEmbeddedView?.unload();
		this.fileEmbeddedView?.unload();
		contentEl.empty();
	}

	initInstructions(instructionsEl: HTMLElement) {
		if (!this.plugin.settings.showInstructions) {
			return;
		}
		const s = strings();
		createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-navigate",
			"↑↓",
			s.instrNavigate
		);
		createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-collapse",
			"Shift+↑↓",
			s.instrCollapse
		);
		createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-enter",
			"↵",
			s.instrOpenBackground
		);
		createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-alt-enter",
			"Alt+↵",
			s.instrOpenAndClose
		);
		createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-ctrl-enter",
			"Ctrl+↵",
			s.instrCreateIfMissing
		);
		createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-tab",
			"Tab/Shift+Tab",
			s.instrPreview
		);
		createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-switch",
			"Ctrl+G",
			s.instrSwitchView
		);
		createInstructionElement(
			instructionsEl,
			"float-search-modal-instructions-click",
			"Alt+Click",
			s.instrAltClick
		);
	}

	initCss(
		contentEl: HTMLElement,
		modalEl: HTMLElement,
		containerEl: HTMLElement
	) {
		contentEl.classList.add("float-search-modal-content");
		modalEl.classList.add("float-search-modal");
		containerEl.classList.add("float-search-modal-container");
	}

	async initSearchView(contentEl: HTMLElement) {
		const [createdLeaf, embeddedView] = spawnLeafView(
			this.plugin,
			contentEl
		);
		this.searchLeaf = createdLeaf;
		this.searchEmbeddedView = embeddedView;

		this.searchLeaf.setPinned(true);
		await this.searchLeaf.setViewState({
			type: "search",
			state: nativeSearchState({ ...this.state, matchingCase: this.plugin.settings.filterMatchCase, triggerBySelf: true }),
		});

		const input = (createdLeaf.view as SearchView).searchComponent?.inputEl;
		const initialInput = input?.value;
		window.setTimeout(() => void (async () => {
			if (this.closed || input?.value !== initialInput) return;
			await createdLeaf.view.setState(
				nativeSearchState({ ...this.state, matchingCase: this.plugin.settings.filterMatchCase, triggerBySelf: true }),
				{ history: false }
			);
			if (this.closed) return;
			const searchComponent = (this.searchLeaf.view as SearchView)
				.searchComponent;
			if (searchComponent?.inputEl) {
				const cursor = this.state.cursor ?? (this.state.current ? 0 : this.state.query.length);
				searchComponent.inputEl.setSelectionRange(cursor, cursor);
			}
		})().catch((error: unknown) => console.error("Float Search Window: failed to initialize search", error)), 0);
	}

	private initFilterBar() {
		const searchRow = this.searchCtnEl.querySelector(".search-row");
		if (searchRow) {
			mountFilterBar(searchRow as HTMLElement, this.plugin, () =>
				this.onFilterChange()
			);
		}
		const view = this.searchLeaf.view as SearchView;
		this.unbindNativeQuery = bindNativeRegexSearch(view, this.plugin, () => {
			this.debouncedAutoPreview.cancel();
			this.clearPreview();
		});
		this.syncNativeMatchCase(view);
		this.unwatchFilters = watchNativeSearchResults(view, this.plugin);
		view.startSearch?.();
		view.containerEl.addClass("float-search-filtered-view");
		view.matchingCaseButtonEl?.addClass("float-search-native-case-button");
	}

	private onFilterChange() {
		this.clearPreview();
		const view = this.searchLeaf.view as SearchView;
		this.syncNativeMatchCase(view);
		view.startSearch?.();
		applyNativeResultFilters(view, this.plugin);
	}

	private syncNativeMatchCase(view: SearchView) {
		const state = view.getState();
		if (state.matchingCase === this.plugin.settings.filterMatchCase) return;
		const target = view as SearchView & { setMatchingCase?: (value: boolean) => void };
		if (typeof target.setMatchingCase === "function") {
			target.setMatchingCase(this.plugin.settings.filterMatchCase);
			return;
		}
		if (state.matchingCase !== this.plugin.settings.filterMatchCase) {
			void view.setState({
				...state,
				matchingCase: this.plugin.settings.filterMatchCase,
				triggerBySelf: true,
			}, { history: false });
		}
	}

	initInput(retries = 10) {
		if (this.closed) return;
		const inputEl = this.contentEl.getElementsByTagName("input")[0];
		if (!inputEl) {
			if (retries > 0) {
				window.setTimeout(() => this.initInput(retries - 1), 50);
			}
			return;
		}
		const clear = () => {
			this.debouncedAutoPreview.cancel();
			this.clearPreview();
		};
		inputEl.addEventListener("input", clear);
		this.inputCleanup = () => {
			inputEl.removeEventListener("input", clear);
			inputEl.onkeydown = null;
		};
		inputEl.focus();
		inputEl.onkeydown = async (e) => {
			if (isComposingEvent(e)) {
				return;
			}
			const currentView = this.searchLeaf.view as SearchView;
			switch (e.key) {
				case "ArrowDown":
				case "n":
					if (e.key === "n" && !e.ctrlKey) break;
					if (e.key === "n") e.preventDefault();

					if (e.shiftKey) {
						currentView.onKeyShowMoreAfter(e);
						if (currentView.dom.focusedItem) {
							if (currentView.dom.focusedItem.collapsible) {
								currentView.dom.focusedItem.setCollapse?.(false);
							}
							this.focusdItem = currentView.dom.focusedItem;
						}
					} else {
						currentView.onKeyArrowDownInFocus(e);
						this.focusdItem = currentView.dom.focusedItem;
						this.debouncedAutoPreview();
					}
					break;
				case "ArrowUp":
				case "p":
					if (e.key === "p" && !e.ctrlKey) break;
					if (e.key === "p") e.preventDefault();

					if (e.shiftKey) {
						currentView.onKeyShowMoreBefore(e);
						if (currentView.dom.focusedItem) {
							if (currentView.dom.focusedItem.collapseEl) {
								currentView.dom.focusedItem.setCollapse?.(true);
							}
							this.focusdItem = currentView.dom.focusedItem;
						}
					} else {
						currentView.onKeyArrowUpInFocus(e);
						this.focusdItem = currentView.dom.focusedItem;
						if (!currentView.dom.focusedItem?.content) {
							this.focusdItem = undefined;
						}
						this.debouncedAutoPreview();
					}
					break;
				case "ArrowLeft":
					currentView.onKeyArrowLeftInFocus(e);
					break;
				case "ArrowRight":
					currentView.onKeyArrowRightInFocus(e);
					break;
				case "Enter":
					if (
						Keymap.isModifier(e, "Mod") &&
						Keymap.isModifier(e, "Shift") &&
						!this.focusdItem
					) {
						e.preventDefault();
						const fileName = inputEl.value.trim();
						const real = fileName.replace(/[/\\?%*:|"<>]/g, "-");
						await this.plugin.app.workspace.openLinkText(real, "", true);
						this.close();
						break;
					}
					{
						const item = currentView.dom.focusedItem;
						const focusedFile =
							item?.parent?.file instanceof TFile
								? item.parent.file
								: item?.file;
						if (
							focusedFile instanceof TFile &&
							!usesMarkdownView(this.plugin.app, focusedFile)
						) {
							e.preventDefault();
							await openVaultFile(this.plugin.app, focusedFile, {
								newTab: Keymap.isModEvent(e),
							});
							if (e.altKey) this.close();
							break;
						}
					}
					currentView.onKeyEnterInFocus(e);
					if (e.altKey && currentView.dom.focusedItem) {
						this.close();
					}
					break;
				case "Tab":
					e.preventDefault();
					if (e.shiftKey) {
						if (this.fileLeaf) {
							this.clearPreview();

							break;
						}
					}

					{
						const result = resolveResultItem(currentView.dom.focusedItem);
						if (result) await this.initFileView(result.file, result.eState);
					}
					break;
				case "e":
					if (e.ctrlKey) {
						e.preventDefault();
						if (this.fileLeaf) {
							const estate = this.fileLeaf.getViewState();
							estate.state = {
								...estate.state,
								mode:
									"preview" === estate.state?.mode
										? "source"
										: "preview",
							};
							await this.fileLeaf.setViewState(estate, {
								focus: true,
							});
							window.setTimeout(() => {
								(
									this.searchLeaf.view as SearchView
								).searchComponent?.inputEl?.focus();
							}, 0);
						}
					}
					break;
				case "g":
					if (this.fileLeaf && e.ctrlKey) {
						e.preventDefault();
						this.plugin.app.workspace.setActiveLeaf(this.fileLeaf, {
							focus: true,
						});
					}
					break;
				case "C":
					if (e.ctrlKey && e.shiftKey && currentView.dom.focusedItem) {
						e.preventDefault();
						const text = currentView.dom.focusedItem.el.innerText;
						await navigator.clipboard.writeText(text);
					}
					break;
			}
		};
	}

	private autoPreviewFocusedItem() {
		if (this.closed) return;
		const currentView = this.searchLeaf.view as SearchView;
		const item = currentView.dom?.focusedItem;
		if (!item) {
			this.clearPreview();
			return;
		}

		const file =
			item.parent?.file instanceof TFile
				? item.parent.file
				: item.file;
		if (!(file instanceof TFile)) return;

		const state =
			item.parent?.file instanceof TFile
				? {
						match: {
							content: item.content,
							matches: item.matches,
						},
				}
				: undefined;

		void this.initFileView(
			file,
			usesMarkdownView(this.plugin.app, file) ? state : undefined
		);
	}

	private fileFromSearchClick(target: HTMLElement | null): TFile | null {
		const view = this.searchLeaf.view as SearchView;
		let el: HTMLElement | null = target;
		while (el && !el.classList.contains("tree-item")) {
			el = el.parentElement;
		}
		if (!el) return null;
		const lookup = view.dom?.resultDomLookup as
			| Map<TFile, { el?: HTMLElement }>
			| undefined;
		if (lookup) {
			for (const [file, item] of lookup) {
				if (item?.el && (item.el === el || el.contains(item.el) || item.el.contains(el))) {
					return file;
				}
			}
		}
		const focused = view.dom?.focusedItem;
		const focusedFile =
			focused?.parent?.file instanceof TFile
				? focused.parent.file
				: focused?.file;
		return focusedFile instanceof TFile ? focusedFile : null;
	}

	initContent() {
		const { contentEl } = this;
		contentEl.addEventListener(
			"click",
			(e) => {
				if (!(this.searchCtnEl as Node).contains(e.target as Node)) {
					return;
				}
				const file = this.fileFromSearchClick(e.target as HTMLElement);
				if (!file || usesMarkdownView(this.plugin.app, file)) return;
				e.preventDefault();
				e.stopPropagation();
				void openVaultFile(this.plugin.app, file, {
					newTab: Keymap.isModEvent(e),
				}).then(() => {
					if (e.altKey || !this.fileLeaf) this.close();
				});
			},
			true
		);
		contentEl.onclick = (e) => {
			const resultElement = contentEl.getElementsByClassName(
				"search-results-children"
			)[0];
			if (!resultElement || resultElement.children.length < 2) {
				return;
			}

			let targetElement = e.target as HTMLElement | null;

			if (e.altKey || !this.fileLeaf) {
				while (targetElement) {
					if (targetElement.classList.contains("tree-item-icon")) {
						break;
					}
					if (
						targetElement.classList.contains(
							"search-result-hover-button"
						)
					) {
						break;
					}
					if (targetElement.classList.contains("tree-item")) {
						this.close();
						break;
					}
					targetElement = targetElement.parentElement;
				}
				return;
			}

			if (this.fileLeaf) {
				const currentView = this.searchLeaf.view as SearchView;

				if (
					this.searchCtnEl.contains(targetElement)
				) {
					while (targetElement) {
						if (targetElement.classList.contains("tree-item")) {
							break;
						}
						targetElement = targetElement.parentElement;
					}
					if (!targetElement) return;

					const file = this.fileFromSearchClick(targetElement);
					if (file) {
						const item = currentView.dom.resultDomLookup.get(file);
						currentView.dom.setFocusedItem(item ?? null);
						void this.initFileView(file, undefined);
						(
							this.searchLeaf.view as SearchView
						).searchComponent?.inputEl?.focus();
					}
				}

				return;
			}
		};
	}

	private clearPreview() {
		this.previewRequest++;
		this.focusdItem = undefined;
		this.fileLeaf?.detach();
		this.fileEmbeddedView?.unload();
		this.fileLeaf = undefined;
		this.fileEmbeddedView = undefined;
		this.fileEl?.remove();
		this.modalEl.removeClass("float-search-width");
		this.contentEl.removeClass("float-search-has-preview");
	}

	async initFileView(file: TFile, state: Record<string, unknown> | undefined) {
		if (this.closed) return;
		const request = ++this.previewRequest;
		this.previewQueue = this.previewQueue.catch(() => {}).then(async () => {
			if (this.closed || request !== this.previewRequest) return;
			await this.renderFileView(file, state, request);
		});
		await this.previewQueue;
	}

	private async renderFileView(file: TFile, state: Record<string, unknown> | undefined, request: number) {
		if (this.fileLeaf) {
			await openVaultFile(this.plugin.app, file, {
				leaf: this.fileLeaf,
				active: false,
				eState: state,
				preview: true,
			});
			if (this.closed || request !== this.previewRequest) return;

			window.setTimeout(() => {
				if (this.closed || request !== this.previewRequest) return;
				(
					this.searchLeaf.view as SearchView
				).searchComponent?.inputEl?.focus();
			}, 0);

			return;
		}

		const { contentEl } = this;
		this.fileEl = contentEl.createDiv({
			cls: "float-search-modal-file-ctn",
		});
		this.modalEl.addClass("float-search-width");
		this.contentEl.addClass("float-search-has-preview");
		this.fileEl.onkeydown = (e) => {
			if (e.ctrlKey && e.key === "g") {
				e.preventDefault();
				e.stopPropagation();

				(
					this.searchLeaf.view as SearchView
				).searchComponent?.inputEl?.focus();
			}

			if (e.key === "Tab" && (e.ctrlKey || e.shiftKey)) {
				e.preventDefault();
				e.stopPropagation();

				(
					this.searchLeaf.view as SearchView
				).searchComponent?.inputEl?.focus();
			}
		};

		if (!this.fileEl) return;

		const [createdLeaf, embeddedView] = spawnLeafView(
			this.plugin,
			this.fileEl
		);
		this.fileLeaf = createdLeaf;
		this.fileEmbeddedView = embeddedView;

		this.fileLeaf.setPinned(true);
		await openVaultFile(this.plugin.app, file, {
			leaf: this.fileLeaf,
			active: false,
			eState: state,
			preview: true,
		});
		if (this.closed || request !== this.previewRequest) return;

		(this.searchLeaf.view as SearchView).searchComponent?.inputEl?.focus();
	}
}
