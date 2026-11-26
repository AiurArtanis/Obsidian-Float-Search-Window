import {
	App,
	PluginSettingTab,
	Setting,
	SettingControl,
	SettingDefinitionItem,
	requireApiVersion,
} from "obsidian";
import type FloatSearchPlugin from "./floatSearchIndex";
import {
	FloatSearchSettings,
	searchState,
	sortOrder,
} from "./floatSearchTypes";
import { getLocale, strings } from "./i18n";
import { nativeSearchState } from "./searchLeaf";

function sortLabels(zh: boolean): Partial<Record<sortOrder, string>> {
	const labels: Partial<Record<sortOrder, string>> = {
		alphabetical: zh ? "文件名（A 到 Z）" : "File name (A to Z)",
		alphabeticalReverse: zh ? "文件名（Z 到 A）" : "File name (Z to A)",
		byModifiedTime: zh ? "修改时间（从新到旧）" : "Modified time (new to old)",
		byModifiedTimeReverse: zh ? "修改时间（从旧到新）" : "Modified time (old to new)",
		byCreatedTime: zh ? "创建时间（从新到旧）" : "Created time (new to old)",
		byCreatedTimeReverse: zh ? "创建时间（从旧到新）" : "Created time (old to new)",
	};
	if (requireApiVersion("1.15.1")) labels.byRelevance = zh ? "相关性" : "Relevance";
	return labels;
}

/** Default search options are stored in `searchViewState`, under these keys. */
const SEARCH_KEY_PREFIX = "search.";

type SearchOptionKey = "sortOrder" | "collapseAll" | "extraContext" | "explainSearch";
type SettingKey =
	| Exclude<keyof FloatSearchSettings, "searchViewState">
	| `${typeof SEARCH_KEY_PREFIX}${SearchOptionKey}`;

export class FloatSearchSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: FloatSearchPlugin) {
		super(app, plugin);
	}

	/** Obsidian 1.13+ renders these itself and indexes them for the settings search. */
	getSettingDefinitions(): SettingDefinitionItem[] {
		return this.definitions();
	}

	getControlValue(key: string): unknown {
		return this.readValue(key);
	}

	setControlValue(key: string, value: unknown): Promise<void> {
		return this.writeValue(key, value);
	}

	/** Obsidian before 1.13 only calls display(): render the same definitions. */
	display() {
		const { containerEl } = this;
		containerEl.empty();
		this.renderItems(containerEl, this.definitions());
	}

	private definitions(): SettingDefinitionItem<SettingKey>[] {
		const s = strings();
		const zh = getLocale() === "zh";
		return [
			{
				type: "group",
				items: [
					{
						name: s.defaultViewType,
						desc: zh ? "选择命令、链接、书签及功能区打开搜索的位置。" : "Choose where searches from commands, links, bookmarks and the ribbon open.",
						control: { type: "dropdown", key: "defaultViewType", options: s.viewType },
					},
					{
						name: s.showInstructions,
						desc: zh ? "在搜索窗口下方显示快捷键。" : "Show keyboard shortcuts below the search window.",
						control: { type: "toggle", key: "showInstructions" },
					},
					{
						name: s.showFilePath,
						desc: zh ? "在每条结果的文件名旁显示文件夹。" : "Show the folder next to each result.",
						control: { type: "toggle", key: "showFilePath" },
					},
				],
			},
			// Search options used by every search opened through Float Search (#77).
			{
				type: "group",
				heading: zh ? "搜索默认值" : "Search defaults",
				items: [
					{
						name: zh ? "排序方式" : "Sort order",
						desc: zh ? "新搜索沿用此排序。在搜索视图中也可更改。" : "New searches use this sort order. You can also change it in the search view.",
						control: {
							type: "dropdown",
							key: "search.sortOrder",
							options: sortLabels(zh),
							defaultValue: "alphabetical",
						},
					},
					{
						name: zh ? "折叠结果" : "Collapse results",
						desc: zh ? "仅显示折叠的文件名。" : "Initially show file names only.",
						control: { type: "toggle", key: "search.collapseAll", defaultValue: false },
					},
					{
						name: zh ? "显示更多上下文" : "Show more context",
						desc: zh ? "显示每处匹配前后的更多行。" : "Show more lines around each match.",
						control: { type: "toggle", key: "search.extraContext", defaultValue: false },
					},
					{
						name: zh ? "解释搜索词" : "Explain search term",
						desc: zh ? "显示原生搜索如何解析查询。" : "Show how Obsidian interprets the query.",
						control: { type: "toggle", key: "search.explainSearch", defaultValue: false },
					},
				],
			},
			{
				type: "group",
				heading: s.tabQuickSearch,
				items: [
					{
						name: s.quickSearchTrigger,
						desc: s.quickSearchTriggerDesc,
						control: { type: "dropdown", key: "cmdkTriggerKey", options: { Shift: s.triggerShift, Control: s.triggerControl, Alt: s.triggerAlt, Meta: s.triggerMeta, none: s.triggerNone } },
					},
					{
						name: s.doubleTapInterval,
						desc: s.doubleTapIntervalDesc,
						control: { type: "slider", key: "cmdkDoubleTapInterval", min: 150, max: 600, step: 50 },
					},
				],
			},
			{
				type: "group",
				heading: s.tabQuickCreate,
				items: [
					{
						name: s.enableQuickCreate,
						desc: s.enableQuickCreateDesc,
						control: { type: "toggle", key: "cmdkQuickCreate" },
					},
					{
						name: s.quickCreateFolder,
						desc: s.quickCreateFolderDesc,
						control: { type: "text", key: "cmdkQuickCreateFolder", placeholder: s.quickCreateFolderPlaceholder },
					},
					{
						name: s.titleFormat,
						desc: s.titleFormatDesc,
						control: {
							type: "text",
							key: "cmdkQuickCreateTitleFormat",
							placeholder: "YYYYMMDDHHmmss",
						},
					},
				],
			},
		];
	}

	private readValue(key: string): unknown {
		const { settings } = this.plugin;
		if (key.startsWith(SEARCH_KEY_PREFIX)) {
			return nativeSearchState(settings.searchViewState)[key.slice(SEARCH_KEY_PREFIX.length)];
		}
		return (settings as unknown as Record<string, unknown>)[key];
	}

	private async writeValue(key: string, value: unknown): Promise<void> {
		if (key.startsWith(SEARCH_KEY_PREFIX)) {
			const update: Partial<searchState> = { [key.slice(SEARCH_KEY_PREFIX.length)]: value };
			await this.plugin.updateSearchDefaults(update);
			return;
		}
		if (key === "showFilePath") {
			// Also updates the open search views; saves the settings.
			this.plugin.setFilePathVisibility(value === true);
			return;
		}
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings();
	}

	private renderItems(containerEl: HTMLElement, items: SettingDefinitionItem[]) {
		for (const item of items) {
			if ("type" in item) {
				// Groups (and lists); this tab has no sub-pages.
				if (item.type === "page") continue;
				if (item.heading) new Setting(containerEl).setName(item.heading).setHeading();
				this.renderItems(containerEl, item.items ?? []);
				continue;
			}
			if (!item.control) continue;
			const setting = new Setting(containerEl).setName(item.name);
			if (item.desc) setting.setDesc(item.desc);
			this.renderControl(setting, item.control);
		}
	}

	private renderControl(setting: Setting, control: SettingControl) {
		const value = this.readValue(control.key);
		const save = (newValue: unknown) => this.writeValue(control.key, newValue);

		switch (control.type) {
			case "toggle":
				setting.addToggle((toggle) =>
					toggle
						.setValue(typeof value === "boolean" ? value : control.defaultValue ?? false)
						.onChange(save)
				);
				break;
			case "dropdown":
				setting.addDropdown((dropdown) =>
					dropdown
						.addOptions(control.options)
						.setValue(typeof value === "string" ? value : control.defaultValue ?? "")
						.onChange(save)
				);
				break;
			case "slider": {
				// Shown inline next to the slider, as Obsidian 1.13+ does.
				const current = typeof value === "number" ? value : control.defaultValue ?? control.min;
				const valueEl = setting.controlEl.createSpan({
					cls: "float-search-setting-value",
					text: String(current),
				});
				setting.addSlider((slider) =>
					slider
						.setLimits(control.min, control.max, control.step)
						.setValue(current)
						.onChange((newValue) => {
							valueEl.setText(String(newValue));
							return save(newValue);
						})
				);
				break;
			}
			case "text":
				setting.addText((text) =>
					text
						.setPlaceholder(control.placeholder ?? "")
						.setValue(typeof value === "string" ? value : control.defaultValue ?? "")
						.onChange(save)
				);
				break;
		}
	}
}
