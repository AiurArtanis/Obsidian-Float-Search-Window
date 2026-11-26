import {
	addIcon,
	Editor,
	ExtraButtonComponent,
	Menu,
	MenuItem,
	ObsidianProtocolData,
	OpenViewState,
	PaneType,
	Plugin,
	requireApiVersion,
	SearchView,
	Setting,
	setIcon,
	TAbstractFile,
	TFile,
	ViewStateResult,
	Workspace,
	WorkspaceContainer,
	WorkspaceItem,
	WorkspaceLeaf,
} from "obsidian";
import { EmbeddedView, isEmebeddedLeaf } from "./leafView";
import { around } from "monkey-around";
import { debounce } from "obsidian";
import { strings } from "./i18n";
import { isPreviewSuppressed } from "./openFile";

import { FloatSearchModal } from "./floatSearchModal";
import { FloatSearchCmdkModal } from "./floatSearchCmdk";
import { FloatSearchSettingTab } from "./settingTab";
import { DEFAULT_SETTINGS, allViews, FloatSearchSettings, searchState, searchType, sortOrder } from "./floatSearchTypes";

import { getActiveLeaf } from "./activeLeaf";
import { DoubleTapDetector } from "./doubleTap";
import { attachNativeSearchPreview } from "./nativeSearchPreview";
import { getWorkspaceSearchLeaves, initSearchViewWithLeaf, isSidebarLeaf, isPopoutLeaf, nativeSearchState, revealSearchLeaf } from "./searchLeaf";

interface ResultFileItem {
	file?: TFile;
	el?: HTMLElement;
	containerEl?: HTMLElement;
	pathEl?: HTMLElement;
}

interface SearchViewInternals {
	filterSectionToggleEl?: HTMLElement;
	searchParamsContainerEl?: HTMLElement;
}

interface WorkspacePatchTarget {
	getLeaf(...args: Parameters<Workspace["getLeaf"]>): WorkspaceLeaf;
	changeLayout(layout: unknown): Promise<void>;
	iterateLeaves(arg1: unknown, arg2: unknown): boolean;
	setActiveLeaf(leaf: WorkspaceLeaf | null, params?: unknown): void;
	pushUndoHistory(leaf: WorkspaceLeaf, id: string, ...args: unknown[]): void;
	recordMostRecentOpenedFile(file: TFile): void;
}

interface RecentFileTracker {
	onFileOpen(current: TFile | null, previous: TFile | null): void;
}

interface WorkspaceRecentFileInternals {
	recentFileTracker?: RecentFileTracker;
	lastActiveFile: TFile | null;
	getActiveFileView?(): { leaf: WorkspaceLeaf } | null;
}

interface SearchViewPatchTarget {
	onOpen(): Promise<void>;
	setExplainSearch(value: boolean): void;
	setCollapseAll(value: boolean): void;
	setExtraContext(value: boolean): void;
	setMatchingCase(value: boolean): void;
	setSortOrder(value: string): void;
	setQuery(value: string): void;
	setState(state: searchState, result: ViewStateResult): Promise<void>;
}

export default class FloatSearchPlugin extends Plugin {
	settings: FloatSearchSettings;
	private state: searchState = { ...DEFAULT_SETTINGS.searchViewState };
	private modal: FloatSearchModal | null = null;
	private cmdkModal: FloatSearchCmdkModal | null = null;

	private queryLoaded = false;
	private unloading = false;
	private readonly searchViewCleanups = new Map<SearchView, () => void>();


	public applySettingsUpdate = debounce(async () => {
		if (this.unloading) return;
		// Ensure all searchState properties are preserved
		this.settings.searchViewState = {
			...DEFAULT_SETTINGS.searchViewState,
			...this.settings.searchViewState,
			query: this.state.query || "",
		};
		await this.saveSettings();
	}, 1000);

	private applyStateUpdate = debounce(() => {
		// Preserve all state properties when updating
		this.state = {
			...DEFAULT_SETTINGS.searchViewState,
			...this.state,
			query: "",
		};
	}, 30000);

	async onload() {
		await this.loadSettings();
		this.initState();

		this.app.workspace.onLayoutReady(() => {
			if (this.unloading) return;
			this.updateFilePathVisibility();
			this.registerIcons();

			this.patchWorkspace();
			this.patchWorkspaceLeaf();
			this.hookRecentFilesPlugin();
			this.hookFileExplorer();
			this.registerEvent(
				this.app.workspace.on("layout-change", () => {
					this.hookRecentFilesPlugin();
					this.hookFileExplorer();
				})
			);
			this.patchSearchView();
			this.patchDragManager();
			this.registerDoubleKeyHandler();
		});

		this.registerObsidianURIHandler();
		this.registerObsidianCommands();
		this.registerEditorMenuHandler();
		this.registerContextMenuHandler();
		this.registerRibbonIcon();

		this.addRibbonIcon(
			"float-search-window",
			strings().ribbonSearch(this.settings.defaultViewType),
			() => {
				if (this.settings.defaultViewType === "modal") {
					this.initModal(this.state, true, true);
				} else {
					void initSearchViewWithLeaf(
						this.app,
						this.settings.defaultViewType,
						{
							...this.state,
							query: "",
						}
					);
				}
			}
		);
		this.updateFilePathVisibility();
		this.registerEvent(this.app.workspace.on("window-open", (_workspaceWindow, win) => {
			this.applyFilePathVisibility(win.document);
		}));
		this.addSettingTab(new FloatSearchSettingTab(this.app, this));
	}

	private recentFilesHooked = false;
	private fileExplorerHooked = false;

	hookRecentFilesPlugin() {
		if (this.recentFilesHooked) return;
		type RecentFiles = {
			app?: { workspace?: Workspace };
			shouldAddFile(file: TFile): boolean;
			update(file: TFile): void;
		};
		const recent = this.app.plugins.plugins["recent-files-obsidian"] as unknown as RecentFiles | undefined;
		if (!recent) return;
		this.recentFilesHooked = true;
		if (typeof recent.shouldAddFile === "function") {
			this.register(
				around(recent, {
					shouldAddFile(old: (file: TFile) => boolean) {
						return function (this: RecentFiles, file: TFile) {
							if (file && isPreviewSuppressed(file.path)) {
								return false;
							}
							const active = this.app?.workspace ? getActiveLeaf(this.app.workspace) : null;
							if (active && isEmebeddedLeaf(active)) {
								return false;
							}
							return old.call(this, file);
						};
					},
				})
			);
		}
		if (typeof recent.update === "function") {
			this.register(
				around(recent, {
					update(old: (file: TFile) => void) {
						return function (file: TFile) {
							if (file && isPreviewSuppressed(file.path)) {
								return;
							}
							return old.call(this, file);
						};
					},
				})
			);
		}
	}

	hookFileExplorer() {
		if (this.fileExplorerHooked) return;
		const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
		const view = leaf?.view as { revealInFolder?(file: TAbstractFile): void } | undefined;
		if (!view?.revealInFolder) return;
		this.fileExplorerHooked = true;
		this.register(
			around(view.constructor.prototype as { revealInFolder(file: TAbstractFile): void }, {
				revealInFolder(old: (file: TAbstractFile) => void) {
					return function (file: TAbstractFile) {
						if (
							file instanceof TFile &&
							isPreviewSuppressed(file.path)
						) {
							return;
						}
						return old.call(this, file);
					};
				},
			})
		);
	}

	onunload() {
		this.unloading = true;
		this.modal?.close();
		this.cmdkModal?.close();
		this.applySettingsUpdate.cancel();
		this.applyStateUpdate.cancel();
		for (const cleanup of this.searchViewCleanups.values()) cleanup();
		for (const win of EmbeddedView.activeWindows(this)) {
			win.document.body.removeClass("show-file-path");
		}
	}

	registerDoubleKeyHandler() {
		const attach = (win: Window) => {
			const detector = new DoubleTapDetector(
				() => this.settings.cmdkTriggerKey,
				() => this.settings.cmdkDoubleTapInterval,
				() => {
					if (!win.document.querySelector(".float-search-cmdk-container")) this.openCmdkModal();
				}
			);
			this.registerDomEvent(win, "keydown", detector.onKeyDown, { capture: true });
			this.registerDomEvent(win, "keyup", detector.onKeyUp, { capture: true });
			this.registerDomEvent(win, "mousedown", detector.reset, { capture: true });
			this.registerDomEvent(win, "blur", detector.reset);
		};
		for (const win of EmbeddedView.activeWindows(this)) attach(win);
		this.registerEvent(this.app.workspace.on("window-open", (_workspaceWindow, win) => attach(win)));
	}

	openCmdkModal() {
		if (this.cmdkModal) {
			this.cmdkModal.close();
		}
		this.cmdkModal = new FloatSearchCmdkModal(this);
		this.cmdkModal.open();
	}

	updateFilePathVisibility() {
		for (const win of EmbeddedView.activeWindows(this)) this.applyFilePathVisibility(win.document);
	}

	async updateSearchDefaults(update: Partial<searchState>) {
		this.settings.searchViewState = { ...this.settings.searchViewState, ...update };
		this.state = { ...this.state, ...update };
		await this.saveSettings();
	}

	private applyFilePathVisibility(doc: Document) {
		doc.body.toggleClass("show-file-path", this.settings.showFilePath);
	}

	initState() {
		// Initialize state with all default properties
		this.state = {
			...DEFAULT_SETTINGS.searchViewState,
			...this.settings.searchViewState,
		};
	}

	initModal(
		state: searchState,
		stateSave = false,
		clearQuery = false
	) {
		if (this.modal) {
			this.modal.close();
		}

		this.modal = new FloatSearchModal(
			(state) => {
				// Preserve all state properties when updating from modal
				this.state = {
					...DEFAULT_SETTINGS.searchViewState,
					...state,
				};
				if (stateSave) this.applyStateUpdate();
				this.settings.searchViewState = this.state;
				this.applySettingsUpdate();
			},
			this,
			{ ...state, query: clearQuery ? "" : state.query }
		);
		this.modal.open();
	}

	patchWorkspace() {
		let layoutChanging = false;
		const workspace = this.app.workspace;
		const uninstaller = around(Workspace.prototype as unknown as WorkspacePatchTarget, {
			getLeaf: (old) =>
				function (this: Workspace, ...args: Parameters<Workspace["getLeaf"]>) {
					const activeLeaf = getActiveLeaf(this);
					if (activeLeaf && isEmebeddedLeaf(activeLeaf)) {
						// Preserve implicit editor selection for links within a preview.
						// An explicit new tab or window must escape the embedded view.
						if (!args[0] && activeLeaf.view.getViewType() === "markdown") return activeLeaf;
						const recent = workspace.getMostRecentLeaf(workspace.rootSplit);
						if (recent && !isEmebeddedLeaf(recent)) this.setActiveLeaf(recent);
					}
					return old.call(this, ...args);
				},
			changeLayout(old) {
				return async function (this: Workspace, layout) {
					layoutChanging = true;
					try {
						await old.call(this, layout);
					} finally {
						layoutChanging = false;
					}
				};
			},
			iterateLeaves(old) {
				return function (this: Workspace, arg1, arg2) {
					if (old.call(this, arg1, arg2)) return true;
					if (layoutChanging) return false;
					const callbackFirst = typeof arg1 === "function";
					const callback = callbackFirst ? arg1 : arg2;
					const parent = (callbackFirst ? arg2 : arg1) as WorkspaceItem | undefined;
					if (!parent || typeof callback !== "function") return false;
					if (parent !== workspace.rootSplit &&
						!(WorkspaceContainer && parent instanceof WorkspaceContainer)) return false;
					const win = (parent as WorkspaceContainer).win ?? window;
					for (const popover of EmbeddedView.popoversForWindow(win)) {
						const split = popover.rootSplit;
						if (callbackFirst ? old.call(this, callback, split) : old.call(this, split, callback)) {
							return true;
						}
					}
					return false;
				};
			},
			setActiveLeaf(old) {
				return function (this: Workspace, leaf, params) {
					old.call(this, leaf, params);
					if (leaf && isEmebeddedLeaf(leaf)) leaf.activeTime = 1700000000000;
				};
			},
			pushUndoHistory(old) {
				return function (this: Workspace, leaf, id, ...args) {
					if (isEmebeddedLeaf(leaf) || leaf.getViewState().type === "search") return;
					return old.call(this, leaf, id, ...args);
				};
			},
			recordMostRecentOpenedFile(old) {
				return function (this: Workspace, file) {
					const active = getActiveLeaf(this);
					if (file && (isPreviewSuppressed(file.path) || (active && isEmebeddedLeaf(active)))) return;
					return old.call(this, file);
				};
			},
		});
		this.register(uninstaller);
		this.patchPreviewFileTransitions(workspace);
	}

	private patchPreviewFileTransitions(workspace: Workspace) {
		const internal = workspace as Workspace & WorkspaceRecentFileInternals;
		const tracker = internal.recentFileTracker;
		if (typeof tracker?.onFileOpen !== "function") return;

		let workspaceFile = internal.lastActiveFile ?? workspace.getActiveFile();
		let previewWasActive = false;
		let suppressedFileOpen: TFile | null | undefined;
		const isPreviewActive = () => {
			const leaf = internal.getActiveFileView?.()?.leaf ?? getActiveLeaf(workspace);
			return !!leaf && isEmebeddedLeaf(leaf);
		};
		const unpatch = around(tracker, {
			onFileOpen(old) {
				return function (this: RecentFileTracker, current, previous) {
					suppressedFileOpen = undefined;
					// Obsidian 1.15 records the outgoing file before emitting file-open for the incoming one.
					if (isPreviewActive()) {
						previewWasActive = true;
						suppressedFileOpen = current;
						return;
					}
					const outgoing = previewWasActive ? workspaceFile : previous;
					if (previewWasActive && outgoing === current) suppressedFileOpen = current;
					previewWasActive = false;
					workspaceFile = current;
					if (outgoing !== current) old.call(this, current, outgoing);
				};
			},
		});
		this.register(() => {
			// A delayed workspace event can still run after Obsidian removes this patch.
			if (previewWasActive) internal.lastActiveFile = workspaceFile;
			unpatch();
		});
		this.register(around(workspace, {
			trigger(old) {
				return function (this: Workspace, name, ...data) {
					if (name === "file-open") {
						const suppressed = suppressedFileOpen;
						suppressedFileOpen = undefined;
						if (suppressed !== undefined && data[0] === suppressed) return;
					}
					old.call(this, name, ...data);
				};
			},
		}));
		this.registerEvent(workspace.on("active-leaf-change", () => {
			if (!previewWasActive || isPreviewActive()) return;
			const current = workspace.getActiveFile();
			// Moving the previewed file into a real tab doesn't change Obsidian's file identity.
			if (current !== internal.lastActiveFile) return;
			const outgoing = workspaceFile;
			previewWasActive = false;
			workspaceFile = current;
			if (current !== outgoing) {
				tracker.onFileOpen(current, outgoing);
				workspace.trigger("file-open", current);
			}
		}));
	}

	// Used for patch workspaceleaf pinned behaviors
	patchWorkspaceLeaf() {
		this.register(
			around(WorkspaceLeaf.prototype, {
				getRoot(old) {
					return function (this: WorkspaceLeaf) {
						const top = old.call(this);
						return top?.getRoot === this.getRoot
							? top
							: top?.getRoot();
					};
				},
				setPinned(old) {
					return function (this: WorkspaceLeaf, pinned: boolean) {
						old.call(this, pinned);
						if (isEmebeddedLeaf(this) && !pinned)
							this.setPinned(true);
					};
				},
				openFile(old) {
					return async function (this: WorkspaceLeaf, file: TFile, openState?: OpenViewState) {
						await old.call(this, file, openState);
						if (!isEmebeddedLeaf(this) || file.extension !== "canvas") return;
						const { canvas } = this.view as unknown as { canvas?: {
							data: { nodes?: { id: string; text?: string }[] };
							nodes: Map<string, unknown>;
							selectOnly(node: unknown): void;
							zoomToSelection(): void;
						} };
						const match = openState?.eState?.match as { content?: string } | undefined;
						if (!canvas || !match?.content) return;
						const matchNode = canvas.data.nodes?.find((node) => node.text === match.content);
						const node = matchNode && canvas.nodes.get(matchNode.id);
						if (node) {
							canvas.selectOnly(node);
							canvas.zoomToSelection();
						}
					};
				},
			})
		);
	}

	setFilePathVisibility(value: boolean) {
		this.settings.showFilePath = value;
		this.updateFilePathVisibility();
		void this.saveSettings();
	}

	private currentViewType(leaf: WorkspaceLeaf): searchType {
		if (isEmebeddedLeaf(leaf)) return "modal";
		if (isSidebarLeaf(leaf)) return "sidebar";
		if (isPopoutLeaf(leaf)) return "window";
		return "split";
	}

	private buildViewMenu(menu: Menu, current: searchType, originLeaf: WorkspaceLeaf) {
		menu.dom.addClass("float-search-view-menu");
		const availableViews = allViews.filter((view) =>
			current === "split" ? view.type !== "tab" : view.type !== current
		);
		const stateOf = (): searchState => ({
			...this.state,
			...(originLeaf.view.getState() as Partial<searchState>),
		});

		for (const view of availableViews) {
			menu.addItem((item: MenuItem) => {
				item.setTitle(strings().viewTypeMenu(view.type))
					.setIcon(view.icon)
					.onClick(() => {
						const state = stateOf();
						if (current === "modal") this.modal?.close();
						else originLeaf.detach();

						window.setTimeout(() => {
							if (this.unloading) return;
							if (view.type === "modal") this.initModal(state, true, false);
							else void initSearchViewWithLeaf(this.app, view.type, state);
						}, 10);
					});
			});
		}
		return menu;
	}

	/** Add the view switcher, extra options and the Tab preview to a search view. */
	private decorateSearchView(view: SearchView & SearchViewInternals) {
		// Every step is optional: the search view looks different across
		// platforms (mobile, #68) and Obsidian versions.
		if (this.unloading || this.searchViewCleanups.has(view)) return;
		let cleanupPreview: (() => void) | undefined;
		const cleanup = () => {
			cleanupPreview?.();
			cleanupPreview = undefined;
			view.containerEl.querySelectorAll(".float-search-view-switch, .float-search-param")
				.forEach((element) => element.remove());
			this.searchViewCleanups.delete(view);
		};
		this.searchViewCleanups.set(view, cleanup);
		view.register(cleanup);
		const steps: [string, () => void][] = [
			["view switcher", () => this.addViewSwitchButton(view)],
			["search options", () => this.addSearchParamSettings(view)],
			["preview", () => { cleanupPreview = attachNativeSearchPreview(this, view); }],
		];
		for (const [name, step] of steps) {
			try {
				step();
			} catch (error) {
				console.error(`Float Search: failed to add ${name} to the search view`, error);
			}
		}
	}

	private addViewSwitchButton(view: SearchView & SearchViewInternals) {
		const anchorEl = view.filterSectionToggleEl;
		const rowEl =
			anchorEl?.parentElement ??
			view.containerEl.querySelector<HTMLElement>(".search-row");
		if (!rowEl || rowEl.querySelector(".float-search-view-switch")) return;

		const viewSwitchEl = rowEl.createDiv({ cls: "float-search-view-switch" });
		new ExtraButtonComponent(viewSwitchEl)
			.setIcon("layout-template")
			.setTooltip(strings().switchToFileView)
			.onClick(() => {
				const menu = this.buildViewMenu(
					new Menu(),
					this.currentViewType(view.leaf),
					view.leaf
				);
				const rect = viewSwitchEl.getBoundingClientRect();
				menu.showAtPosition({ x: rect.x, y: rect.y + 30 });
			});
		if (anchorEl && anchorEl.parentElement === rowEl) {
			rowEl.insertBefore(viewSwitchEl, anchorEl);
		} else {
			rowEl.appendChild(viewSwitchEl);
		}
	}

	private addSearchParamSettings(view: SearchView & SearchViewInternals) {
		const paramsEl = view.searchParamsContainerEl;
		if (!paramsEl || paramsEl.querySelector(".float-search-param")) return;
		const { settings } = this;

		new Setting(paramsEl)
			.setName(strings().showFilePath)
			.setClass("float-search-param")
			.addToggle((toggle) => {
				toggle.toggleEl.addClass("mod-small");
				toggle
					.setValue(settings.showFilePath)
					.onChange((value) => this.setFilePathVisibility(value));
			});
		new Setting(paramsEl)
			.setName(strings().showInstructions)
			.setClass("float-search-param")
			.addToggle((toggle) => {
				toggle.toggleEl.addClass("mod-small");
				toggle.setValue(settings.showInstructions).onChange(async (value) => {
					settings.showInstructions = value;
					await this.saveSettings();
				});
			});
		new Setting(paramsEl)
			.setName(strings().defaultViewType)
			.setClass("float-search-param")
			.addDropdown((dropdown) => {
				dropdown
					.addOptions(strings().viewType)
					.setValue(settings.defaultViewType)
					.onChange(async (value) => {
						settings.defaultViewType = value as searchType;
						await this.saveSettings();
					});
			});
	}

	patchSearchView() {
		const settings = this.settings;
		const workspace = this.app.workspace;
		const decorate = (view: SearchView) => this.decorateSearchView(view);
		const saveOption = <K extends keyof searchState>(key: K, value: searchState[K]) => {
			if (!workspace.layoutReady) return;
			if (key === "sortOrder" && value === "alphabetical" &&
				nativeSearchState(this.state).sortOrder !== this.state.sortOrder) return;
			settings.searchViewState[key] = value;
			if (key !== "query") this.state[key] = value;
			this.applySettingsUpdate();
		};
		const interceptQuery = (leaf: WorkspaceLeaf | undefined, state: searchState): boolean => {
			if (typeof state?.query !== "string" || state.triggerBySelf) return false;
			if (!leaf || isEmebeddedLeaf(leaf)) return false;
			if (this.settings.defaultViewType === "sidebar" && isSidebarLeaf(leaf)) return false;
			if (!this.queryLoaded) {
				this.queryLoaded = true;
				return false;
			}
			const search = { ...this.state, ...state, current: false };
			const type = this.settings.defaultViewType;
			if (type === "modal") this.initModal(search, true, false);
			else void initSearchViewWithLeaf(this.app, type, search);
			return true;
		};

		let patchPending = false;
		const patchSearch = async () => {
			if (patchPending || this.unloading) return false;
			const leaves = workspace.getLeavesOfType("search");
			const leaf = leaves.find((l) => !isEmebeddedLeaf(l)) ?? leaves[0];
			if (!leaf) return false;
			if (requireApiVersion("1.7.3") && leaf.isDeferred) {
				patchPending = true;
				try {
					await leaf.loadIfDeferred();
				} finally {
					patchPending = false;
				}
				if (this.unloading) return false;
			}
			const searchView = leaf.view as SearchView;
			if (searchView?.getViewType() !== "search" || !searchView.dom) return false;

			this.register(
				around(searchView.constructor.prototype as SearchViewPatchTarget, {
					onOpen(old) {
						return async function (this: SearchView) {
							await old.call(this);
							if (this.leaf.view === this || this.containerEl.isConnected) decorate(this);
						};
					},
					setExplainSearch(old) {
						return function (this: SearchView, value: boolean) {
							old.call(this, value);
							saveOption("explainSearch", value);
						};
					},
					setCollapseAll(old) {
						return function (this: SearchView, value: boolean) {
							old.call(this, value);
							saveOption("collapseAll", value);
						};
					},
					setExtraContext(old) {
						return function (this: SearchView, value: boolean) {
							old.call(this, value);
							saveOption("extraContext", value);
						};
					},
					setMatchingCase(old) {
						return function (this: SearchView, value: boolean) {
							old.call(this, value);
							saveOption("matchingCase", value);
						};
					},
					setSortOrder(old) {
						return function (this: SearchView, value: string) {
							old.call(this, value);
							saveOption("sortOrder", value as sortOrder);
						};
					},
					setQuery(old) {
						return function (this: SearchView, value: string) {
							old.call(this, value);
							saveOption("query", value);
						};
					},
					setState(old) {
						return function (this: SearchView, state: searchState, result: ViewStateResult) {
							if (interceptQuery(this.leaf, state)) return Promise.resolve();
							return old.call(this, state, result);
						};
					},
				})
			);
			this.patchSearchResultDom(searchView);

			// Existing native views already completed onOpen; decoration does not reset their query.
			for (const l of getWorkspaceSearchLeaves(this.app)) {
				if (l.view.getViewType() === "search") decorate(l.view as SearchView);
			}
			this.queryLoaded = workspace.layoutReady;
			return true;
		};

		const tryPatch = async () => {
			if ((await patchSearch()) || this.unloading) return;
			const ref = workspace.on("layout-change", () => {
				void patchSearch().then((patched) => {
					if (patched) workspace.offref(ref);
				}).catch((error) => console.error("Float Search Window: failed to patch Search", error));
			});
			this.registerEvent(ref);
		};
		void tryPatch().catch((error) => {
			console.error("Float Search: failed to patch the search view", error);
		});
	}

	/** Show the folder of each file result (the "Show file path" option). */
	private patchSearchResultDom(searchView: SearchView) {
		this.register(
			around(searchView.dom.constructor.prototype as { stopLoader(): void }, {
				stopLoader(old) {
					return function (this: { vChildren?: { children?: ResultFileItem[] } }) {
						old.call(this);
						(this.vChildren?.children ?? []).forEach((child) => {
							if (!child?.file || child.pathEl) return;
							const titleEl = (child.containerEl ?? child.el)?.querySelector(".search-result-file-title");
							if (!titleEl) return;
							const pathEl = titleEl.createDiv({ cls: "search-result-file-path", prepend: true });
							setIcon(pathEl.createDiv({ cls: "search-result-file-path-icon" }), "folder");
							pathEl.createDiv({
								cls: "search-result-file-path-text",
								text: child.file.parent?.path || "/",
							});
							child.pathEl = pathEl;
						});
					};
				},
			})
		);
	}

	patchDragManager() {
		const manager = this.app.dragManager;
		if (!manager) return;
		const closeSearch = () => this.modal?.close();
		this.register(around(manager.constructor.prototype as { dragFile(...args: unknown[]): unknown }, {
			dragFile(old) {
				return function (this: unknown, ...args) {
					const result = old.call(this, ...args);
					window.setTimeout(closeSearch, 10);
					return result;
				};
			},
		}));
	}

	registerObsidianURIHandler() {
		/**
		* Handles obsidian://fs protocol for search functionality
		*
		* @param viewType - Where to open search:
		*   - "modal" (default) - Opens in modal popup
		*   - "tab" - Opens in new tab
		*   - "split" - Opens in split pane
		*   - "window" - Opens in new window
		*   - "sidebar" - Opens in sidebar
		* @param query - Search query string
		*
		* Examples:
		* obsidian://fs?query=hello&viewType=modal
		* obsidian://fs?query=world&viewType=tab
		* obsidian://fs?query=test (defaults to modal)
		*/
		this.registerObsidianProtocolHandler(
			"fs",
			async (path: ObsidianProtocolData) => {
				const viewType = allViews.find(({ type }) => type === path.viewType)?.type ?? "modal";
				const query = path.query || "";

				if (viewType === "modal") {
					this.initModal(
						{
							...this.state,
							query,
							current: false,
						},
						true,
						false
					);
				} else {
					await initSearchViewWithLeaf(
						this.app,
						viewType,
						{
							...this.state,
							query,
							current: false,
						}
					);
				}
			}
		);
	}

	private createCommand(options: {
		id: string;
		name: string;
		queryBuilder: (file?: TFile) => string;
		isGlobal: boolean;
	}): void {
		if (options.isGlobal) {
			this.addCommand({
				id: options.id,
				name: options.name,
				callback: () => {
					const query = options.queryBuilder();
					const viewType = this.settings.defaultViewType;

					if (viewType === "modal") {
						this.initModal(
							{ ...this.state, query, current: true },
							true,
							false
						);
					} else {
						void initSearchViewWithLeaf(
							this.app,
							viewType,
							{
								...this.state,
								query,
								current: true,
							}
						);
					}
				},
			});
		} else {
			this.addCommand({
				id: options.id,
				name: options.name,
				checkCallback: (checking: boolean) => {
					const activeLeaf = getActiveLeaf(this.app.workspace);
					if (!activeLeaf) return;

					const viewType = activeLeaf.view.getViewType();
					if (viewType === "markdown" || viewType === "canvas") {
						if (!checking) {
							const currentFile = activeLeaf.view.file;
							const query = options.queryBuilder(currentFile);
							const viewType = this.settings.defaultViewType;

							if (viewType === "modal") {
								this.initModal(
									{ ...this.state, query, current: true },
									true,
									false
								);
							} else {
								void initSearchViewWithLeaf(
									this.app,
									viewType,
									{
										...this.state,
										query,
										current: true,
									}
								);
							}
						}
						return true;
					}
				},
			});
		}
	}

	registerObsidianCommands() {
		this.addCommand({
			id: "show-or-hide-file-path",
			name: strings().cmdShowHideFilePath,
			callback: () => {
				this.setFilePathVisibility(!this.settings.showFilePath);
			},
		});

		this.addCommand({
			id: "search-obsidian-globally",
			name: strings().cmdSearchGlobally,
			callback: () =>
				this.initModal(
					{ ...this.state, query: "", current: false },
					false,
					true
				),
		});

		this.addCommand({
			id: "search-obsidian-globally-state",
			name: strings().cmdSearchGloballyState,
			callback: () =>
				this.initModal(
					{ ...this.state, query: this.state.query, current: false },
					true,
					false
				),
		});

		this.createCommand({
			id: "search-in-backlink",
			name: strings().cmdSearchBacklink,
			queryBuilder: (file?: TFile) => {
				if (!file) return "";
				return (
					" /\\[\\[" +
					(file.extension === "canvas" ? file.name : file.basename) +
					"(\\|[^\\]]*)?\\]\\]/"
				);
			},
			isGlobal: false,
		});

		this.createCommand({
			id: "search-in-current-file",
			name: strings().cmdSearchCurrentFile,
			queryBuilder: (file?: TFile) => {
				if (!file) return "";
				return " path:" + `"${file.path}"`;
			},
			isGlobal: false,
		});

		// Register search operator commands
		this.registerSearchOperatorCommands();

		for (const type of ["split", "tab", "window"] as PaneType[]) {
			this.addCommand({
				id: `open-search-view-${type}`,
				name: strings().cmdOpenSearchView(type),
				callback: async () => {
					const existingLeaf =
						getWorkspaceSearchLeaves(this.app);
					switch (type) {
						case "window": {
							const isExistingWindowLeaf = existingLeaf.find(isPopoutLeaf);
							if (isExistingWindowLeaf) {
								await revealSearchLeaf(this.app, isExistingWindowLeaf);
								return;
							}
							await initSearchViewWithLeaf(this.app, type, {
								...this.state,
								triggerBySelf: true,
							});
							break;
						}
						case "tab":
						case "split": {
							const isExistingLeaf = existingLeaf.find(
								(leaf) => !isSidebarLeaf(leaf) && !isPopoutLeaf(leaf)
							);
							if (isExistingLeaf) {
								await isExistingLeaf.setViewState({
									type: "search",
									active: true,
									state: nativeSearchState({ ...this.state, triggerBySelf: true }),
								});
								await revealSearchLeaf(this.app, isExistingLeaf);
								return;
							}
							await initSearchViewWithLeaf(this.app, type, {
								...this.state,
								triggerBySelf: true,
							});
							break;
						}
					}
				},
			});
		}
	}

	registerSearchOperatorCommands() {
		const s = strings();
		const searchOperators = [
			{
				id: "search-file-operator",
				name: s.cmdSearchFile,
				query: "file:",
			},
			{
				id: "search-path-operator",
				name: s.cmdSearchPath,
				query: "path:",
			},
			{
				id: "search-content-operator",
				name: s.cmdSearchContent,
				query: "content:",
			},
			{
				id: "search-match-case-operator",
				name: s.cmdSearchMatchCase,
				query: "match-case:",
			},
			{
				id: "search-ignore-case-operator",
				name: s.cmdSearchIgnoreCase,
				query: "ignore-case:",
			},
			{
				id: "search-tag-operator",
				name: s.cmdSearchTag,
				query: "tag:",
			},
			{
				id: "search-line-operator",
				name: s.cmdSearchLine,
				query: "line:",
			},
			{
				id: "search-block-operator",
				name: s.cmdSearchBlock,
				query: "block:",
			},
			{
				id: "search-section-operator",
				name: s.cmdSearchSection,
				query: "section:",
			},
			{
				id: "search-task-operator",
				name: s.cmdSearchTask,
				query: "task:",
			},
			{
				id: "search-task-todo-operator",
				name: s.cmdSearchTaskTodo,
				query: "task-todo:",
			},
			{
				id: "search-task-done-operator",
				name: s.cmdSearchTaskDone,
				query: "task-done:",
			},
			{
				id: "search-property",
				name: s.cmdSearchProperty,
				query: "[]",
			},
		];

		// Register all search operator commands
		searchOperators.forEach((operator) => {
			this.createCommand({
				id: operator.id,
				name: operator.name,
				queryBuilder: () => operator.query || "",
				isGlobal: true,
			});
		});
	}

	registerEditorMenuHandler() {
		this.registerEvent(
			this.app.workspace.on(
				"editor-menu",
				(menu: Menu, editor: Editor) => {
					if (!editor) {
						return;
					}
					if (editor.getSelection().length === 0) {
						return;
					}
					const selection = editor.getSelection().trim();
					let searchWord = selection;

					if (selection.length > 8) {
						searchWord =
							selection.substring(0, 3) +
							"..." +
							selection.substring(
								selection.length - 3,
								selection.length
							);
					} else {
						searchWord = selection;
					}

					menu.addItem((item) => {
						// Add sub menu
						item.setTitle(strings().menuSearchInFloat(searchWord))
							.setIcon("search")
							.onClick(() =>
								this.initModal(
									{
										...this.state,
										query: selection,
										current: false,
									},
									true,
									false
								)
							);
					});
				}
			)
		);
	}

	registerContextMenuHandler() {
		this.registerEvent(
			this.app.workspace.on(
				"file-menu",
				(
					menu: Menu,
					file: TAbstractFile,
					source: string,
					leaf?: WorkspaceLeaf
				) => {
					const popover = leaf
						? EmbeddedView.forLeaf(leaf)
						: undefined;
					if (file instanceof TFile && !popover && !leaf) {
						menu.addItem((item) => {
							item.setIcon("popup-open")
								.setTitle(strings().menuOpenInFloatPreview)
								.onClick(async () => {
									if (this.modal) {
										await this.modal?.initFileView(
											file,
											undefined
										);

										return;
									}

									this.initModal(
										{ ...this.state, current: false },
										true,
										true
									);
									window.setTimeout(async () => {
										await this.modal?.initFileView(
											file,
											undefined
										);
									}, 20);
								})
								.setSection?.("open");
						});
					}
				}
			)
		);
	}

	registerRibbonIcon() {
		// Phosphor Bold: app-window + magnifying-glass (MIT)
		// https://phosphoricons.com/  256 viewBox scaled into Obsidian's 100x100 icon slot
		addIcon(
			"float-search-window",
			`<g transform="translate(3 10) scale(0.275)" fill="currentColor"><path d="M216,36H40A20,20,0,0,0,20,56V200a20,20,0,0,0,20,20H216a20,20,0,0,0,20-20V56A20,20,0,0,0,216,36Zm-4,160H44V60H212ZM60,92a16,16,0,1,1,16,16A16,16,0,0,1,60,92Zm48,0a16,16,0,1,1,16,16A16,16,0,0,1,108,92Z"/></g><g transform="translate(38 38) scale(0.24)" fill="currentColor"><path d="M232.49,215.51,185,168a92.12,92.12,0,1,0-17,17l47.53,47.54a12,12,0,0,0,17-17ZM44,112a68,68,0,1,1,68,68A68.07,68.07,0,0,1,44,112Z"/></g>`
		);
	}

	registerIcons() {
		addIcon(
			"panel-left-inactive",
			`<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 13.999688 L 9 15 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 19.000312 L 9 21 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 3 L 9 4.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 9 9 L 9 10.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`
		);
		addIcon(
			"app-window",
			`<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.000312 4.000312 L 19.999688 4.000312 C 21.105 4.000312 22.000312 4.895625 22.000312 6 L 22.000312 18 C 22.000312 19.104375 21.105 19.999688 19.999688 19.999688 L 4.000312 19.999688 C 2.895 19.999688 1.999687 19.104375 1.999687 18 L 1.999687 6 C 1.999687 4.895625 2.895 4.000312 4.000312 4.000312 Z M 4.000312 4.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 10.000312 4.000312 L 10.000312 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 1.999687 7.999687 L 22.000312 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 6 4.000312 L 6 7.999687 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`
		);
		addIcon(
			"panel-top",
			`<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 3 9 L 21 9 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`
		);
		addIcon(
			"square-equal",
			`<path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 4.999687 3 L 19.000312 3 C 20.104688 3 21 3.895312 21 4.999687 L 21 19.000312 C 21 20.104688 20.104688 21 19.000312 21 L 4.999687 21 C 3.895312 21 3 20.104688 3 19.000312 L 3 4.999687 C 3 3.895312 3.895312 3 4.999687 3 Z M 4.999687 3 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 7.000312 10.000312 L 16.999688 10.000312 " transform="matrix(4.166667,0,0,4.166667,0,0)"/><path style="fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke:currentColor;stroke-opacity:1;stroke-miterlimit:4;" d="M 7.000312 13.999688 L 16.999688 13.999688 " transform="matrix(4.166667,0,0,4.166667,0,0)"/>`
		);
	}

	async loadSettings() {
		const saved = await this.loadData() as Partial<FloatSearchSettings> | null;
		this.settings = {
			...DEFAULT_SETTINGS,
			...saved,
			searchViewState: { ...DEFAULT_SETTINGS.searchViewState, ...saved?.searchViewState },
		};
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
