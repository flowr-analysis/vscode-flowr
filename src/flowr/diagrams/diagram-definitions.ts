import type { CfgSimplificationPassName } from '@eagleoutice/flowr/control-flow/cfg-simplification';
import { CfgSimplificationPasses } from '@eagleoutice/flowr/control-flow/cfg-simplification';
import { DiagramSettingsKeys } from '../../settings';
import type * as vscode from 'vscode';
import { getFlowrSession } from '../../extension';

export enum FlowrDiagramType {
    Dataflow = 'flowr-dataflow',
    Controlflow = 'flowr-cfg',
    Ast = 'flowr-ast',
    CallGraph = 'flowr-call-graph',
};

export interface DiagramDefinition<Options extends DiagramOptions> {
    /** The title displayed on the tab of the panel */
    title:            string;
    /** The generated options at the bottom of the diagram panel */
    options:          Options;
    /** The url to open when clicking the Documentation button in the header */
    documentationUrl: string;
    /** The command used to open the panel by the user */
    command:          string;
    /** Retrieves the mermaid diagram as a string */
    retrieve:         (options: Options, editor: vscode.TextEditor) => Promise<string>;
}

export type DiagramSelectionMode = 'highlight' | 'hide';

export interface DiagramOptionsBase<T> {
    type:         string
    key:          DiagramSettingsKeys
    default:      T
    currentValue: T 
}

export interface DiagramOptionsCheckbox<T = string> extends DiagramOptionsBase<boolean> {
    type:        'checkbox'
    displayText: string
    /** If set, it will be used to set the value in a set references by @see key in vscode's settings.json */
    keyInSet:    T | undefined
};

export interface DiagramOptionsDropdown<T = string> extends DiagramOptionsBase<T> {
    type:   'dropdown'
    values: {
        value:       T
        displayText: string
    }[]
};

export type DiagramOption = DiagramOptionsCheckbox | DiagramOptionsDropdown;

export type DiagramOptions = Record<string, DiagramOption>; 

export const DefaultDiagramOptions = {
	mode: {
		type:   'dropdown',
		key:    DiagramSettingsKeys.Mode,
		values: [
			{ value: 'highlight', displayText: 'Highlight selection' },
			{ value: 'hide',      displayText: 'Only show selection' }
		],
		default:      'hide',
		currentValue: 'hide'
	} as DiagramOptionsDropdown<DiagramSelectionMode>,
	sync: {
		type:         'checkbox',
		key:          DiagramSettingsKeys.Sync,
		displayText:  'Sync with selection',
		default:      true,
		currentValue: true,
	} as DiagramOptionsCheckbox,
} satisfies DiagramOptions;

export const DFGDiagramOptions = {
	// Default options for mode and sync
	...DefaultDiagramOptions,
	simplifyDfg: {
		type:         'checkbox',
		key:          DiagramSettingsKeys.SimplifyDfg,
		displayText:  'Simplify',
		default:      true,
		currentValue: true
	} as DiagramOptionsCheckbox,
} satisfies DiagramOptions; 

export const CFGDiagramOptions = {
	// Default options for mode and sync
	...DefaultDiagramOptions,
	simplifyCfg: {
		type:         'checkbox',
		key:          DiagramSettingsKeys.SimplifyCfg,
		displayText:  'Simplify',
		default:      true,
		currentValue: true
	} as DiagramOptionsCheckbox,
	// Checkboxes for each simplification pass
	...(Object.fromEntries(Object.keys(CfgSimplificationPasses).map(v => [v, {
		type:         'checkbox',
		key:          DiagramSettingsKeys.SimplificationPasses,
		displayText:  v,
		default:      true,
		currentValue: true,
		keyInSet:     v
	}])) as { [K in CfgSimplificationPassName]: DiagramOptionsCheckbox<CfgSimplificationPassName> } )
} satisfies DiagramOptions;

export const DiagramDefinitions = {
	'flowr-dataflow': {
		title:            'Dataflow Graph',
		options:          DFGDiagramOptions,
		documentationUrl: 'https://github.com/flowr-analysis/flowr/wiki/Dataflow-Graph',
		command:          'vscode-flowr.dataflow',
		retrieve:         async(options, editor) => {
			const session = await getFlowrSession();
			return await session.retrieveDataflowMermaid(editor.document, editor.selections, options.mode.currentValue, options.simplifyDfg.currentValue);
		}
	} satisfies DiagramDefinition<typeof DFGDiagramOptions>,
	'flowr-cfg': {
		title:            'Control Flow Graph',
		options:          CFGDiagramOptions,
		documentationUrl: 'https://github.com/flowr-analysis/flowr/wiki/Control-Flow-Graph',
		command:          'vscode-flowr.cfg',
		retrieve:         async(options, editor) => {
			const session = await getFlowrSession();
			return await session.retrieveCfgMermaid(editor.document, editor.selections, options.mode.currentValue, options.simplifyCfg.currentValue, simplificationPassesFromOptions(options));
		}
	} satisfies DiagramDefinition<typeof CFGDiagramOptions>,
	'flowr-ast': {
		title:            'AST',
		options:          DefaultDiagramOptions,
		documentationUrl: 'https://github.com/flowr-analysis/flowr/wiki/Normalized-AST',
		command:          'vscode-flowr.ast',
		retrieve:         async(options, editor) => {
			const session = await getFlowrSession();
			return await session.retrieveAstMermaid(editor.document, editor.selections, options.mode.currentValue);
		}
	} satisfies DiagramDefinition<typeof DefaultDiagramOptions>,
	'flowr-call-graph': {
		title:            'Call Graph',
		options:          DefaultDiagramOptions,
		documentationUrl: 'https://github.com/flowr-analysis/flowr/wiki/Dataflow-Graph#perspectives-cg',
		command:          'vscode-flowr.call-graph',
		retrieve:         async(options, editor) => {
			const session = await getFlowrSession();
			return await session.retrieveCallgraphMermaid(editor.document, editor.selections, options.mode.currentValue);
		}
	} satisfies DiagramDefinition<typeof DefaultDiagramOptions>
} as const satisfies Record<FlowrDiagramType, unknown>;

function simplificationPassesFromOptions(options: DiagramOptions): CfgSimplificationPassName[] {	
	const passes: CfgSimplificationPassName[] = [];
	for(const pass of Object.keys(CfgSimplificationPasses) as CfgSimplificationPassName[]) {
		if(pass in options && options[pass as keyof DiagramOptions].currentValue) {
			passes.push(pass);
		}
	}
	return passes;
}
