import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from './extension';
import { ConfigurableRefresher, isRTypeLanguage } from './configurable-refresher';
import { DependencyViewRefresherConfigKeys, Settings, getConfig } from './settings';
import type { DisplayedCategoryName } from './flowr/views/dependency-view';
import { buildDependencyQueries, dependencyDisplayInfo, isImplicitPlotPrint, renderFunctionName } from './flowr/views/dependency-view';
import { Unknown } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { DependenciesQueryResult, DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { LocationMapQueryResult } from '@eagleoutice/flowr/queries/catalog/location-map-query/location-map-query-format';
import type { SourceLocation } from '@eagleoutice/flowr/util/range';
import { isLocInDocument } from './lint';

/**
 * one color per category, from muted setup over cool data handling to warm results (mostly Okabe-Ito, so colorblind-friendly);
 * the defaults of the contributed `vscodeFlowr.category.*` theme colors of the dependency view must match
 */
export const CategoryColors: Record<DisplayedCategoryName, string> = {
	library:    '#4CAF50',
	remote:     '#26A69A',
	source:     '#9CCC65',
	read:       '#0072B2',
	transform:  '#56B4E9',
	statistics: '#7B3294',
	test:       '#CC79A7',
	visualize:  '#E69F00',
	write:      '#D55E00'
};

/** hover text of a line's indicator: the category in its color, what the line does, and why it counts */
function describe(category: DisplayedCategoryName, display: { name: string, verb: string }, info: DependencyInfo): string {
	const fn = renderFunctionName(info.functionName);
	const value = info.value && info.value !== Unknown ? ` \`${info.value}\`` : '';
	const namespaceAccess = (info.functionName as unknown) === '::' || (info.functionName as unknown) === ':::';
	const why = namespaceAccess
		? `\`${info.value ?? 'pkg'}${String(info.functionName)}…\` loads the package without \`library()\``
		: isImplicitPlotPrint(info)
			? 'R prints this top-level ggplot'
			: `\`${fn}\` ${display.verb}${value}`;
	return `<span style="color:${colorOf(category)};">■</span> **${display.name}** (flowR): ${why}`;
}

interface LineInfo { line: number, categories: DisplayedCategoryName[], labels: string[] }

const colorOf = (category: DisplayedCategoryName) => CategoryColors[category];
const indicatorsEnabled = () => getConfig().get<boolean>(Settings.StyleLineCategoryIndicators, true);

const CategoryOrder = Object.keys(dependencyDisplayInfo) as DisplayedCategoryName[];

/** the category whose color a line shows: the one furthest along the analysis (e.g. the plot, not the library it uses) */
export function primaryCategory(categories: readonly DisplayedCategoryName[]): DisplayedCategoryName {
	return categories.reduce((a, b) => CategoryOrder.indexOf(b) > CategoryOrder.indexOf(a) ? b : a);
}

/** a narrow bar in the category's color, as a data URI (works without node APIs) */
function barIcon(category: DisplayedCategoryName): vscode.Uri {
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect x='6' y='0' width='3' height='16' fill='${colorOf(category)}'/></svg>`;
	return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

function typeFor(category: DisplayedCategoryName): vscode.TextEditorDecorationType {
	let type = decorationTypes.get(category);
	if(!type) {
		type = vscode.window.createTextEditorDecorationType({
			gutterIconPath:     barIcon(category),
			gutterIconSize:     'contain',
			overviewRulerColor: colorOf(category),
			overviewRulerLane:  vscode.OverviewRulerLane.Right
		});
		decorationTypes.set(category, type);
	}
	return type;
}

function clearEditor(editor: vscode.TextEditor) {
	for(const type of decorationTypes.values()) {
		editor.setDecorations(type, []);
	}
}

/** collects the per-line categories of a dependency query result that lie in `document` (not in sourced scripts), sorted by line */
function collectLines(dependencies: DependenciesQueryResult, locations: LocationMapQueryResult, document: vscode.TextDocument): LineInfo[] {
	const lines = new Map<number, { categories: Set<DisplayedCategoryName>, labels: Set<string> }>();
	for(const [category, display] of Object.entries(dependencyDisplayInfo) as [DisplayedCategoryName, { name: string, verb: string }][]) {
		for(const info of dependencies[category] ?? []) {
			const loc = info.nodeId === undefined ? undefined : locations.map.ids[info.nodeId];
			if(!loc || !isLocInDocument([...loc[1], locations.map.files[loc[0]]] as SourceLocation, document)) {
				continue;
			}
			const line = Math.max(loc[1][0] - 1, 0);
			const entry = lines.get(line) ?? { categories: new Set(), labels: new Set() };
			entry.categories.add(category);
			entry.labels.add(describe(category, display, info));
			lines.set(line, entry);
		}
	}
	return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([line, e]) => ({ line, categories: CategoryOrder.filter(c => e.categories.has(c)), labels: [...e.labels] }));
}

/** decorates every visible editor of `doc` with the given lines */
function applyLines(doc: vscode.TextDocument, lines: LineInfo[]) {
	const byCategory = new Map<DisplayedCategoryName, vscode.Range[]>();
	for(const l of lines) {
		const category = primaryCategory(l.categories);
		byCategory.set(category, [...byCategory.get(category) ?? [], doc.lineAt(Math.min(l.line, doc.lineCount - 1)).range]);
	}
	for(const editor of vscode.window.visibleTextEditors.filter(e => e.document === doc)) {
		const used = new Set<vscode.TextEditorDecorationType>();
		for(const [category, ranges] of byCategory) {
			const type = typeFor(category);
			used.add(type);
			editor.setDecorations(type, ranges);
		}
		for(const type of decorationTypes.values()) {
			if(!used.has(type)) {
				editor.setDecorations(type, []);
			}
		}
	}
}

/** registers the line category gutter indicators and the internal `vscode-flowr.internal.lineCategories` command */
export function registerLineCategories(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	let lastKey: string | undefined;
	let lastLines: LineInfo[] = [];
	let lastUri: string | undefined;

	const reset = () => {
		lastKey = undefined;
		lastLines = [];
		lastUri = undefined;
	};

	const refresh = async(): Promise<void> => {
		const editor = vscode.window.activeTextEditor;
		if(!editor || !isRTypeLanguage(editor.document) || !indicatorsEnabled()) {
			if(editor) {
				clearEditor(editor);
			}
			reset();
			return;
		}
		const doc = editor.document;
		const version = doc.version;
		const queries = buildDependencyQueries();
		const key = `${doc.uri.toString()}@${version}@${JSON.stringify(queries)}`;
		if(key === lastKey) {
			// the same document may have just become visible in another editor
			applyLines(doc, lastLines);
			return;
		}
		try {
			const session = await getFlowrSession();
			const { result, hasError } = await session.retrieveQuery(doc, queries);
			if(doc.isClosed || doc.version !== version || !result.dependencies || !result['location-map']) {
				return;
			}
			const lines = collectLines(result.dependencies, result['location-map'], doc);
			// without a usable result, outdated bars would point at shifted lines
			if(hasError && lines.length === 0) {
				applyLines(doc, []);
				reset();
				return;
			}
			lastKey = key;
			lastLines = lines;
			lastUri = doc.uri.toString();
			applyLines(doc, lines);
		} catch(e) {
			output.appendLine(`[Line Categories] failed: ${e instanceof Error ? e.message : String(e)}`);
			clearEditor(editor);
			reset();
		}
	};

	const refresher = new ConfigurableRefresher({
		name:            'Line Categories',
		keys:            DependencyViewRefresherConfigKeys,
		refreshCallback: refresh,
		clearCallback:   () => {
			const editor = vscode.window.activeTextEditor;
			if(editor) {
				clearEditor(editor);
				reset();
			}
		},
		shouldUpdateHook: () => true,
		output
	});
	context.subscriptions.push(
		{ dispose: () => {
			refresher.dispose();
			decorationTypes.forEach(t => t.dispose());
			decorationTypes.clear();
		} },
		vscode.workspace.onDidChangeConfiguration(e => {
			if(!e.affectsConfiguration(`${Settings.Category}.${Settings.StyleLineCategoryIndicators}`)) {
				return;
			}
			if(indicatorsEnabled()) {
				void refresh();
			} else {
				vscode.window.visibleTextEditors.forEach(clearEditor);
				reset();
			}
		})
	);

	// VS Code has no hovers for the gutter, so the explanation shows when hovering the line's code
	context.subscriptions.push(vscode.languages.registerHoverProvider([{ language: 'r' }, { language: 'rmd' }], {
		provideHover(document, position) {
			if(!indicatorsEnabled() || document.uri.toString() !== lastUri || !lastKey?.startsWith(`${lastUri}@${document.version}@`)) {
				return undefined;
			}
			const labels = lastLines.find(l => l.line === position.line)?.labels;
			if(!labels) {
				return undefined;
			}
			const hover = new vscode.MarkdownString(labels.join('\n\n'));
			hover.supportHtml = true;
			return new vscode.Hover(hover, document.lineAt(position.line).range);
		}
	}));

	// the refresher only reacts to changes, so start the analysis for an R file that is already open on activation
	void refresh();

	registerCommand(context, 'vscode-flowr.style.toggleLineCategoryIndicators', async() => {
		const set = getConfig().inspect<boolean>(Settings.StyleLineCategoryIndicators);
		const target = set?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : set?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		await getConfig().update(Settings.StyleLineCategoryIndicators, !indicatorsEnabled(), target);
	});

	registerCommand(context, 'vscode-flowr.internal.lineCategories', async(): Promise<{ line: number, categories: string[], labels: string[] }[]> => {
		await refresh();
		const editor = vscode.window.activeTextEditor;
		if(!editor || lastUri !== editor.document.uri.toString() || !indicatorsEnabled()) {
			return [];
		}
		return lastLines.map(l => ({ line: l.line, categories: l.categories, labels: l.labels }));
	});
}
