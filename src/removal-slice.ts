import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from './extension';
import { isRTypeLanguage } from './configurable-refresher';
import { isLocInDocument } from './lint';
import { resolveSlicingCriteria } from './flowr/utils';
import { getReconstructionContentProvider, makeUri } from './doc-provider';
import type { Dependency } from './flowr/views/dependency-view';
import type { SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { RExpressionList } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-expression-list';
import { SourceLocation } from '@eagleoutice/flowr/util/range';
import { SliceDirection } from '@eagleoutice/flowr/util/slice-direction';

export interface RemovalSlice {
	/** the (0-based) lines of the top-level statements that only the criteria need, which can be removed with them */
	removedLines: number[]
	/** the document without these lines */
	code:         string
	/** why nothing can be removed, if so */
	problem?:     string
}

/** the top-level statements of the document, each with its id and (0-based) lines */
function topLevelStatements(ast: NormalizedAst, document: vscode.TextDocument): { id: NodeId, lines: [number, number] }[] {
	return ast.ast.files.flatMap(f => RExpressionList.is(f.root) ? f.root.children : [f.root]).flatMap(node => {
		const span = RNode.span(node);
		const loc = SourceLocation.fromNode(node);
		return span && loc && isLocInDocument(loc, document) ? [{ id: node.info.id, lines: [span[0] - 1, span[2] - 1] as [number, number] }] : [];
	});
}

/**
 * The removal slice of `criteria`: the top-level statements in their backward slice that nothing else in the document needs,
 * i.e. that are in no backward slice of the remaining statements. Removing them removes the criteria and everything that
 * exists only for them, while the rest of the script keeps working.
 */
export async function computeRemovalSlice(document: vscode.TextDocument, criteria: SlicingCriteria): Promise<RemovalSlice> {
	const session = await getFlowrSession();
	const slice = await session.retrieveSlice(criteria, SliceDirection.Backward, document, false);
	if(slice.sliceElements.length === 0) {
		return { removedLines: [], code: document.getText(), problem: slice.problem ?? 'flowR found no code for the slicing criterion' };
	}
	const { ast } = await session.retrieveQuery(document, [{ type: 'normalized-ast' }]);
	if(!ast) {
		return { removedLines: [], code: document.getText(), problem: 'flowR could not analyze the document' };
	}
	const inSlice = new Set(slice.sliceElements.map(e => e.id));
	const statements = topLevelStatements(ast, document);
	const candidates = statements.filter(s => inSlice.has(s.id));
	const rest = statements.filter(s => !inSlice.has(s.id));
	const kept = rest.length > 0 ? (await session.retrieveSlice(rest.map(s => `$${s.id}`) as SlicingCriteria, SliceDirection.Backward, document, false)).sliceElements : [];
	const keptIds = new Set(kept.map(e => e.id));
	// a statement that the rest needs even in part stays as a whole, so that the remaining code stays valid
	const removed = candidates.filter(s => !keptIds.has(s.id) && !kept.some(e => e.location[0] - 1 >= s.lines[0] && e.location[2] - 1 <= s.lines[1]));
	const removedLines = [...new Set(removed.flatMap(s => Array.from({ length: s.lines[1] - s.lines[0] + 1 }, (_, i) => s.lines[0] + i)))].sort((a, b) => a - b);
	const gone = new Set(removedLines);
	const code = Array.from({ length: document.lineCount }, (_, i) => i).filter(i => !gone.has(i)).map(i => document.lineAt(i).text).join('\n');
	return { removedLines, code, problem: removedLines.length === 0 ? 'the rest of the script needs all of its code' : undefined };
}

const removalDecoration = vscode.window.createTextEditorDecorationType({
	isWholeLine:        true,
	backgroundColor:    new vscode.ThemeColor('diffEditor.removedLineBackground'),
	overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
	overviewRulerLane:  vscode.OverviewRulerLane.Left
});

/** removes the marks of the last removal slice */
export function clearRemovalSlice(): void {
	vscode.window.visibleTextEditors.forEach(e => e.setDecorations(removalDecoration, []));
}

async function showRemovalSlice(editor: vscode.TextEditor, criteria: SlicingCriteria, what: string): Promise<RemovalSlice> {
	clearRemovalSlice();
	const result = await computeRemovalSlice(editor.document, criteria);
	if(result.removedLines.length === 0) {
		void vscode.window.showInformationMessage(`flowR: Nothing to remove for ${what}: ${result.problem ?? 'unknown reason'}.`);
		return result;
	}
	editor.setDecorations(removalDecoration, result.removedLines.map(l => editor.document.lineAt(l).range));
	const uri = makeUri('removal-slice', `Without ${what.replace(/[/\\]/g, '_')}.R`);
	getReconstructionContentProvider().updateContents(uri, result.code);
	await vscode.commands.executeCommand('vscode.diff', editor.document.uri, uri, `Remove ${what} (${result.removedLines.length} line${result.removedLines.length === 1 ? '' : 's'})`,
		{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: true });
	return result;
}

/** registers the removal slice for the cursor position, for a dependency, and the internal command for tests */
export function registerRemovalSlice(context: vscode.ExtensionContext) {
	const atCursor = async(editor: vscode.TextEditor) => {
		const { criteria, problem } = await resolveSlicingCriteria(editor.selections.map(s => s.active), editor.document, await getFlowrSession());
		return { criteria, problem };
	};

	registerCommand(context, 'vscode-flowr.slice.removal', async() => {
		const editor = vscode.window.activeTextEditor;
		if(!editor || !isRTypeLanguage(editor.document)) {
			return undefined;
		}
		const { criteria, problem } = await atCursor(editor);
		if(problem) {
			void vscode.window.showWarningMessage(`flowR: No removal slice: ${problem}.`);
			return undefined;
		}
		const word = editor.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active, /[a-zA-Z0-9._]+/));
		return await showRemovalSlice(editor, criteria, word ? `"${word}"` : `line ${editor.selection.active.line + 1}`);
	});

	registerCommand(context, 'vscode-flowr.internal.removal-slice.dependency', async(dependency: Dependency) => {
		const editor = vscode.window.activeTextEditor;
		const id = dependency.getNodeId();
		if(!editor || id === undefined) {
			return undefined;
		}
		return await showRemovalSlice(editor, [`$${id}`] as SlicingCriteria, typeof dependency.label === 'string' ? `"${dependency.label}"` : 'the dependency');
	});

	registerCommand(context, 'vscode-flowr.internal.removalSlice', async(position: vscode.Position): Promise<RemovalSlice | undefined> => {
		const editor = vscode.window.activeTextEditor;
		if(!editor) {
			return undefined;
		}
		const { criteria, problem } = await resolveSlicingCriteria([position], editor.document, await getFlowrSession());
		return problem ? { removedLines: [], code: editor.document.getText(), problem } : await computeRemovalSlice(editor.document, criteria);
	});
}
