import * as vscode from 'vscode';
import { SourceRange } from '@eagleoutice/flowr/util/range';
import type { SliceCombination, SliceDisplay } from './settings';
import { getConfig, isVerbose, Settings } from './settings';
import { getSelectionSlicer, showSelectionSliceInEditor } from './selection-slicer';
import { disposeActivePositionSlicer, getActivePositionSlicer, addCurrentPositions, positionSlicers } from './position-slicer';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { getReconstructionContentProvider, makeUri, resetClosedReconstructions, shouldAutoReconstruct, trackClosedReconstructions, wasClosedByUser } from './doc-provider';
import type { Dependency } from './flowr/views/dependency-view';
import { getCriteriaSlicer } from './criteria-slicer';
import { rangeToVscodeRange } from './flowr/utils';
import { registerCommand } from './extension';
import { SliceDirection } from '@eagleoutice/flowr/util/slice-direction';

/** registers the slice commands (cursor, selection, dependency, clear, and position slicing) */
export function registerSliceCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	registerCommand(context, 'vscode-flowr.slice.cursor', async() => {
		return await getSelectionSlicer().sliceSelectionOnce(SliceDirection.Backward);
	});
	registerCommand(context, 'vscode-flowr.forward-slice.cursor', async() => {
		return await getSelectionSlicer().sliceSelectionOnce(SliceDirection.Forward);
	});
	registerCommand(context, 'vscode-flowr.internal.slice.dependency', (dependency: Dependency) => {
		showDependencySlice(output, dependency, SliceDirection.Backward);
	});
	registerCommand(context, 'vscode-flowr.internal.forward-slice.dependency', (dependency: Dependency) => {
		showDependencySlice(output, dependency, SliceDirection.Forward);
	});
	registerCommand(context, 'vscode-flowr.slice.clear', async() => {
		resetClosedReconstructions();
		await unfoldSlice();
		clearSliceOutput();
	});
	registerCommand(context, 'vscode-flowr.slice.toggleNegative', async() => {
		const negative = !getConfig().get<boolean>(Settings.SliceNegative, false);
		await getConfig().update(Settings.SliceNegative, negative, vscode.ConfigurationTarget.Global);
		vscode.window.setStatusBarMessage(`flowR: negative slice ${negative ? 'on' : 'off'}`, 3000);
	});
	registerCommand(context, 'vscode-flowr.slice.fold', async() => {
		await foldSlice();
	});
	registerCommand(context, 'vscode-flowr.slice.follow.cursor', async() => {
		await getSelectionSlicer().toggleFollowSelection(SliceDirection.Backward);
	});
	registerCommand(context, 'vscode-flowr.forward-slice.follow.cursor', async() => {
		await getSelectionSlicer().toggleFollowSelection(SliceDirection.Forward);
	});

	registerCommand(context, 'vscode-flowr.slice.show.in.editor', async() => {
		resetClosedReconstructions();
		return await showReconstructionInEditor();
	});

	registerCommand(context, 'vscode-flowr.slice.position.toggleCombination', async() => {
		const combination: SliceCombination = getConfig().get<SliceCombination>(Settings.SlicePositionCombination, 'union') === 'union' ? 'intersection' : 'union';
		await getConfig().update(Settings.SlicePositionCombination, combination, vscode.ConfigurationTarget.Global);
		vscode.window.setStatusBarMessage(`flowR: position slices combined as ${combination}`, 3000);
	});
	registerCommand(context, 'vscode-flowr.slice.position', async() => {
		return await addCurrentPositions(SliceDirection.Backward);
	});
	registerCommand(context, 'vscode-flowr.forward-slice.position', async() => {
		return await addCurrentPositions(SliceDirection.Forward);
	});

	context.subscriptions.push(trackClosedReconstructions());
	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(Settings.Category)) {
			const selSlicer = getSelectionSlicer();
			selSlicer.clearSliceDecos();
			for(const [, positionSlicer] of positionSlicers) {
				void positionSlicer.updateOutput(true);
			}
		}
	});
}

async function showReconstructionInEditor(): Promise<vscode.TextEditor | undefined> {
	const positionSlicer = getActivePositionSlicer();
	if(positionSlicer) {
		return await positionSlicer.showReconstruction();
	}
	return await showSelectionSliceInEditor(SliceDirection.Backward);
}

function clearSliceOutput(): void {
	const editor = vscode.window.activeTextEditor;
	if(!editor) {
		return;
	}
	const clearedPositionSlicer = disposeActivePositionSlicer();
	if(clearedPositionSlicer) {
		return;
	}
	const slicer = getSelectionSlicer();
	slicer.clearSelectionSlice();
	const criteriaSlicer = getCriteriaSlicer();
	criteriaSlicer.hasDoc = false;
	criteriaSlicer.clearSliceDecos();
}

function showDependencySlice(output: vscode.OutputChannel, dependency: Dependency, direction: SliceDirection) {
	const nodeId = dependency.getNodeId();
	const loc = dependency.getLocation();
	if(!nodeId) {
		return;
	}
	/* hide any other active slicer in the given document to avoid fighting */
	clearSliceOutput();
	// got to position
	const editor = vscode.window.activeTextEditor;
	const slicer = getCriteriaSlicer();
	/* always with reconstruction */
	if(isVerbose()) {
		output.appendLine(`[Dependency View] Slicing for id ${nodeId} (at: ${SourceRange.format(loc)})`);
	}
	// we use loc slicer for uses with `::` etc.
	const info = dependency.getAnalysisInfo();
	setTimeout(() => {
		void (async() => {
			await slicer.sliceFor([`$${nodeId}`], direction, info ? { ...info, id: nodeId } : undefined);
			if(direction === SliceDirection.Backward && shouldAutoReconstruct(slicer.makeUri())) {
				setTimeout(() => {
					void slicer.showReconstruction();
				}, 20);
			}
			if(editor && loc) {
				setTimeout(() => {
					editor.revealRange(rangeToVscodeRange(loc), vscode.TextEditorRevealType.InCenter);
				}, 50);
			}
		})();
	}, 1);
}

/** decorates `editor` to highlight the slice elements according to the configured display style */
export function displaySlice(editor: vscode.TextEditor, sliceElements: { id: NodeId, location: SourceRange }[], decos: DecoTypes) {
	const sliceLines = new Set<number>(sliceElements.map(s => s.location[0] - 1));
	const negative = isNegative();
	const allLines = Array.from({ length: editor.document.lineCount }, (_, i) => i);
	lastSlice = { editor, dimmedLines: allLines.filter(i => sliceLines.has(i) === negative) };
	const lineRanges = (lines: number[]) => lines.map(i => new vscode.Range(i, 0, i, editor.document.lineAt(i).text.length));
	switch(getConfig().get<SliceDisplay>(Settings.StyleSliceDisplay)) {
		case 'tokens': {
			editor.setDecorations(decos.tokenSlice, negative ? lineRanges(allLines.filter(i => !sliceLines.has(i))) : sliceElements.map(el => rangeToVscodeRange(el.location)));
			break;
		}
		case 'text': {
			if(sliceLines.size === 0) {
				return; // do not grey out the entire document
			}
			editor.setDecorations(decos.lineSlice, lineRanges(lastSlice.dimmedLines).map(range => ({ range })));
			break;
		}
		case 'diff': {
			const sliceContent = lastSlice.dimmedLines.map(i => editor.document.lineAt(i).text);

			const uri = makeUri('slice-diff-view', 'Slice Diff View');
			getReconstructionContentProvider().updateContents(uri, sliceContent.join('\n'));
			// only ever open one diff view to avoid "stuttering" between multiple or between the reconstruct
			if(!wasClosedByUser(uri) && !vscode.workspace.textDocuments.some(e => e.uri.authority === uri.authority)) {
				void vscode.commands.executeCommand('vscode.diff', uri, editor.document.uri, 'Slice Diff View',
					{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
			}
			break;
		}
	}
}

let lastSlice: { editor: vscode.TextEditor, dimmedLines: number[] } | undefined;
let folded: { editor: vscode.TextEditor, ranges: vscode.Range[] } | undefined;

function isNegative(): boolean {
	return getConfig().get<boolean>(Settings.SliceNegative, false);
}

/**
 * The text shown in the reconstruction: the sliced `code`, or in negative mode the lines of `doc` without any slice element.
 */
export function sliceReconstruction(code: string, doc: vscode.TextDocument, sliceElements: { location: SourceRange }[]): string {
	if(!isNegative() || sliceElements.length === 0) {
		return code;
	}
	const sliceLines = new Set(sliceElements.map(s => s.location[0] - 1));
	return Array.from({ length: doc.lineCount }, (_, i) => i).filter(i => !sliceLines.has(i)).map(i => doc.lineAt(i).text).join('\n');
}

async function withManualFolds(editor: vscode.TextEditor, ranges: vscode.Range[], command: string): Promise<void> {
	const selections = editor.selections;
	await vscode.window.showTextDocument(editor.document, editor.viewColumn);
	for(const range of ranges) {
		editor.selection = new vscode.Selection(range.start, range.end);
		await vscode.commands.executeCommand(command);
	}
	editor.selections = selections;
}

async function unfoldSlice(): Promise<void> {
	if(folded) {
		const { editor, ranges } = folded;
		folded = undefined;
		await withManualFolds(editor, ranges, 'editor.removeManualFoldingRanges');
	}
}

async function foldSlice(): Promise<void> {
	if(!lastSlice || lastSlice.dimmedLines.length === 0) {
		return;
	}
	await unfoldSlice();
	const { editor, dimmedLines } = lastSlice;
	const ranges: vscode.Range[] = [];
	for(const line of dimmedLines) {
		const prev = ranges.at(-1);
		if(prev && prev.end.line === line - 1) {
			ranges[ranges.length - 1] = new vscode.Range(prev.start, new vscode.Position(line, editor.document.lineAt(line).text.length));
		} else {
			ranges.push(new vscode.Range(line, 0, line, editor.document.lineAt(line).text.length));
		}
	}
	const multiLine = ranges.filter(r => r.end.line > r.start.line);
	await withManualFolds(editor, multiLine, 'editor.createFoldingRangeFromSelection');
	folded = { editor, ranges: multiLine };
}

export interface DecoTypes {
	lineSlice:  vscode.TextEditorDecorationType
	tokenSlice: vscode.TextEditorDecorationType
	slicedPos:  vscode.TextEditorDecorationType
	dispose(): void
}
/** creates the editor decoration types used to render slices from the current style settings */
export function makeSliceDecorationTypes(): DecoTypes {
	const config = getConfig();
	const tokenColor = config.get<string>(Settings.StyleTokenBackground, 'green');
	const ret: DecoTypes = {
		lineSlice: vscode.window.createTextEditorDecorationType({
			opacity: config.get<number>(Settings.StyleSliceOpacity)?.toString()
		}),
		tokenSlice: vscode.window.createTextEditorDecorationType({
			backgroundColor: `${tokenColor}`,
		}),
		slicedPos: vscode.window.createTextEditorDecorationType({
			before: {
				contentText:     '\u2192',
				backgroundColor: `${tokenColor}`,
				border:          `2px solid ${tokenColor}`,
			},
			border: `2px solid ${tokenColor}`,
		}),
		dispose() {
			this.lineSlice.dispose();
			this.tokenSlice.dispose();
			this.slicedPos.dispose();
		}
	};
	return ret;
}
