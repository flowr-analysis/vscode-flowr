import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from './extension';
import { ConfigurableRefresher, isRTypeLanguage } from './configurable-refresher';
import { DependencyViewRefresherConfigKeys, Settings, getConfig } from './settings';
import type { DisplayedCategoryName } from './flowr/views/dependency-view';
import { buildDependencyQueries, dependencyDisplayInfo, renderFunctionName } from './flowr/views/dependency-view';
import type { DependenciesQueryResult, DependencyInfo } from '@eagleoutice/flowr/queries/catalog/dependencies-query/dependencies-query-format';
import type { LocationMapQueryResult } from '@eagleoutice/flowr/queries/catalog/location-map-query/location-map-query-format';
import type { SourceLocation } from '@eagleoutice/flowr/util/range';
import { isLocInDocument } from './lint';

/** colorblind-friendly (Okabe-Ito based) color per dependency category */
const CategoryColors: Record<DisplayedCategoryName, string> = {
	library:    '#0072B2',
	read:       '#009E73',
	source:     '#CC79A7',
	write:      '#E69F00',
	visualize:  '#D55E00',
	test:       '#F0E442',
	statistics: '#7B3294',
	remote:     '#999999'
};

interface LineInfo { line: number, categories: DisplayedCategoryName[], labels: string[] }

const colorOf = (category: DisplayedCategoryName) => CategoryColors[category];
const indicatorsEnabled = () => getConfig().get<boolean>(Settings.StyleLineCategoryIndicators, true);

/** a narrow bar made of one vertical stripe per category, as a data URI (works without node APIs) */
function barIcon(categories: DisplayedCategoryName[]): vscode.Uri {
	const w = 6 / categories.length;
	const rects = categories.map((c, i) => `<rect x='${5 + i * w}' y='0' width='${w}' height='16' fill='${colorOf(c)}'/>`).join('');
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>${rects}</svg>`;
	return vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
}

const decorationTypes = new Map<string, vscode.TextEditorDecorationType>();

function typeFor(categories: DisplayedCategoryName[]): vscode.TextEditorDecorationType {
	const key = categories.join(',');
	let type = decorationTypes.get(key);
	if(!type) {
		type = vscode.window.createTextEditorDecorationType({
			gutterIconPath:     barIcon(categories),
			gutterIconSize:     'contain',
			overviewRulerColor: colorOf(categories[0]),
			overviewRulerLane:  vscode.OverviewRulerLane.Right
		});
		decorationTypes.set(key, type);
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
	for(const [category, display] of Object.entries(dependencyDisplayInfo) as [DisplayedCategoryName, { name: string }][]) {
		for(const info of (dependencies[category] as DependencyInfo[] | undefined) ?? []) {
			const loc = info.nodeId === undefined ? undefined : locations.map.ids[info.nodeId];
			if(!loc || !isLocInDocument([...loc[1], locations.map.files[loc[0]]] as SourceLocation, document)) {
				continue;
			}
			const line = Math.max(loc[1][0] - 1, 0);
			const entry = lines.get(line) ?? { categories: new Set(), labels: new Set() };
			entry.categories.add(category);
			entry.labels.add(`flowR: ${display.name} (${renderFunctionName(info.functionName)})`);
			lines.set(line, entry);
		}
	}
	return [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([line, e]) => ({ line, categories: [...e.categories].sort(), labels: [...e.labels] }));
}

/** decorates every visible editor of `doc` with the given lines */
function applyLines(doc: vscode.TextDocument, lines: LineInfo[]) {
	const byCombo = new Map<string, { categories: DisplayedCategoryName[], options: vscode.DecorationOptions[] }>();
	for(const l of lines) {
		const combo = l.categories.join(',');
		const group = byCombo.get(combo) ?? { categories: l.categories, options: [] };
		group.options.push({ range: doc.lineAt(Math.min(l.line, doc.lineCount - 1)).range, hoverMessage: new vscode.MarkdownString(l.labels.join('\n\n')) });
		byCombo.set(combo, group);
	}
	for(const editor of vscode.window.visibleTextEditors.filter(e => e.document === doc)) {
		const used = new Set<vscode.TextEditorDecorationType>();
		for(const g of byCombo.values()) {
			const type = typeFor(g.categories);
			used.add(type);
			editor.setDecorations(type, g.options);
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
			if(e.affectsConfiguration(`${Settings.Category}.${Settings.StyleLineCategoryIndicators}`) && !indicatorsEnabled()) {
				vscode.window.visibleTextEditors.forEach(clearEditor);
				reset();
			}
		})
	);

	registerCommand(context, 'vscode-flowr.internal.lineCategories', async(): Promise<{ line: number, categories: string[] }[]> => {
		await refresh();
		const editor = vscode.window.activeTextEditor;
		if(!editor || lastUri !== editor.document.uri.toString() || !indicatorsEnabled()) {
			return [];
		}
		return lastLines.map(l => ({ line: l.line, categories: l.categories }));
	});
}
