import * as vscode from 'vscode';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { getFlowrSession } from './extension';
import type { FlowrSession } from './flowr/utils';
import { makeSlicingCriteria } from './flowr/utils';
import { Bottom, Top } from '@eagleoutice/flowr/abstract-interpretation/domains/lattice';
import { isTop, stringifyValue } from '@eagleoutice/flowr/dataflow/eval/values/r-value';
import type { SingleSlicingCriterion } from '@eagleoutice/flowr/slicing/criterion/parse';
import { getConfig, Settings } from './settings';
import { ConfigurableRefresher, RefreshType } from './configurable-refresher';
import type { Queries } from '@eagleoutice/flowr/queries/query';
import type { Writable } from 'ts-essentials';
import { builtInEnvJsonReplacer } from '@eagleoutice/flowr/dataflow/environments/environment';

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
   value:   unknown; 
   textRep: string;
	criteria:  SingleSlicingCriterion;
}

class FlowrHoverProvider implements vscode.HoverProvider {
	private readonly output: vscode.OutputChannel;
	private readonly updateEvent = new vscode.EventEmitter<void>();
	public onDidChangeInlayHints = this.updateEvent.event;
	private readonly cache = new Map<NodeId, ValueInfo[]>();
	private session:         FlowrSession | undefined;
	private refresher:       ConfigurableRefresher;
   

	constructor(output: vscode.OutputChannel) {
		this.output = output;
		this.refresher = new ConfigurableRefresher({
			name: 'Dependency View',
			keys: {
				type:          'fixed',
				updateType:    RefreshType.OnChange,
				adaptiveBreak: 0,
				interval:      0
			},
			refreshCallback: async() => {
				await this.update(); 
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

	async update(): Promise<void> {
		this.session = await getFlowrSession();
		this.cache.clear();
		this.updateEvent.fire();
	}


	async provideHover(document: vscode.TextDocument, pos: vscode.Position, _token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
		if(!this.session || !(getConfig().get<boolean>(Settings.ValuesOnHover))) {
			return undefined;
		}
		
		this.output.appendLine(`[Hover Values] Resolving value at ${document.uri.toString()}:${pos.line + 1}:${pos.character + 1}`);
		
		const [criteria] = makeSlicingCriteria([pos], document);
		const cached = this.cache.get(criteria);
		if(cached) { 
			this.output.appendLine(`    [Hover Values] Using cached value for ${document.uri.toString()}:${pos.line + 1}:${pos.character + 1} (${JSON.stringify(cached.map(c => c.value), builtInEnvJsonReplacer)})`);
			return valueToHint(cached);
		}
		const query: Writable<Queries<'resolve-value' | 'df-shape'>> = [];
		if(getConfig().get<boolean>(Settings.ValuesHoverResolve, true)) {
			query.push({ type: 'resolve-value', criteria: [criteria] } as const);
		}
		if(getConfig().get<boolean>(Settings.ValuesHoverDataFrames, true)) {
			query.push({ type: 'df-shape', criterion: criteria } as const);
		}
		const valQuer = await this.session.retrieveQuery(document, query);
		const results = Object.values(valQuer.result['resolve-value'].results).flatMap(r => r.values);
		const values: ValueInfo[] = results.filter(v => !isTop(v)).map(r => {
			return {
				value:    r,
				textRep:  stringifyValue(r),
				criteria: criteria
			};
		});
		const dfShape = valQuer.result['df-shape'].domains;
		if(dfShape instanceof Map) {
			for(const e of dfShape.entries()) {
				const [, shape] = e;
				if(shape) {
					values.push({
						value:   shape,
						textRep: `Dataframe Shape:
|    |    |
|----|----|
| Rows: | ${intLift2Str(shape.rows.value)} |
| Cols: | ${intLift2Str(shape.cols.value)} |

Known Columns: ${setString(shape.colnames.value)}

					`.trim(),
						criteria: criteria
					});
				}
			}
		}
		this.cache.set(criteria, values);
		return valueToHint(values);
	}
}

function setString(set:  { readonly min: ReadonlySet<string>, readonly range: ReadonlySet<string> | typeof Top } | typeof Top | typeof Bottom): string {
	if(set === Bottom) {
		return '⊥';
	}
	if(set === Top) {
		return '⊤';
	}
	let txt = `${[...set.min].map(f => `\`${f}\``).join(', ')}
	`;
	if(set.range === Top) {
		txt += '(Potential: ⊤)';
	} else if(set.range.size > 0) {
		txt += '(Potential: ' + [...set.range].map(f => `\`${f}\``).join(', ') + ')';
	}
	return txt;
}
function intLift2Str(val: readonly [number, number] | typeof Bottom): string {
	if(val === Bottom) {
		return '⊥';
	}
	return `[${val[0]}, ${val[1]}]`;
}
function valueToHint(cached: ValueInfo[]): vscode.Hover | undefined {
	if(cached.length === 0) {
		return undefined;
	}
	return {
		contents: [
			new vscode.MarkdownString()
				.appendMarkdown('**Inferred Value**\n\n' + cached.map(v => v.textRep).join('\n'))
		]
	};
}

