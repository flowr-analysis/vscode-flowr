
// Contains the class and some functions that are used to
// slice at the current cursor position
// (either per command or updating as the cursor moves)

import * as vscode from 'vscode';
import { getConfig, getFlowrSession } from './extension';
import { makeUri, getReconstructionContentProvider, showUri } from './doc-provider';
import type { SliceReturn } from './flowr/utils';
import type { DecoTypes } from './slice';
import { displaySlice, makeSliceDecorationTypes } from './slice';
import { positionSlicers } from './position-slicer';
import { Settings } from './settings';
import type { SlicingCriteria } from '@eagleoutice/flowr/slicing/criterion/parse';


const criteriaSlicerAuthority = 'criteria-slicer';
const criteriaSlicerPath = 'Dependency Slice';


// currently only one instance is used and never disposed
let criteriaSlicer: CriteriaSlicer | undefined;
export function getCriteriaSlicer(): CriteriaSlicer {
	criteriaSlicer ??= new CriteriaSlicer();
	return criteriaSlicer;
}

class CriteriaSlicer {
	hasDoc: boolean = false;

	decos: DecoTypes | undefined;

	decoratedEditors: vscode.TextEditor[] = [];

	// Slice once at the current cursor position
	async sliceFor(criteria: SlicingCriteria): Promise<string> {
		return await this.update(criteria);
	}

	makeUri(): vscode.Uri {
		return makeUri(criteriaSlicerAuthority, criteriaSlicerPath);
	}
	
	async showReconstruction(): Promise<vscode.TextEditor | undefined> {
		const uri = this.makeUri();
		return showUri(uri);
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

	protected async update(criteria: SlicingCriteria): Promise<string> {
		const ret = await getSliceFor(criteria);
		if(ret === undefined){
			return '';
		}
		const provider = getReconstructionContentProvider();
		const uri = this.makeUri();
		provider.updateContents(uri, ret.code);
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
		this.decos ??= makeSliceDecorationTypes();
		displaySlice(ret.editor, ret.sliceElements, this.decos);
		this.decoratedEditors.push(ret.editor);
		return ret.code;
	}
}


interface CriteriaSliceReturn extends SliceReturn {
	editor: vscode.TextEditor
}
async function getSliceFor(criteria: SlicingCriteria): Promise<CriteriaSliceReturn | undefined> {
	const editor = vscode.window.activeTextEditor;
	if(!editor){
		return;
	}
	const flowrSession = await getFlowrSession();
	if(!flowrSession){
		return;
	}
	const ret = await flowrSession.retrieveSlice(criteria, editor.document, false);
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