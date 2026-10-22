import * as vscode from 'vscode';
import { getFlowrSession } from './extension';
import { makeSlicingCriteriaForPositions } from './flowr/utils';
import { Top } from '@eagleoutice/flowr/abstract-interpretation/domains/lattice';

/** `df$na`, `df[["na`, `df['na` and `df[, "na`: the data frame's name and what opens the column name */
const ColumnAccess = /(?<![\w.$@:])([A-Za-z.][A-Za-z0-9._]*)\s*(\$|\[\[\s*["']|\[\s*(?:[^[\]"']*,\s*)?["'])[A-Za-z0-9._]*$/;
const LookBehind = 300;
const Syntactic = /^[A-Za-z.][A-Za-z0-9._]*$/;

/** the columns a data frame has for sure (`must`) and maybe (`may`), as flowR infers them at the use of `df` */
async function columnsOf(document: vscode.TextDocument, at: vscode.Position): Promise<{ must: string[], may: string[] } | undefined> {
	const session = await getFlowrSession();
	const [criterion] = await makeSlicingCriteriaForPositions([at], document, session);
	if(!criterion) {
		return undefined;
	}
	const { result } = await session.retrieveQuery(document, [{ type: 'absint', inference: 'df-shape', criteria: [criterion] }]);
	const shapes = result['absint']?.result;
	if(!(shapes instanceof Map)) {
		return undefined;
	}
	for(const shape of shapes.values()) {
		const names = shape?.colnames;
		if(names?.isValue()) {
			const must = [...names.must];
			return { must, may: names.may === Top ? [] : [...names.may].filter(c => !must.includes(c)) };
		}
	}
	return undefined;
}

/** completions for the columns of the data frame in front of `$`, `[[` or `[` with a quote, or `undefined` if the cursor is not in such an access */
export async function columnCompletions(document: vscode.TextDocument, position: vscode.Position, textBefore: string, range: vscode.Range): Promise<vscode.CompletionItem[] | undefined> {
	const tail = textBefore.slice(-LookBehind);
	const match = ColumnAccess.exec(tail);
	if(!match) {
		return undefined;
	}
	const nameAt = document.positionAt(document.offsetAt(position) - (tail.length - match.index));
	const columns = await columnsOf(document, nameAt);
	if(!columns) {
		return undefined;
	}
	const quoted = match[2] !== '$';
	const item = (name: string, sure: boolean) => {
		const completion = new vscode.CompletionItem(name, vscode.CompletionItemKind.Field);
		completion.detail = sure ? `column of ${match[1]} (flowR)` : `possible column of ${match[1]} (flowR)`;
		completion.sortText = `${sure ? '0' : '1'}${name}`;
		completion.insertText = quoted || Syntactic.test(name) ? name : `\`${name}\``;
		completion.range = range;
		return completion;
	};
	return [...columns.must.map(c => item(c, true)), ...columns.may.map(c => item(c, false))];
}
