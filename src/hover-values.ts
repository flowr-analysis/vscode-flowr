import * as vscode from 'vscode';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { getFlowrSession } from './extension';
import type { FlowrSession } from './flowr/utils';
import { makeSlicingCriteria } from './flowr/utils';
import { Bottom, Top } from '@eagleoutice/flowr/abstract-interpretation/domains/lattice';
import { isTop, stringifyValue } from '@eagleoutice/flowr/dataflow/eval/values/r-value';
import type { SingleSlicingCriterion } from '@eagleoutice/flowr/slicing/criterion/parse';
import { getConfig, Settings } from './settings';

export function registerHoverOverValues(output: vscode.OutputChannel): vscode.Disposable {
	return vscode.languages.registerHoverProvider(
		// only for r
		{ scheme: 'file', language: 'r' },
		new FlowrHoverProvider(output)
	);
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
	// TODO: private refresher:       ConfigurableRefresher;
   

	constructor(output: vscode.OutputChannel) {
		this.output = output;
		// TODO: register disposables
		vscode.workspace.onDidChangeTextDocument(e => {
			if(e.document.languageId === 'r') {
				void this.update();
			}
		});
		vscode.window.onDidChangeActiveTextEditor(e => {
			if(e?.document.languageId === 'r') {
				void this.update();
			}
		});
		setTimeout(() => void this.update(), 50);
		setTimeout(() => void this.update(), 250);
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
		
		const [criteria] = makeSlicingCriteria([pos], document);
		const cached = this.cache.get(criteria);
		if(cached) { 
			return valueToHint(cached);
		}
      
		// TODO: data-frames
		const valQuer = await this.session.retrieveQuery(document, [{ type: 'resolve-value', criteria: [criteria] }, { type: 'df-shape', criterion: criteria }]);
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

