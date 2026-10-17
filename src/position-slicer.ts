
// Contains the class and some functions that are used to track positions in a document
// and display their slices

import * as vscode from 'vscode';
import { updateStatusBar } from './extension';
import { makeUri, getReconstructionContentProvider, showUri, shouldAutoReconstruct } from './doc-provider';
import { getPositionAt, type SliceReturn } from './flowr/utils';
import type { DecoTypes } from './slice';
import { displaySlice, emptySliceCode, makeSliceDecorationTypes, reportEmptySlice, sliceAtPositions, sliceReconstruction } from './slice';
import { getSelectionSlicer } from './selection-slicer';
import type { SliceCombination } from './settings';
import { Settings, getConfig } from './settings';
import { SliceDirection } from '@eagleoutice/flowr/util/slice-direction';


const positionSlicerAuthority = 'doc-slicer';
const positionSlicerSuffix = 'Slice';

// A map of all active position slicers
// Slicers are removed when they have no more tracked positions
export const positionSlicers: Map<vscode.TextDocument, PositionSlicer> = new Map();


/** toggles a slice criterion at each current cursor position of the active editor, returning the document's slicer while it has positions */
export async function addCurrentPositions(direction: SliceDirection): Promise<PositionSlicer | undefined> {
	const editor = vscode.window.activeTextEditor;
	if(!editor) {
		return undefined;
	}
	const positions = editor.selections.map(sel => sel.start);
	return await addPositions(positions, direction, editor.document);
}


/** the position slicer of the active document, if any */
export function getActivePositionSlicer(): PositionSlicer | undefined {
	const editor = vscode.window.activeTextEditor;
	if(!editor) {
		return undefined;
	}
	const doc = editor.document;
	return positionSlicers.get(doc);
}
/** disposes the active document's position slicer; returns whether there was one */
export function disposeActivePositionSlicer(): boolean {
	const slicer = getActivePositionSlicer();
	if(!slicer) {
		return false;
	}
	slicer.dispose();
	positionSlicers.delete(slicer.doc);
	updateStatusBar();
	return true;
}


/** toggles the given positions as slice criteria in `doc` and updates the output */
export async function addPositions(positions: vscode.Position[], direction: SliceDirection, doc: vscode.TextDocument): Promise<PositionSlicer | undefined> {
	// Get or create a slicer for the document
	const flowrSlicer = positionSlicers.get(doc) || new PositionSlicer(doc);
	if(!positionSlicers.has(doc)) {
		positionSlicers.set(doc, flowrSlicer);
	}

	// Try to toggle the indicated positions
	const ret = flowrSlicer.togglePositions(positions, direction);
	if(ret) {
		// Update the output if any positions were toggled
		await flowrSlicer.updateOutput(false, true);
	}

	if(flowrSlicer.positions.length === 0) {
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

/** forward slices carry no code, as they do not ensure executability */
export type PositionSlice = Omit<SliceReturn, 'code'> & { code: string | undefined };

interface Position {
	readonly offset:    number;
	readonly direction: SliceDirection
}

export class PositionSlicer {
	listeners:    ((e: vscode.Uri) => unknown)[] = [];
	doc:          vscode.TextDocument;
	positions:    Position[] = [];
	sliceDecos:   DecoTypes | undefined = undefined;
	positionDeco: vscode.TextEditorDecorationType;
	disposables:  vscode.Disposable[] = [];

	constructor(doc: vscode.TextDocument) {
		this.doc = doc;

		this.positionDeco = makeSliceDecorationTypes().slicedPos;

		this.disposables.push(vscode.workspace.onDidChangeTextDocument(async(e) => {
			await this.onDocChange(e);
		}));
		this.disposables.push(vscode.window.onDidChangeVisibleTextEditors((editors) => {
			if(editors.some(e => e.document === this.doc)) {
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
		while(this.disposables.length > 0) {
			this.disposables.pop()?.dispose();
		}
		this.positions = [];
	}

	togglePositions(positions: vscode.Position[], direction: SliceDirection): boolean {
		// convert positions to offsets
		let offsets = positions.map(pos => this.normalizeOffset(pos));
		offsets = offsets.filter(i => i >= 0);

		// return early if no valid offsets
		if(offsets.length === 0) {
			return false;
		}

		// add offsets that are not yet tracked
		let onlyRemove = true;
		for(const offset of offsets) {
			const idx = this.positions.findIndex(p => p.offset === offset);
			if(idx < 0) {
				this.positions.push({ offset, direction });
				onlyRemove = false;
			}
		}

		// if all offsets are already tracked, toggle them off
		if(onlyRemove) {
			this.positions = this.positions.filter(p => !offsets.includes(p.offset));
		}

		return true;
	}

	async showReconstruction(): Promise<vscode.TextEditor> {
		const uri = this.makeUri();
		return showUri(uri);
	}

	async updateOutput(resetDecos: boolean = false, explicit: boolean = false): Promise<void> {
		if(resetDecos) {
			this.clearSliceDecos();
			this.positionDeco.dispose();
			this.positionDeco = makeSliceDecorationTypes().slicedPos;
		}
		this.updateTargetDecos();
		const generation = ++this.generation;
		const slice = await this.computeSlices();
		// a later edit started a newer update meanwhile, whose result must not be overwritten by this stale one
		if(generation !== this.generation) {
			return;
		}
		const code = this.showSlices(slice, explicit);
		const provider = getReconstructionContentProvider();
		const uri = this.makeUri();
		provider.updateContents(uri, code);
		if(code !== undefined && shouldAutoReconstruct(uri)) {
			void this.showReconstruction();
		}
		updateStatusBar();
	}

	makeUri(): vscode.Uri {
		const docPath = this.doc.uri.path + ` - ${positionSlicerSuffix}`;
		return makeUri(positionSlicerAuthority, docPath);
	}

	protected async onDocChange(e: vscode.TextDocumentChangeEvent): Promise<void> {
		// Check if there are changes to the tracked document, we do the version check to see if there are later edits to trigger on
		if(e.document !== this.doc || e.contentChanges.length === 0 || e.document.version < this.doc.version) {
			return;
		}

		// Compute new offsets after the changes
		const newPositions: Position[] = [];
		for(const position of this.positions) {
			let offset = position.offset;
			for(const cc of e.contentChanges) {
				offset = shiftOffset(offset, cc);
				if(offset < 0) {
					break;
				}
			}
			offset = this.normalizeOffset(offset);
			if(offset >= 0 && !newPositions.some(p => p.offset === offset)) {
				newPositions.push({ ...position, offset });
			}
		}
		this.positions = newPositions;

		// Update decos and editor output
		await this.updateOutput();
	}

	protected normalizeOffset(offsetOrPos: number | vscode.Position): number {
		// Convert a position to an offset and move it to the beginning of the word
		if(typeof offsetOrPos === 'number') {
			if(offsetOrPos < 0) {
				return -1;
			}
			offsetOrPos = this.doc.positionAt(offsetOrPos);
		}
		const range = getPositionAt(offsetOrPos, this.doc);
		if(!range) {
			return -1;
		}
		return this.doc.offsetAt(range.start);
	}

	protected updateTargetDecos(): void {
		// Update the decorations in the relevant editors
		const ranges = [];
		for(const position of this.positions) {
			const pos = this.doc.positionAt(position.offset);
			const range = getPositionAt(pos, this.doc);
			if(range) {
				ranges.push(range);
			}
		}
		for(const editor of vscode.window.visibleTextEditors) {
			if(editor.document === this.doc) {
				this.sliceDecos ||= makeSliceDecorationTypes();
				editor.setDecorations(this.positionDeco, ranges);
			}
		}
	}

	/** the slice currently shown, if any */
	lastSlice: PositionSlice | undefined;
	private showErrors = true;
	private generation = 0;

	protected async computeSlices(): Promise<PositionSlice | undefined> {
		if(this.positions.length === 0) {
			return undefined;
		}

		let code: string | undefined;
		let problem: string | undefined;
		let sliceElements: SliceReturn['sliceElements'] = [];
		const combine = getConfig().get<SliceCombination>(Settings.SlicePositionCombination, 'union');

		const positions = this.positions.map(p => ({ direction: p.direction, docPos: this.doc.positionAt(p.offset) }));
		const { backward, forward } = Object.groupBy(positions, p => p.direction.toString());
		if(backward && backward.length > 0) {
			const results = await sliceAtPositions(backward.map(p => p.docPos), this.doc, SliceDirection.Backward, this.showErrors, combine);
			problem = results.problem;
			code = results.code;
			sliceElements.push(...results.sliceElements);
		}
		if(forward && forward.length > 0) {
			const results = await sliceAtPositions(forward.map(p => p.docPos), this.doc, SliceDirection.Forward, this.showErrors, combine);
			problem ??= results.problem;
			if(combine === 'intersection' && backward && backward.length > 0) {
				const forwardIds = new Set(results.sliceElements.map(e => e.id));
				sliceElements = sliceElements.filter(e => forwardIds.has(e.id));
			} else {
				sliceElements.push(...results.sliceElements);
			}
			// we don't return code if we have at least one forward slice in our list, because forward slices don't ensure executability!
			code = undefined;
		}
		return { code, sliceElements, problem: sliceElements.length > 0 ? undefined : problem ?? 'the slices of the marked positions have no code in common' };
	}

	/** decorates the slice in all visible editors of the document and returns the reconstructed code, if any */
	protected showSlices(slice: PositionSlice | undefined, explicit: boolean): string | undefined {
		this.lastSlice = slice;
		if(!slice || slice.sliceElements.length === 0) {
			this.clearSliceDecos();
			if(slice && this.showErrors) {
				reportEmptySlice(slice.problem, explicit);
				setTimeout(() => this.setShowErrors(), getConfig().get<number>(Settings.ErrorMessageTimer));
				this.showErrors = false;
			}
			return slice?.code === undefined ? undefined : emptySliceCode(slice.problem);
		}

		for(const editor of vscode.window.visibleTextEditors) {
			if(editor.document === this.doc) {
				this.sliceDecos ||= makeSliceDecorationTypes();
				displaySlice(editor, slice.sliceElements, this.sliceDecos);
			}
		}
		return slice.code === undefined ? undefined : sliceReconstruction(slice.code, this.doc, slice.sliceElements);
	}

	protected clearSliceDecos(): void {
		this.sliceDecos?.dispose();
		this.sliceDecos = undefined;
	}
	private setShowErrors(): void {
		this.showErrors = true;
	}
}

function shiftOffset(offset: number, cc: vscode.TextDocumentContentChangeEvent): number {
	if(cc.rangeOffset > offset) {
		// pos is before range -> no change
		return offset;
	}
	if(cc.rangeLength + cc.rangeOffset > offset) {
		// pos is inside range -> invalidate pos
		return -1;
	}
	// pos is after range -> adjust pos
	const offsetDelta = cc.text.length - cc.rangeLength;
	const offset1 = offset + offsetDelta;
	return offset1;

}

