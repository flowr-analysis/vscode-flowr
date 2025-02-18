
// Contains the class and some functions that are used to track positions in a document
// and display their slices

import * as vscode from 'vscode';
import { getConfig, getFlowrSession, isVerbose, updateStatusBar } from './extension';
import { makeUri, getReconstructionContentProvider, showUri } from './doc-provider';
import { getPositionAt, makeSlicingCriteria } from './flowr/utils';
import type { DecoTypes } from './slice';
import { displaySlice, makeSliceDecorationTypes } from './slice';
import { getSelectionSlicer } from './selection-slicer';
import { Settings } from './settings';

const positionSlicerAuthority = 'doc-slicer';
const positionSlicerSuffix = 'Slice';

// A map of all active position slicers
// Slicers are removed when they have no more tracked positions
export const positionSlicers: Map<vscode.TextDocument, PositionSlicer> = new Map();


// Add the current cursor position(s) in the active editor to the list of slice criteria
export async function addCurrentPositions(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if(!editor){
		return;
	}
	const positions = editor.selections.map(sel => sel.start);
	await addPositions(positions, editor.document);
}


// Get the position slicer for the active doc, if any
export function getActivePositionSlicer(): PositionSlicer | undefined {
	const editor = vscode.window.activeTextEditor;
	if(!editor){
		return undefined;
	}
	const doc = editor.document;
	return positionSlicers.get(doc);
}
// If the active document has a position slicer, dispose it and return true, else false
export function disposeActivePositionSlicer(): boolean {
	const slicer = getActivePositionSlicer();
	if(!slicer){
		return false;
	}
	slicer.dispose();
	positionSlicers.delete(slicer.doc);
	updateStatusBar();
	return true;
}


// Add a list of positions in a document to the slice criteria
export async function addPositions(positions: vscode.Position[], doc: vscode.TextDocument): Promise<PositionSlicer | undefined> {
	// Get or create a slicer for the document
	const flowrSlicer = positionSlicers.get(doc) || new PositionSlicer(doc);
	if(!positionSlicers.has(doc)){
		positionSlicers.set(doc, flowrSlicer);
	}

	// Try to toggle the indicated positions
	const ret = flowrSlicer.togglePositions(positions);
	if(ret){
		// Update the output if any positions were toggled
		await flowrSlicer.updateOutput();
	}

	if(flowrSlicer.offsets.length === 0){
		// Dispose the slicer if no positions are sliced (anymore)
		flowrSlicer.dispose();
		positionSlicers.delete(doc);
		updateStatusBar();
		return undefined;
	} else {
		// If the slicer is active, make sure there are no selection-slice decorations in its editors
		getSelectionSlicer().clearSliceDecos(undefined, doc);
	}
	return flowrSlicer;
}

export class PositionSlicer {
	listeners: ((e: vscode.Uri) => unknown)[] = [];

	doc: vscode.TextDocument;

	offsets: number[] = [];

	sliceDecos: DecoTypes | undefined = undefined;

	positionDeco: vscode.TextEditorDecorationType;

	disposables: vscode.Disposable[] = [];

	constructor(doc: vscode.TextDocument){
		this.doc = doc;

		this.positionDeco = makeSliceDecorationTypes().slicedPos;

		this.disposables.push(vscode.workspace.onDidChangeTextDocument(async(e) => {
			await this.onDocChange(e);
		}));
		this.disposables.push(vscode.window.onDidChangeVisibleTextEditors((editors) => {
			if(editors.some(e => e.document === this.doc)){
				void this.updateOutput();
			}
		}));
	}

	dispose(): void {
		// Clear the content provider, decorations and tracked positions
		const provider = getReconstructionContentProvider();
		const uri = makeUri(positionSlicerAuthority, positionSlicerSuffix);
		provider.updateContents(uri, undefined);
		this.positionDeco?.dispose();
		this.sliceDecos?.dispose();
		while(this.disposables.length > 0){
			this.disposables.pop()?.dispose();
		}
		this.offsets = [];
	}

	togglePositions(positions: vscode.Position[]): boolean {
		// convert positions to offsets
		let offsets = positions.map(pos => this.normalizeOffset(pos));
		offsets = offsets.filter(i => i >= 0);

		// return early if no valid offsets
		if(offsets.length === 0){
			return false;
		}

		// add offsets that are not yet tracked
		let onlyRemove = true;
		for(const offset of offsets){
			const idx = this.offsets.indexOf(offset);
			if(idx < 0){
				this.offsets.push(offset);
				onlyRemove = false;
			}
		}

		// if all offsets are already tracked, toggle them off
		if(onlyRemove){
			this.offsets = this.offsets.filter(offset => !offsets.includes(offset));
		}

		return true;
	}

	async showReconstruction(): Promise<vscode.TextEditor> {
		const uri = this.makeUri();
		return showUri(uri);
	}

	async updateOutput(resetDecos: boolean = false): Promise<void> {
		if(resetDecos){
			this.clearSliceDecos();
			this.positionDeco.dispose();
			this.positionDeco = makeSliceDecorationTypes().slicedPos;
		}
		const provider = getReconstructionContentProvider();
		this.updateTargetDecos();
		const code = await this.updateSlices() ?? '# The slice is empty';
		const uri = this.makeUri();
		provider.updateContents(uri, code);
		if(getConfig().get<boolean>(Settings.SliceAutomaticReconstruct)){
			void this.showReconstruction();
		}
		updateStatusBar();
	}

	makeUri(): vscode.Uri {
		const docPath = this.doc.uri.path + ` - ${positionSlicerSuffix}`;
		return makeUri(positionSlicerAuthority, docPath);
	}

	protected async onDocChange(e: vscode.TextDocumentChangeEvent): Promise<void> {
		// Check if there are changes to the tracked document
		if(e.document !== this.doc) {
			return;
		}
		if(e.contentChanges.length == 0){
			return;
		}

		// Compute new offsets after the changes
		const newOffsets: number[] = [	];
		for(let offset of this.offsets) {
			for(const cc of e.contentChanges) {
				offset = shiftOffset(offset, cc);
				if(offset < 0){
					break;
				}
			}
			offset = this.normalizeOffset(offset);
			if(offset >= 0 && !newOffsets.includes(offset)){
				newOffsets.push(offset);
			}
		}
		this.offsets = newOffsets;

		// Update decos and editor output
		await this.updateOutput();
	}

	protected normalizeOffset(offsetOrPos: number | vscode.Position): number {
		// Convert a position to an offset and move it to the beginning of the word
		if(typeof offsetOrPos === 'number'){
			if(offsetOrPos < 0){
				return -1;
			}
			offsetOrPos = this.doc.positionAt(offsetOrPos);
		}
		const range = getPositionAt(offsetOrPos, this.doc);
		if(!range){
			return -1;
		}
		return this.doc.offsetAt(range.start);
	}

	protected updateTargetDecos(): void {
		// Update the decorations in the relevant editors
		const ranges = [];
		for(const offset of this.offsets){
			const pos = this.doc.positionAt(offset);
			const range = getPositionAt(pos, this.doc);
			if(range){
				ranges.push(range);
			}
		}
		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc){
				this.sliceDecos ||= makeSliceDecorationTypes();
				editor.setDecorations(this.positionDeco, ranges);
			}
		}
	}

	private showErrors = true;

	protected async updateSlices(): Promise<string | undefined> {
		// Update the decos that show the slice results
		const session = await getFlowrSession();
		const positions = this.offsets.map(offset => this.doc.positionAt(offset));
		if(positions.length === 0){
			this.clearSliceDecos();
			return;
		}
		const { code, sliceElements } = await session.retrieveSlice(makeSlicingCriteria(positions, this.doc, isVerbose()), this.doc, this.showErrors);

		if(sliceElements.length === 0){
			this.clearSliceDecos();
			if(this.showErrors){
				setTimeout(() => this.setShowErrors(), getConfig().get<number>(Settings.ErrorMessageTimer));
			}
			this.showErrors = false;
			return;
		}

		for(const editor of vscode.window.visibleTextEditors){
			if(editor.document === this.doc) {
				this.sliceDecos ||= makeSliceDecorationTypes();
				displaySlice(editor, sliceElements, this.sliceDecos);
			}
		}
		return code;
	}

	protected clearSliceDecos(): void {
		this.sliceDecos?.dispose();
		this.sliceDecos = undefined;
	}
	private setShowErrors(): void{
		this.showErrors = true;
	}
}

function shiftOffset(offset: number, cc: vscode.TextDocumentContentChangeEvent): number {
	if(cc.rangeOffset > offset){
		// pos is before range -> no change
		return offset;
	}
	if(cc.rangeLength + cc.rangeOffset > offset){
		// pos is inside range -> invalidate pos
		return -1;
	}
	// pos is after range -> adjust pos
	const offsetDelta = cc.text.length - cc.rangeLength;
	const offset1 = offset + offsetDelta;
	return offset1;

}

