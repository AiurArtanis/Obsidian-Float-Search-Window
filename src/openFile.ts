import { App, PaneType, TFile, WorkspaceLeaf } from "obsidian";
import { isExcalidrawFile } from "./filterBar";

const previewSuppress = new Map<string, number>();

export function isPreviewSuppressed(path: string): boolean {
	return previewSuppress.has(path);
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
	const newTab = opts?.newTab;
	const leaf =
		opts?.leaf ??
		(newTab
			? app.workspace.getLeaf(newTab === true ? "tab" : newTab)
			: app.workspace.getMostRecentLeaf() ?? app.workspace.getLeaf());
	if (!leaf) return;

	if (opts?.preview) previewSuppress.set(file.path, (previewSuppress.get(file.path) ?? 0) + 1);
	try {
		const type = viewTypeForFile(app, file);
		const markdown = type === "markdown";
		await leaf.openFile(file, {
			active: opts?.active ?? true,
			eState: markdown ? opts?.eState : undefined,
		});

		const actual =
			typeof leaf.view?.getViewType === "function"
				? leaf.view.getViewType()
				: undefined;
		if (actual === "markdown" && type !== "markdown") {
			await leaf.setViewState({
				type,
				state: { file: file.path },
				active: opts?.active ?? true,
			});
		}
		if (opts?.eState && actual === "markdown" && type !== "markdown") {
			leaf.setEphemeralState(opts.eState);
		} else if (
			!opts?.preview &&
			opts?.eState &&
			(opts.eState.subpath || opts.eState.line != null)
		) {
			leaf.setEphemeralState(opts.eState);
		}
	} finally {
		if (opts?.preview) {
			const remaining = (previewSuppress.get(file.path) ?? 1) - 1;
			if (remaining) previewSuppress.set(file.path, remaining);
			else previewSuppress.delete(file.path);
		}
	}

	return leaf;
}
