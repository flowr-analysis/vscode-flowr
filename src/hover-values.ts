import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import { makeSlicingCriteriaForPositions } from './flowr/utils';
import { Bottom, BottomSymbol, Top, TopSymbol } from '@eagleoutice/flowr/abstract-interpretation/domains/lattice';
import { isBottom, isTop, stringifyValue } from '@eagleoutice/flowr/dataflow/eval/values/r-value';
import { getConfig, Settings } from './settings';
import { ConfigurableRefresher, RefreshType } from './configurable-refresher';
import type { Queries } from '@eagleoutice/flowr/queries/query';
import type { Writable } from 'ts-essentials';
import { builtInEnvJsonReplacer } from '@eagleoutice/flowr/dataflow/environments/environment';
import type { SlicingCriterion } from '@eagleoutice/flowr/slicing/criterion/parse';

/**
 *
 */
export function registerHoverOverValues(output: vscode.OutputChannel): vscode.Disposable[] {
	const provider = new FlowrHoverProvider(output);
	return [vscode.languages.registerHoverProvider(
		{ language: 'r' },
		provider
	), vscode.languages.registerHoverProvider(
		{ language: 'rmd' },
		provider
	)];
}

interface ValueInfo {
	// can also be more complex structures like df shapes
	value:    unknown;
	textRep:  string;
	criteria: SlicingCriterion;
}

class FlowrHoverProvider implements vscode.HoverProvider {
	/** LRU cap so rapid hovering can't grow memory without bound */
	private static readonly maxCacheEntries = 250;
	private readonly output:    vscode.OutputChannel;
	private readonly updateEvent = new vscode.EventEmitter<void>();
	public onDidChangeInlayHints = this.updateEvent.event;
	/** insertion-ordered LRU cache of resolved values, keyed by `uri@version#criterion` (node ids collide across files) */
	private readonly cache = new Map<string, ValueInfo[]>();
	private readonly refresher: ConfigurableRefresher;


	constructor(output: vscode.OutputChannel) {
		this.output = output;
		this.refresher = new ConfigurableRefresher({
			name: 'Hover-Over Values',
			keys: {
				type:          'fixed',
				updateType:    RefreshType.OnChange,
				adaptiveBreak: 20,
				interval:      500
			},
			refreshCallback: () => {
				this.update();
			},
			clearCallback: () => {
				this.cache.clear();
			},
			output: output
		});

		setTimeout(() => void this.update(), 500);
	}

	dispose() {
		this.refresher.dispose();
	}

	update() {
		this.output.appendLine('[Hover Values] Clearing hover value cache');
		this.cache.clear();
		this.updateEvent.fire();
	}


	async provideHover(document: vscode.TextDocument, pos: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		const session = await getFlowrSession();
		if(!session || token.isCancellationRequested || !(getConfig().get<boolean>(Settings.ValuesOnHover))) {
			return undefined;
		}

		this.output.appendLine(`[Hover Values] Resolving value at ${document.uri.toString()}:${pos.line + 1}:${pos.character + 1}`);

		const [criteria] = await makeSlicingCriteriaForPositions([pos], document, session);
		if(!criteria || token.isCancellationRequested) {
			return undefined;
		}
		const cacheKey = `${document.uri.toString()}@${document.version}#${criteria}`;
		const cached = this.cache.get(cacheKey);
		if(cached) {
			// refresh recency (LRU) so hot positions survive eviction
			this.cache.delete(cacheKey);
			this.cache.set(cacheKey, cached);
			this.output.appendLine(`    [Hover Values] Using cached value for ${document.uri.toString()}:${pos.line + 1}:${pos.character + 1} (${JSON.stringify(cached.map(c => c.value), builtInEnvJsonReplacer)})`);
			return valueToHint(cached);
		}
		const query: Writable<Queries<'resolve-value' | 'absint'>> = [];
		if(getConfig().get<boolean>(Settings.ValuesHoverResolve, true)) {
			query.push({ type: 'resolve-value', criteria: [criteria] } as const);
		}
		if(getConfig().get<boolean>(Settings.ValuesHoverDataFrames, true)) {
			// dataframe shape inference moved under the general "absint" (abstract interpretation) query as the
			// 'df-shape' inference, rather than being its own top-level query type
			query.push({ type: 'absint', inference: 'df-shape', criteria: [criteria] } as const);
		}
		let valQuer;
		try {
			valQuer = await session.retrieveQuery(document, query);
		} catch(e) {
			// never let a hover error bubble up (it would surface as a broken hover); just skip this hover
			this.output.appendLine(`[Hover Values] Error while resolving value: ${(e as Error).message}`);
			return undefined;
		}
		if(token.isCancellationRequested) {
			return undefined;
		}
		const results = Object.values(valQuer.result['resolve-value'].results).flatMap(r => r.values);
		// only surface real values: drop top/bottom (e.g. `print(...)` resolves to ⊥, which we don't show)
		const values: ValueInfo[] = results
			.filter(v => !isTop(v) && !isBottom(v))
			.map(r => ({ value: r, textRep: stringifyValue(r), criteria }))
			.filter(v => v.textRep.length > 0 && v.textRep !== BottomSymbol && v.textRep !== TopSymbol);
		const dfShape = valQuer.result['absint']?.result;
		if(dfShape instanceof Map) {
			for(const e of dfShape.entries()) {
				const [, shape] = e;
				if(shape) {
					values.push({
						value:   shape,
						textRep: `
Dataframe Shape:

*Columns*: ${formatSetRange(shape.colnames.value)}\\
*Cols*: ${shape.cols.toString()}\\
*Rows*: ${shape.rows.toString()}
					`.trim(),
						criteria: criteria
					});
				}
			}
		}
		this.cachePut(cacheKey, values);
		return valueToHint(values);
	}

	/** stores a resolved value, evicting the least-recently-used entry once {@link maxCacheEntries} is exceeded */
	private cachePut(key: string, values: ValueInfo[]) {
		if(this.cache.size >= FlowrHoverProvider.maxCacheEntries) {
			const oldest = this.cache.keys().next().value;
			if(oldest !== undefined) {
				this.cache.delete(oldest);
			}
		}
		this.cache.set(key, values);
	}
}

function formatSetRange(set: { readonly min: ReadonlySet<string>, readonly range: ReadonlySet<string> | typeof Top } | typeof Top | typeof Bottom): string {
	if(set === Bottom) {
		return BottomSymbol;
	} else if(set === Top || (set.min.size === 0 && set.range === Top)) {
		return TopSymbol;
	}
	let txt: string | undefined;

	if(set.min.size === 0) {
		txt = '*\\<None\\>*';
	} else {
		txt = `${set.min.values().toArray().map(entry => '`' + entry + '`').join(', ')}`;
	}
	if(set.range === Top) {
		txt += ' (Potential: ' + TopSymbol + ')';
	} else if(set.range.size > 0) {
		txt += ' (Potential: ' + set.range.values().toArray().map(entry => '`' + entry + '`').join(', ') + ')';
	}
	return txt;
}

function valueToHint(cached: ValueInfo[]): vscode.Hover | undefined {
	if(cached.length === 0) {
		return undefined;
	}
	return {
		contents: [
			new vscode.MarkdownString()
				.appendMarkdown('**Inferred Value**\n\n' + cached.map(v => v.textRep).join('\n\n'))
		]
	};
}

