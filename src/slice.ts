import * as vscode from 'vscode';
import type { SourceRange } from '@eagleoutice/flowr/util/range';
import { getConfig, isVerbose } from './extension';
import type { SliceDisplay } from './settings';
import { Settings } from './settings';
import { getSelectionSlicer, showSelectionSliceInEditor } from './selection-slicer';
import { disposeActivePositionSlicer, getActivePositionSlicer, addCurrentPositions, positionSlicers } from './position-slicer';
import type { NodeId } from '@eagleoutice/flowr/r-bridge/lang-4.x/ast/model/processing/node-id';
import { getReconstructionContentProvider, makeUri } from './doc-provider';
import type { Dependency } from './flowr/views/dependency-view';
import { getCriteriaSlicer } from './criteria-slicer';
import { makeSlicingCriteria } from './flowr/utils';

export function registerSliceCommands(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.cursor', async() => {
		return await getSelectionSlicer().sliceSelectionOnce();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.internal.slice.dependency', async(dependency: Dependency) => {
		const node = dependency.getNodeId();
		const loc = dependency.getLocation();
		if(node) {
			// got to position
			const editor = vscode.window.activeTextEditor;
			const slicer = getCriteriaSlicer();
			/* always with reconstruction */
			output.appendLine(`Slicing for ${node}`);
			// we use loc slicer for uses with `::` etc.
			const slice = await slicer.sliceFor(loc && editor ? makeSlicingCriteria([new vscode.Position(loc[0] - 1, loc[1] - 1)], editor?.document, isVerbose()) : [`$${node}`]);
			setTimeout(() => {
				void slicer.showReconstruction();
			}, 20);
			if(editor && loc) {
				setTimeout(() => {
					editor.revealRange(new vscode.Range(loc[0] - 1, loc[1] - 1, loc[2] - 1, loc[3]), vscode.TextEditorRevealType.InCenter);
				}, 50);
			}
			return slice;
		}
	}));
	// maybe find a place for this
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.internal.goto.dependency', (dependency: Dependency) => {
		const node = dependency.getNodeId();
		const loc = dependency.getLocation();
		if(node) {
			// got to position
			const editor = vscode.window.activeTextEditor;
			if(editor && loc) {
				setTimeout(() => {
					editor.revealRange(new vscode.Range(loc[0] - 1, loc[1] - 1, loc[2] - 1, loc[3]), vscode.TextEditorRevealType.InCenter);
				}, 50);
			}
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.clear', () => {
		clearSliceOutput();
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.follow.cursor', async() => {
		await getSelectionSlicer().toggleFollowSelection();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.show.in.editor', async() => {
		return await showReconstructionInEditor();
	}));

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.slice.position', async() => {
		await addCurrentPositions();
	}));

	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(`${Settings.Category}`)) {
			const selSlicer = getSelectionSlicer();
			selSlicer.clearSliceDecos();
			for(const [, positionSlicer] of positionSlicers){
				void positionSlicer.updateOutput(true);
			}
		}
	});
}

async function showReconstructionInEditor(): Promise<vscode.TextEditor | undefined> {
	const positionSlicer = getActivePositionSlicer();
	if(positionSlicer){
		return await positionSlicer.showReconstruction();
	}
	return await showSelectionSliceInEditor();
}

function clearSliceOutput(): void {
	const editor = vscode.window.activeTextEditor;
	if(!editor){
		return;
	}
	const clearedPositionSlicer = disposeActivePositionSlicer();
	if(clearedPositionSlicer){
		return;
	}
	const slicer = getSelectionSlicer();
	slicer.clearSelectionSlice();
	const criteriaSlicer = getCriteriaSlicer();
	criteriaSlicer.hasDoc = false;
	criteriaSlicer.clearSliceDecos();
}

export function displaySlice(editor: vscode.TextEditor, sliceElements: { id: NodeId, location: SourceRange }[], decos: DecoTypes) {
	const sliceLines = new Set<number>(sliceElements.map(s => s.location[0] - 1));
	switch(getConfig().get<SliceDisplay>(Settings.StyleSliceDisplay)) {
		case 'tokens': {
			const ranges = [];
			for(const el of sliceElements){
				const range = new vscode.Range(el.location[0] - 1, el.location[1] - 1, el.location[2] - 1, el.location[3]);
				ranges.push(range);
			}
			editor.setDecorations(decos.tokenSlice, ranges);
			break;
		}
		case 'text': {
			if(sliceLines.size === 0){
				return; // do not grey out the entire document
			}
			const decorations: vscode.DecorationOptions[] = [];
			for(let i = 0; i < editor.document.lineCount; i++) {
				if(!sliceLines.has(i)) {
					decorations.push({ range: new vscode.Range(i, 0, i, editor.document.lineAt(i).text.length) });
				}
			}
			editor.setDecorations(decos.lineSlice, decorations);
			break;
		}
		case 'diff': {
			const sliceContent = [];
			for(let i = 0; i < editor.document.lineCount; i++){
				if(!sliceLines.has(i)){
					sliceContent.push(editor.document.lineAt(i).text);
				}
			}

			const uri = makeUri('slice-diff-view', 'Slice Diff View');
			getReconstructionContentProvider().updateContents(uri, sliceContent.join('\n'));
			void vscode.commands.executeCommand('vscode.diff', uri, editor.document.uri, 'Slice Diff View',
				{ viewColumn: vscode.ViewColumn.Beside, preserveFocus: true } as vscode.TextDocumentShowOptions);
			break;
		}
	}
}

export interface DecoTypes {
	lineSlice:  vscode.TextEditorDecorationType
	tokenSlice: vscode.TextEditorDecorationType
	slicedPos:  vscode.TextEditorDecorationType
	dispose(): void
}
export function makeSliceDecorationTypes(): DecoTypes {
	const config = getConfig();
	const tokenColor = config.get<string>('style.tokenBackgroundColor', 'green');
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
