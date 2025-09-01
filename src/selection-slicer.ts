
// Contains the class and some functions that are used to
// slice at the current cursor position
// (either per command or updating as the cursor moves)

import * as vscode from 'vscode';
import { getConfig, getFlowrSession, isVerbose, updateStatusBar } from './extension';
import { flowrScheme, makeUri, getReconstructionContentProvider, showUri } from './doc-provider';
import { makeSlicingCriteria, type SliceReturn } from './flowr/utils';
import type { DecoTypes } from './slice';
import { displaySlice, makeSliceDecorationTypes } from './slice';
import { positionSlicers } from './position-slicer';
import { Settings } from './settings';
import { getCriteriaSlicer } from './criteria-slicer';
import { SliceDirection } from '@eagleoutice/flowr/core/steps/all/static-slicing/00-slice';


const selectionSlicerAuthority = 'selection-slicer';
const selectionSlicerPath = 'Selection Slice';


// Get the active SelectionSlicer instance
// currently only one instance is used and never disposed
export let selectionSlicer: SelectionSlicer | undefined;
export function getSelectionSlicer(): SelectionSlicer {
	selectionSlicer ??= new SelectionSlicer();
	return selectionSlicer;
}

// Show the selection slice in an editor
// If nothing is sliced, slice at the current cursor position
export async function showSelectionSliceInEditor(direction: SliceDirection): Promise<vscode.TextEditor> {
	const slicer = getSelectionSlicer();
	if(!slicer.hasDoc){
		await slicer.sliceSelectionOnce(direction);
	}
	const uri = slicer.makeUri();
	return await showUri(uri);
}


class SelectionSlicer {
	changeListeners:  vscode.Disposable[] = [];
	hasDoc:           boolean = false;
	decos:            DecoTypes | undefined;
	decoratedEditors: vscode.TextEditor[] = [];

	// Turn on/off following of the cursor
	async startFollowSelection(direction: SliceDirection): Promise<void> {
		await this.update(direction);
		this.changeListeners.push(
			vscode.window.onDidChangeTextEditorSelection(e => {
				if(this.decoratedEditors.includes(e.textEditor)) {
					void this.update(direction);
				}
			}),
			vscode.window.onDidChangeActiveTextEditor(() => void this.update(direction))
		);
		updateStatusBar();
	}
	async toggleFollowSelection(direction: SliceDirection): Promise<void> {
		if(this.changeListeners.length){
			this.stopFollowSelection();
		} else {
			await this.startFollowSelection(direction);
		}
	}
	stopFollowSelection(): void {
		while(this.changeListeners.length){
			this.changeListeners.pop()?.dispose();
		}
		updateStatusBar();
	}

	// Slice once at the current cursor position
	async sliceSelectionOnce(direction: SliceDirection): Promise<string> {
		return await this.update(direction);
	}

	// Stop following the cursor and clear the selection slice output
	clearSelectionSlice(): void {
		this.stopFollowSelection();
		const provider = getReconstructionContentProvider();
		const uri = this.makeUri();
		provider.updateContents(uri, '');
		this.clearSliceDecos();
		this.hasDoc = false;
	}

	makeUri(): vscode.Uri {
		return makeUri(selectionSlicerAuthority, selectionSlicerPath);
	}

	// Clear all slice decos or only the ones affecting a specific editor/document
	clearSliceDecos(editor?: vscode.TextEditor, doc?: vscode.TextDocument): void {
		if(!this.decos){
			return;
		}
		if(editor){
			editor.setDecorations(this.decos.lineSlice, []);
			editor.setDecorations(this.decos.tokenSlice, []);
			if(!doc){
				return;
			}
		}
		if(doc){
			for(const editor of vscode.window.visibleTextEditors){
				if(editor.document === doc){
					this.clearSliceDecos(editor);
				}
			}
			return;
		}
		this.decos?.dispose();
		this.decos = undefined;
	}

	protected async update(direction: SliceDirection): Promise<string> {
		const ret = await getSelectionSlice(direction);
		if(ret === undefined){
			return '';
		}
		getCriteriaSlicer().clearSliceDecos();
		const provider = getReconstructionContentProvider();
		const uri = this.makeUri();
		provider.updateContents(uri, direction === SliceDirection.Backward ? ret.code : '');
		this.hasDoc = true;
		const clearOtherDecos = getConfig().get<boolean>(Settings.StyleOnlyHighlightActiveSelection, false);
		for(const editor of this.decoratedEditors){
			if(editor === ret.editor){
				continue;
			}
			if(clearOtherDecos || positionSlicers.has(editor.document)){
				this.clearSliceDecos(editor);
			}
		}
		this.decos ||= makeSliceDecorationTypes();
		displaySlice(ret.editor, ret.sliceElements, this.decos);
		this.decoratedEditors.push(ret.editor);
		if(direction === SliceDirection.Backward && getConfig().get<boolean>(Settings.SliceAutomaticReconstruct)){
			void showSelectionSliceInEditor(direction);
		}
		return ret.code;
	}
}


// Get the slice at the current cursor position,
// checking that the document/selection is an R file that is not already tracked
interface SelectionSliceReturn extends SliceReturn {
	editor: vscode.TextEditor
}
async function getSelectionSlice(direction: SliceDirection): Promise<SelectionSliceReturn | undefined> {
	const editor = vscode.window.activeTextEditor;
	if(!editor){
		return undefined;
	}
	if(editor.document.uri.scheme === flowrScheme){
		return undefined;
	}
	if(editor.document.languageId.toLowerCase() !== 'r'){
		return undefined;
	}
	if(positionSlicers.has(editor.document)){
		return undefined;
	}
	const positions = editor.selections.map(sel => sel.active);
	if(!positions.length){
		// (should not happen)
		return undefined;
	}
	const flowrSession = await getFlowrSession();
	const ret = await flowrSession.retrieveSlice(makeSlicingCriteria(positions, editor.document, isVerbose()), direction, editor.document, false);
	if(!ret.sliceElements.length){
		return {
			code:          '# No slice',
			sliceElements: [],
			editor:        editor
		};
	}
	return {
		...ret,
		editor
	};
}
