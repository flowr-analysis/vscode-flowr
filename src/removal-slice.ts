import * as vscode from 'vscode';
import { getFlowrSession, registerCommand } from './extension';
import { isRTypeLanguage } from './configurable-refresher';
import { isLocInDocument } from './lint';
import { resolveSlicingCriteria } from './flowr/utils';
import { getReconstructionContentProvider, makeUri, showUri } from './doc-provider';
import type { Dependency } from './flowr/views/dependency-view';
import { dependencyViewDocument } from './flowr/views/dependency-view';
import { RFunctionDefinition } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-function-definition';
import type { SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';
import { SlicingCriterion } from '@eagleoutice/flowr/slicing/criterion/parse';
import type { NormalizedAst } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/decorate';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { RNode } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/model';
import { RExpressionList } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/nodes/r-expression-list';
import { SourceLocation } from '@eagleoutice/flowr/util/range';

export interface RemovalSlice {
	/** the (0-based) lines that are removed as a whole */
	removedLines:  number[]
	/** everything that is removed, including parts of lines that other code shares */
	removedRanges: vscode.Range[]
	/** the document without the removed code */
	code:          string
	/** why nothing can be removed, if so */
	problem?:      string
}

type Ast = NormalizedAst['idMap'] extends Map<NodeId, infer N> ? N : never;

/** the statements of the document: the children of the top-level and every braced block, except for function bodies */
function statementsOf(ast: NormalizedAst, document: vscode.TextDocument): Map<NodeId, Ast> {
	const result = new Map<NodeId, Ast>();
	RNode.visitAst(ast.ast.files.map(f => f.root), node => {
		if(RExpressionList.is(node)) {
			for(const child of node.children) {
				const loc = SourceLocation.fromNode(child);
				if(loc && isLocInDocument(loc, document)) {
					result.set(child.info.id, child);
				}
			}
		}
		// the body of a function only runs when it is called, so it is the function that goes or stays
		return RFunctionDefinition.is(node);
	});
	return result;
}

/** the innermost statement that contains `id` */
function statementOf(ast: NormalizedAst, statements: Map<NodeId, Ast>, id: NodeId): Ast | undefined {
	for(let node = ast.idMap.get(id); node; node = node.info.parent === undefined ? undefined : ast.idMap.get(node.info.parent)) {
		if(statements.has(node.info.id)) {
			return statements.get(node.info.id);
		}
	}
	return undefined;
}

/** the range a removed statement takes: whole lines (with the comment lines right above it) if it has its lines alone */
function removalRange(statement: Ast, document: vscode.TextDocument): vscode.Range | undefined {
	const span = RNode.span(statement);
	if(!span) {
		return undefined;
	}
	const range = new vscode.Range(span[0] - 1, span[1] - 1, span[2] - 1, span[3]);
	const before = document.lineAt(range.start.line).text.slice(0, range.start.character);
	const after = document.lineAt(range.end.line).text.slice(range.end.character);
	if(before.trim() !== '' || !/^\s*;?\s*(#.*)?$/.test(after)) {
		const semicolon = /^\s*;\s*/.exec(after);
		return semicolon ? range.with({ end: range.end.translate(0, semicolon[0].length) }) : range;
	}
	let first = range.start.line;
	while(first > 0 && /^\s*#(?!!)/.test(document.lineAt(first - 1).text) && !/nolint/.test(document.lineAt(first - 1).text)) {
		first--;
	}
	// comments at the very top describe the script, not its first statement
	return new vscode.Range(first === 0 ? range.start.line : first, 0, range.end.line + 1, 0);
}

/**
 * The removal slice of `criteria`, computed by flowR: the statements that exist only for them (including the setup and
 * teardown of a removed plot), plus the comments right above removed lines. The rest of the script keeps working.
 */
export async function computeRemovalSlice(document: vscode.TextDocument, criteria: SlicingCriteria): Promise<RemovalSlice> {
	const unchanged = (problem: string): RemovalSlice => ({ removedLines: [], removedRanges: [], code: document.getText(), problem });
	const session = await getFlowrSession();
	const { ast } = await session.retrieveQuery(document, []);
	if(!ast) {
		return unchanged('flowR could not analyze the document');
	}
	const statements = statementsOf(ast, document);
	// a criterion removes its whole statement, which also links it to what it saves (e.g. `ggplot() + geom_bar()` to its `ggsave()`)
	const whole = new Set(SlicingCriterion.convertAll(criteria, ast.idMap).map(id => statementOf(ast, statements, id)?.info.id ?? id));
	const { result } = await session.retrieveQuery(document, [{ type: 'static-slice', criteria: [...whole].map(id => `$${id}`) as SlicingCriteria, removal: true, noReconstruction: true }]);
	const slice = Object.values(result['static-slice']?.results ?? {})[0];
	if(!slice) {
		return unchanged('flowR could not analyze the document');
	}
	const inRemoval = new Set<NodeId>(slice.slice.result);
	const removed = [...statements.values()].filter(s => inRemoval.has(s.info.id) && !(s.info.parent !== undefined && inRemoval.has(s.info.parent)));
	const removedRanges = removed.map(s => removalRange(s, document)).filter(r => r !== undefined).sort((a, b) => a.start.compareTo(b.start));
	if(removedRanges.length === 0) {
		return unchanged('the rest of the script needs all of its code');
	}
	let code = document.getText();
	for(const range of removedRanges.toReversed()) {
		code = code.slice(0, document.offsetAt(range.start)) + code.slice(document.offsetAt(range.end));
	}
	const removedLines = removedRanges.filter(r => r.start.character === 0 && r.end.character === 0)
		.flatMap(r => Array.from({ length: r.end.line - r.start.line }, (_, i) => r.start.line + i));
	return { removedLines, removedRanges, code };
}

const removalDecoration = vscode.window.createTextEditorDecorationType({
	isWholeLine:        true,
	backgroundColor:    new vscode.ThemeColor('diffEditor.removedLineBackground'),
	overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
	overviewRulerLane:  vscode.OverviewRulerLane.Left
});
const partialRemovalDecoration = vscode.window.createTextEditorDecorationType({
	backgroundColor: new vscode.ThemeColor('diffEditor.removedTextBackground')
});

let marked: vscode.TextDocument | undefined;

/** removes the marks of the last removal slice */
export function clearRemovalSlice(): void {
	marked = undefined;
	vscode.window.visibleTextEditors.forEach(e => {
		e.setDecorations(removalDecoration, []);
		e.setDecorations(partialRemovalDecoration, []);
	});
}

let removalRequest = 0;

async function showRemovalSlice(editor: vscode.TextEditor, criteria: SlicingCriteria, what: string): Promise<RemovalSlice> {
	clearRemovalSlice();
	const request = ++removalRequest;
	const version = editor.document.version;
	const result = await computeRemovalSlice(editor.document, criteria);
	// an edit or a newer removal slice in the meantime makes this one stale
	if(request !== removalRequest || editor.document.version !== version || editor.document.isClosed) {
		return { ...result, problem: 'the document changed during the analysis' };
	}
	if(result.removedRanges.length === 0) {
		void vscode.window.showInformationMessage(`flowR: Nothing to remove for ${what}, ${result.problem ?? 'unknown reason'}.`);
		return result;
	}
	editor.setDecorations(removalDecoration, result.removedLines.map(l => editor.document.lineAt(l).range));
	editor.setDecorations(partialRemovalDecoration, result.removedRanges.filter(r => r.start.character !== 0 || r.end.character !== 0));
	marked = editor.document;
	const uri = makeUri('removal-slice', `Without ${what.replace(/[/\\]/g, '_')}.R`);
	getReconstructionContentProvider().updateContents(uri, result.code);
	// the whole script without the removed statements next to the original, which marks what goes
	await showUri(uri);
	return result;
}

/** registers the removal slice for the cursor position, for a dependency, and the internal command for tests */
export function registerRemovalSlice(context: vscode.ExtensionContext) {
	const atCursor = async(editor: vscode.TextEditor) => {
		const { criteria, problem } = await resolveSlicingCriteria(editor.selections.map(s => s.active), editor.document, await getFlowrSession());
		return { criteria, problem };
	};

	// the marks describe the analyzed version, an edit makes them stale
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
		if(e.document === marked && e.contentChanges.length > 0) {
			clearRemovalSlice();
		}
	}));

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
		// the node ids belong to the analyzed document, which a click on an entry of a sourced script is no longer
		const document = dependencyViewDocument();
		// a group (e.g. a dataset) removes all its entries
		const ids = dependency.getNodeIds();
		if(!document || ids.length === 0) {
			return undefined;
		}
		if(dependency.target && dependency.target.uri.toString() !== document.uri.toString()) {
			void vscode.window.showInformationMessage(`flowR: ${dependency.target.uri.path.split('/').at(-1) ?? 'The script'} is sourced, open it to remove code from it.`);
			return undefined;
		}
		const editor = vscode.window.visibleTextEditors.find(e => e.document === document) ?? await vscode.window.showTextDocument(document);
		return await showRemovalSlice(editor, ids.map(id => `$${id}`) as SlicingCriteria, typeof dependency.label === 'string' ? `"${dependency.label}"` : 'the dependency');
	});

	registerCommand(context, 'vscode-flowr.internal.removalSlice', async(position: vscode.Position): Promise<RemovalSlice | undefined> => {
		const editor = vscode.window.activeTextEditor;
		if(!editor) {
			return undefined;
		}
		const { criteria, problem } = await resolveSlicingCriteria([position], editor.document, await getFlowrSession());
		return problem ? { removedLines: [], removedRanges: [], code: editor.document.getText(), problem } : await computeRemovalSlice(editor.document, criteria);
	});
}
