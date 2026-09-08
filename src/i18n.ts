import { getLanguage, requireApiVersion } from "obsidian";

export type Locale = "en" | "zh";

export function getLocale(): Locale {
	let lang = "";
	try {
		if (requireApiVersion("1.8.7") && typeof getLanguage === "function") {
			lang = getLanguage();
		}
	} catch {
		lang = "";
	}
	if (!lang) {
		lang =
			window.localStorage.getItem("language") ||
			navigator.language ||
			"en";
	}
	return lang.toLowerCase().startsWith("zh") ? "zh" : "en";
}

type ViewTypeKey = "modal" | "sidebar" | "split" | "tab" | "window";

const VIEW_TYPE_EN: Record<ViewTypeKey, string> = {
	modal: "Modal",
	split: "Split",
	tab: "Tab",
	window: "Window",
	sidebar: "Sidebar",
};

const VIEW_TYPE_ZH: Record<ViewTypeKey, string> = {
	modal: "弹窗",
	split: "分栏",
	tab: "标签页",
	window: "窗口",
	sidebar: "侧边栏",
};

export interface Strings {
	pluginIntro: string;
	settingsTitle: string;
	tabGeneral: string;
	tabQuickSearch: string;
	tabQuickCreate: string;
	quickSearchTrigger: string;
	quickSearchTriggerDesc: string;
	doubleTapInterval: string;
	doubleTapIntervalDesc: string;
	quickCreateHeading: string;
	enableQuickCreate: string;
	enableQuickCreateDesc: string;
	quickCreateFolder: string;
	quickCreateFolderDesc: string;
	quickCreateFolderPlaceholder: string;
	titleFormat: string;
	titleFormatDesc: string;
	triggerShift: string;
	triggerControl: string;
	triggerAlt: string;
	triggerMeta: string;
	triggerNone: string;
	showFilePath: string;
	showInstructions: string;
	defaultViewType: string;
	viewType: Record<ViewTypeKey, string>;
	viewTypeMenu: (type: string) => string;
	switchToFileView: string;
	ribbonSearch: (type: ViewTypeKey | string) => string;
	cmdSearchGlobally: string;
	cmdSearchGloballyState: string;
	cmdSearchCurrentFile: string;
	cmdSearchBacklink: string;
	cmdShowHideFilePath: string;
	cmdOpenSearchView: (type: string) => string;
	cmdSearchFile: string;
	cmdSearchPath: string;
	cmdSearchContent: string;
	cmdSearchMatchCase: string;
	cmdSearchIgnoreCase: string;
	cmdSearchTag: string;
	cmdSearchLine: string;
	cmdSearchBlock: string;
	cmdSearchSection: string;
	cmdSearchTask: string;
	cmdSearchTaskTodo: string;
	cmdSearchTaskDone: string;
	cmdSearchProperty: string;
	menuSearchInFloat: (query: string) => string;
	menuOpenInFloatPreview: string;
	instrNavigate: string;
	instrCollapse: string;
	instrOpenBackground: string;
	instrOpenAndClose: string;
	instrCreateIfMissing: string;
	instrPreview: string;
	instrSwitchView: string;
	instrAltClick: string;
	cmdkPlaceholder: string;
	cmdkNavigate: string;
	cmdkOpen: string;
	cmdkNewTab: string;
	cmdkClose: string;
	cmdkCreateNote: string;
}

const EN: Strings = {
	pluginIntro:
		"Use Obsidian's built-in search in a floating modal, split, tab, or independent window.",
	settingsTitle: "Float Search Window",
	tabGeneral: "General",
	tabQuickSearch: "Quick Search",
	tabQuickCreate: "Quick Create",
	quickSearchTrigger: "Quick search trigger",
	quickSearchTriggerDesc:
		"Double-tap this key to open the quick search modal (CMDK).",
	doubleTapInterval: "Double-tap interval (ms)",
	doubleTapIntervalDesc:
		"Maximum time between two key presses to trigger quick search. Default: 300ms.",
	quickCreateHeading: "Quick Create",
	enableQuickCreate: "Enable quick create",
	enableQuickCreateDesc:
		"When no exact match is found in quick search, show an option to create a new note with the search text as content.",
	quickCreateFolder: "Quick create folder",
	quickCreateFolderDesc:
		"Folder to create new notes in. Leave empty for vault root.",
	quickCreateFolderPlaceholder: "e.g. Inbox",
	titleFormat: "Title format",
	titleFormatDesc:
		"Timestamp format for the note title. Tokens: YYYY, MM, DD, HH, mm, ss.",
	triggerShift: "Double Shift",
	triggerControl: "Double Ctrl",
	triggerAlt: "Double Alt",
	triggerMeta: "Double Meta (Cmd/Win)",
	triggerNone: "Disabled",
	showFilePath: "Show file path",
	showInstructions: "Show instructions",
	defaultViewType: "Default view type",
	viewType: VIEW_TYPE_EN,
	viewTypeMenu: (type) => {
		const label = VIEW_TYPE_EN[type as ViewTypeKey] ?? type;
		return `${label} view`;
	},
	switchToFileView: "Switch to File View",
	ribbonSearch: (type) => `Search obsidian in ${type} view`,
	cmdSearchGlobally: "Search obsidian globally",
	cmdSearchGloballyState: "Search Obsidian Globally (With Last State)",
	cmdSearchCurrentFile: "Search in current file",
	cmdSearchBacklink: "Search in backlink Of current file",
	cmdShowHideFilePath: "Show/hide file path",
	cmdOpenSearchView: (type) => `Open search view (${type})`,
	cmdSearchFile: "Search: file: (Find text in filename)",
	cmdSearchPath: "Search: path: (Find text in file path)",
	cmdSearchContent: "Search: content: (Find text in file content)",
	cmdSearchMatchCase: "Search: match-case: (Case-sensitive match)",
	cmdSearchIgnoreCase: "Search: ignore-case: (Case-insensitive match)",
	cmdSearchTag: "Search: tag: (Find tag)",
	cmdSearchLine: "Search: line: (Find files with matching line)",
	cmdSearchBlock: "Search: block: (Find matches in the same block)",
	cmdSearchSection: "Search: section: (Find matches in the same section)",
	cmdSearchTask: "Search: task: (Find matches in a task)",
	cmdSearchTaskTodo: "Search: task-todo: (Find matches in uncompleted tasks)",
	cmdSearchTaskDone: "Search: task-done: (Find matches in completed tasks)",
	cmdSearchProperty: "Search: [property] or [property:value]",
	menuSearchInFloat: (query) => `Search "${query}" in Float Search`,
	menuOpenInFloatPreview: "Open in Float Preview",
	instrNavigate: "Navigate",
	instrCollapse: "Collapse/Expand",
	instrOpenBackground: "Open in background",
	instrOpenAndClose: "Open File and Close",
	instrCreateIfMissing: "Create File When Not Exist",
	instrPreview: "Preview/Close Preview",
	instrSwitchView: "Switch Between Search and File View",
	instrAltClick: "Close Modal While In File View",
	cmdkPlaceholder: "Search files and content...",
	cmdkNavigate: "Navigate",
	cmdkOpen: "Open",
	cmdkNewTab: "New tab",
	cmdkClose: "Close",
	cmdkCreateNote: "Create new note",
};

const ZH: Strings = {
	pluginIntro:
		"把Obsidian自带搜索放到浮动弹窗、分栏、标签页或独立窗口里用。",
	settingsTitle: "Float Search Window",
	tabGeneral: "常规",
	tabQuickSearch: "快速搜索",
	tabQuickCreate: "快速新建",
	quickSearchTrigger: "快速搜索快捷键",
	quickSearchTriggerDesc: "双击此键打开快速搜索（CMDK）。",
	doubleTapInterval: "双击间隔（毫秒）",
	doubleTapIntervalDesc:
		"两次按键之间的最长时间，超时则不触发快速搜索。默认 300 毫秒。",
	quickCreateHeading: "快速新建",
	enableQuickCreate: "启用快速新建",
	enableQuickCreateDesc:
		"快速搜索没有精确匹配时，显示用搜索词作为内容新建笔记的选项。",
	quickCreateFolder: "新建笔记目录",
	quickCreateFolderDesc: "新笔记所在文件夹。留空则放在库根目录。",
	quickCreateFolderPlaceholder: "例如 Inbox",
	titleFormat: "标题格式",
	titleFormatDesc:
		"笔记标题的时间戳格式。可用标记：YYYY、MM、DD、HH、mm、ss。",
	triggerShift: "双击 Shift",
	triggerControl: "双击 Ctrl",
	triggerAlt: "双击 Alt",
	triggerMeta: "双击 Meta（Cmd/Win）",
	triggerNone: "关闭",
	showFilePath: "显示文件路径",
	showInstructions: "显示按键说明",
	defaultViewType: "默认视图",
	viewType: VIEW_TYPE_ZH,
	viewTypeMenu: (type) => {
		const label = VIEW_TYPE_ZH[type as ViewTypeKey] ?? type;
		return `${label}视图`;
	},
	switchToFileView: "切换到文件视图",
	ribbonSearch: (type) => {
		const label = VIEW_TYPE_ZH[type as ViewTypeKey] ?? type;
		return `在${label}中搜索`;
	},
	cmdSearchGlobally: "全局搜索",
	cmdSearchGloballyState: "全局搜索（保留上次关键字）",
	cmdSearchCurrentFile: "在当前文件中搜索",
	cmdSearchBacklink: "搜索当前文件的反向链接",
	cmdShowHideFilePath: "显示/隐藏文件路径",
	cmdOpenSearchView: (type) => {
		const label = VIEW_TYPE_ZH[type as ViewTypeKey] ?? type;
		return `打开搜索视图（${label}）`;
	},
	cmdSearchFile: "搜索：file:（在文件名中查找）",
	cmdSearchPath: "搜索：path:（在路径中查找）",
	cmdSearchContent: "搜索：content:（在正文中查找）",
	cmdSearchMatchCase: "搜索：match-case:（区分大小写）",
	cmdSearchIgnoreCase: "搜索：ignore-case:（不区分大小写）",
	cmdSearchTag: "搜索：tag:（查找标签）",
	cmdSearchLine: "搜索：line:（按行匹配）",
	cmdSearchBlock: "搜索：block:（同一块中匹配）",
	cmdSearchSection: "搜索：section:（同一节中匹配）",
	cmdSearchTask: "搜索：task:（在任务中匹配）",
	cmdSearchTaskTodo: "搜索：task-todo:（未完成任务）",
	cmdSearchTaskDone: "搜索：task-done:（已完成任务）",
	cmdSearchProperty: "搜索：[属性] 或 [属性:值]",
	menuSearchInFloat: (query) => `用浮动搜索查找「${query}」`,
	menuOpenInFloatPreview: "在浮动预览中打开",
	instrNavigate: "切换结果",
	instrCollapse: "折叠/展开",
	instrOpenBackground: "后台打开",
	instrOpenAndClose: "打开并关闭弹窗",
	instrCreateIfMissing: "文件不存在时新建",
	instrPreview: "预览/关闭预览",
	instrSwitchView: "在搜索和预览间切换",
	instrAltClick: "预览时关闭弹窗",
	cmdkPlaceholder: "搜索文件和正文…",
	cmdkNavigate: "切换",
	cmdkOpen: "打开",
	cmdkNewTab: "新标签打开",
	cmdkClose: "关闭",
	cmdkCreateNote: "新建笔记",
};

export function strings(): Strings {
	return getLocale() === "zh" ? ZH : EN;
}
