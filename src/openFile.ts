import { App, PaneType, TFile, WorkspaceLeaf } from "obsidian";
import { isExcalidrawFile } from "./filterBar";

const previewSuppress = new Set<string>();

export function isPreviewSuppressed(path: string): boolean {
	return previewSuppress.has(path);
}

export function setPreviewFile(path: string | null): void {
	previewSuppress.clear();
	if (path) previewSuppress.add(path);
}

export function viewTypeForFile(app: App, file: TFile): string {
	if (
		isExcalidrawFile(app, file) &&
		app.viewRegistry.viewByType["excalidraw"]
	) {
		return "excalidraw";
	}
	return app.viewRegistry.typeByExtension[file.extension] ?? "markdown";
}

export function usesMarkdownView(app: App, file: TFile): boolean {
	return viewTypeForFile(app, file) === "markdown";
}

export async function openVaultFile(
	app: App,
	file: TFile,
	opts?: {
		leaf?: WorkspaceLeaf;
		newTab?: boolean | PaneType;
		active?: boolean;
		eState?: Record<string, unknown>;
		preview?: boolean;
	}
): Promise<WorkspaceLeaf | undefined> {
	if (opts?.preview) setPreviewFile(file.path);

	const newTab = opts?.newTab;
	const leaf =
		opts?.leaf ??
		(newTab
			? app.workspace.getLeaf(newTab === true ? "tab" : newTab)
			: app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf());
	if (!leaf) return;

	const type = viewTypeForFile(app, file);
	const markdown = type === "markdown";
	await leaf.openFile(file, {
		active: opts?.active ?? true,
		eState: markdown ? opts?.eState : undefined,
	});

	const actual = leaf.view?.getViewType();
	if (actual === "markdown" && type !== "markdown") {
		await leaf.setViewState({
			type,
			state: { file: file.path },
			active: opts?.active ?? true,
		});
		if (opts?.eState) {
			leaf.setEphemeralState(opts.eState);
		}
	}

	return leaf;
}
