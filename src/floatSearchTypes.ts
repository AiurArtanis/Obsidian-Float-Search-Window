import type { PaneType } from "obsidian";

export type sortOrder =
	| "alphabetical"
	| "alphabeticalReverse"
	| "byModifiedTime"
	| "byModifiedTimeReverse"
	| "byCreatedTime"
	| "byCreatedTimeReverse"
	| "byRelevance";

export type searchType = "modal" | "sidebar" | PaneType;

export interface viewType {
	type: searchType;
	icon: string;
}

export interface searchState extends Record<string, unknown> {
	collapseAll?: boolean;
	explainSearch?: boolean;
	extraContext?: boolean;
	matchingCase?: boolean;
	query: string;
	sortOrder?: sortOrder;
	current?: boolean;
	cursor?: number;
	triggerBySelf?: boolean;
}

export type CmdkTriggerKey = "Shift" | "Control" | "Alt" | "Meta" | "none";

export interface FloatSearchSettings {
	searchViewState: searchState;
	showFilePath: boolean;
	showInstructions: boolean;
	defaultViewType: searchType;
	cmdkTriggerKey: CmdkTriggerKey;
	cmdkDoubleTapInterval: number;
	cmdkQuickCreate: boolean;
	cmdkQuickCreateFolder: string;
	cmdkQuickCreateTitleFormat: string;
	filterIncludeNotes: boolean;
	filterIncludeBases: boolean;
	filterIncludeCanvas: boolean;
	filterIncludeExcalidraw: boolean;
	filterIncludePdf: boolean;
	filterIncludeImages: boolean;
	filterStarredOnly: boolean;
	filterMatchCase: boolean;
	filterUseRegex: boolean;
}

export const DEFAULT_SETTINGS: FloatSearchSettings = {
	searchViewState: {
		collapseAll: false,
		explainSearch: false,
		extraContext: false,
		matchingCase: false,
		query: "",
		sortOrder: "alphabetical",
	},
	showFilePath: false,
	showInstructions: true,
	defaultViewType: "modal",
	cmdkTriggerKey: "Shift",
	cmdkDoubleTapInterval: 300,
	cmdkQuickCreate: false,
	cmdkQuickCreateFolder: "",
	cmdkQuickCreateTitleFormat: "YYYYMMDDHHmmss",
	filterIncludeNotes: true,
	filterIncludeBases: true,
	filterIncludeCanvas: true,
	filterIncludeExcalidraw: true,
	filterIncludePdf: true,
	filterIncludeImages: true,
	filterStarredOnly: false,
	filterMatchCase: false,
	filterUseRegex: false,
};

export const allViews: viewType[] = [
	{
		type: "modal",
		icon: "square-equal",
	},
	{
		type: "sidebar",
		icon: "panel-left-inactive",
	},
	{
		type: "split",
		icon: "split-square-horizontal",
	},
	{
		type: "tab",
		icon: "panel-top",
	},
	{
		type: "window",
		icon: "app-window",
	},
];
