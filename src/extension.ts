import * as vscode from 'vscode';
import { FlowrInternalSession } from './flowr/internal-session';
import { FlowrServerSession } from './flowr/server-session';
import { getConfig, Settings } from './settings';
import { registerSliceCommands } from './slice';
import { registerDiagramCommands } from './diagram';
import type { FlowrSession } from './flowr/utils';
import { selectionSlicer } from './selection-slicer';
import { positionSlicers } from './position-slicer';
import { flowrVersion } from '@eagleoutice/flowr/util/version';
import { registerDependencyInternalCommands, registerDependencyView } from './flowr/views/dependency-view';
import type { FlowrConfigOptions } from '@eagleoutice/flowr/config';
import { DropPathsOption, InferWorkingDirectory, VariableResolve , defaultConfigOptions } from '@eagleoutice/flowr/config';
import type { BuiltInDefinitions } from '@eagleoutice/flowr/dataflow/environments/built-in-config';
import { deepMergeObject } from '@eagleoutice/flowr/util/objects';
import { registerLintCommands } from './lint';
import { registerTelemetry } from './telemetry';

export const MINIMUM_R_MAJOR = 3;
export const BEST_R_MAJOR = 4;

let extensionContext: vscode.ExtensionContext;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let flowrSession: FlowrSession | undefined;

export async function activate(context: vscode.ExtensionContext) {
	extensionContext = context;
	outputChannel = vscode.window.createOutputChannel('flowR');
	outputChannel.appendLine(`flowR extension activated (ships with flowR v${flowrVersion().toString()}, web: ${isWeb()})`);

	registerDiagramCommands(context, outputChannel);
	registerSliceCommands(context, outputChannel);
	registerLintCommands(context, outputChannel);
	registerDependencyInternalCommands(context, outputChannel);
	registerTelemetry(context, outputChannel);

	updateFlowrConfig();
	vscode.workspace.onDidChangeConfiguration(updateFlowrConfig);

	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.internal', async() => {
		await establishInternalSession();
		return flowrSession;
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.connect', async() => {
		await establishServerSession();
		return flowrSession;
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.session.disconnect', () => {
		if(flowrSession instanceof FlowrServerSession) {
			destroySession();
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.repl', async() => {
		try {
			const repl = await import('./flowr/terminals/flowr-repl');
			repl.showRepl(context, await getFlowrSession());
		} catch(e){
			vscode.window.showErrorMessage('Failed to start flowR REPL');
			console.error(e);
		}
	}));
	context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.settings.open', async() => {
		await vscode.commands.executeCommand('workbench.action.openSettings', Settings.Category);
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand('vscode-flowr.feedback', () => {
			void vscode.window.showQuickPick(['Report a Bug', 'Provide Feedback'], { placeHolder: 'Report a bug or provide Feedback' }).then((result: string | undefined) => {
				if(result === 'Report a Bug') {
					const body = encodeURIComponent(`
<!-- Please describe your issue, suggestion or feature request in more detail below! -->



<!-- Automatically generated issue metadata, please do not edit or delete content below this line -->
---
flowR version: ${flowrVersion().toString()}  
Extension version: ${(extensionContext.extension.packageJSON as {version: string}).version} (${vscode.ExtensionMode[extensionContext.extensionMode]} mode)  
VS Code version: ${vscode.version} (web ${isWeb()})  
Session: ${flowrSession ? `${flowrSession instanceof FlowrServerSession ? 'server' : 'internal'} (${flowrSession instanceof FlowrServerSession ? flowrSession.state : (flowrSession as FlowrInternalSession)?.state})` : 'none'}  
OS: ${process.platform}  
Extension config:  
\`\`\`json
${JSON.stringify(getConfig(), null, 2)}
\`\`\`
						`.trim());
					const url = `https://github.com/flowr-analysis/vscode-flowr/issues/new?body=${body}`;
					void vscode.env.openExternal(vscode.Uri.parse(url));
				} else if(result === 'Provide Feedback') {
					const url = 'https://docs.google.com/forms/d/e/1FAIpQLScKFhgnh9LGVU7QzqLvFwZe1oiv_5jNhkIO-G-zND0ppqsMxQ/viewform?pli=1';
					vscode.env.openExternal(vscode.Uri.parse(url));
				}
			});
		}));

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(statusBarItem);
	updateStatusBar();

	context.subscriptions.push(new vscode.Disposable(() => destroySession()));

	setTimeout(() => {
		const { dispose: disposeDep, update: updateDependencyView } = registerDependencyView(outputChannel);
		context.subscriptions.push(vscode.commands.registerCommand('vscode-flowr.dependencyView.update', async() => {
			return await updateDependencyView();
		}));
		context.subscriptions.push(new vscode.Disposable(() => disposeDep()));
	}, 10);
	process.on('SIGINT', () => destroySession());

	if(getConfig().get<boolean>(Settings.ServerAutoConnect)) {
		await establishServerSession();
	}
}

export async function establishInternalSession() {
	destroySession();
	flowrSession = new FlowrInternalSession(outputChannel);
	await flowrSession.initialize();
	return flowrSession;
}
export async function getFlowrSession() {
	if(flowrSession) {
		return flowrSession;
	}
	// initialize a default session if none is active
	// on the web, we always want to use the tree-sitter backend since we can't run R
	return await establishInternalSession();
}

export async function establishServerSession() {
	destroySession();
	flowrSession = new FlowrServerSession(outputChannel);
	await flowrSession.initialize();
	return flowrSession;
}

export function destroySession() {
	flowrSession?.destroy();
	flowrSession = undefined;
}

export function updateStatusBar() {
	const text: string[] = [];
	const tooltip: string[] = [];

	if(flowrSession instanceof FlowrServerSession) {
		text.push(`$(cloud) flowR ${flowrSession.state}`);
		if(flowrSession.state === 'connected') {
			tooltip.push(`R version ${flowrSession.rVersion}  \nflowR version ${flowrSession.flowrVersion}`);
		}
		if(flowrSession.working){
			text.push('$(loading~spin) Analyzing');
		}
	} else if(flowrSession instanceof FlowrInternalSession) {
		text.push(`$(console) flowR ${flowrSession.state}`);
		if(flowrSession.state === 'active') {
			tooltip.push(`R version ${flowrSession.rVersion}  \nflowR version ${flowrVersion().toString()}  \nEngine ${flowrSession.parser?.name}`);
		}
		if(flowrSession.working){
			text.push('$(loading~spin) Analyzing');
		}
	}

	const slicingTypes: string[] = [];
	const slicingFiles: string[] = [];
	if(selectionSlicer?.changeListeners.length) {
		slicingTypes.push('cursor');
	}
	if(positionSlicers.size) {
		const pos = [...positionSlicers].reduce((i, [,s]) => i + s.positions.length, 0);
		if(pos > 0) {
			slicingTypes.push(`${pos} position${pos === 1 ? '' : 's'}`);
			for(const [doc,slicer] of positionSlicers) {
				slicingFiles.push(`${vscode.workspace.asRelativePath(doc.fileName)} (${slicer.positions.length} position${slicer.positions.length === 1 ? '' : 's'})`);
			}
		}
	}

	if(slicingTypes.length) {
		text.push(`$(lightbulb) Slicing ${slicingTypes.join(', ')}`);
		if(slicingFiles.length) {
			tooltip.push(`Slicing in\n${slicingFiles.map(f => `- ${f}`).join('\n')}`);
		}
	}

	if(text.length) {
		statusBarItem.show();
		statusBarItem.text = text.join(' ');
		statusBarItem.tooltip = tooltip.length ? tooltip.reduce((m, s) => m.appendMarkdown('\n\n').appendMarkdown(s), new vscode.MarkdownString()) : undefined;
	} else {
		statusBarItem.hide();
	}
}

export function isWeb() {
	// uiKind doesn't do the check we want here, since it still returns the desktop environment if we're in the vscode desktop fake browser version
	// also, this is the recommended check according to https://code.visualstudio.com/updates/v1_101#_web-environment-detection
	return !(typeof process === 'object' && process.versions.node);
}

export function getWasmRootPath(): string {
	if(!isWeb()) {
		return `${__dirname}/flowr/tree-sitter`;
	} else {
		const uri = vscode.Uri.joinPath(extensionContext.extensionUri, '/dist/web');
		// in the fake browser version of vscode, it needs to be a special scheme, so we do this check
		return uri.scheme !== 'file' ? uri.toString() : `vscode-file://vscode-app/${uri.fsPath}`;
	}
}

export let VSCodeFlowrConfiguration = defaultConfigOptions;

function updateFlowrConfig() {
	const config = getConfig();
	const wasmRoot = getWasmRootPath();
	// we don't want to *amend* here since updates to our extension config shouldn't add additional entries while keeping old ones (definitions etc.)
	VSCodeFlowrConfiguration = deepMergeObject<FlowrConfigOptions>(defaultConfigOptions, {
		ignoreSourceCalls: config.get<boolean>(Settings.IgnoreSourceCalls, false),
		solver:            {
			variables:       config.get<VariableResolve>(Settings.SolverVariableHandling, VariableResolve.Alias),
			pointerTracking: config.get<boolean>(Settings.SolverPointerTracking, false),
			resolveSource:   {
				ignoreCapitalization:  config.get<boolean>(Settings.SolverSourceIgnoreCapitalization, true),
				inferWorkingDirectory: config.get<InferWorkingDirectory>(Settings.SolverSourceInferWorkingDirectory, InferWorkingDirectory.ActiveScript),
				searchPath:            config.get<string[]>(Settings.SolverSourceSearchPath, []),
				dropPaths:             config.get<DropPathsOption>(Settings.SolverSourceDropPaths, DropPathsOption.No)
			}
		},
		semantics: {
			environment: {
				overwriteBuiltIns: {
					loadDefaults: config.get<boolean>(Settings.BuiltInsLoadDefaults, true),
					definitions:  config.get<BuiltInDefinitions>(Settings.BuiltInsDefinitions, [])
				}
			}
		},
		engines: [{
			type:               FlowrInternalSession.getEngineToUse(),
			wasmPath:           `${wasmRoot}/tree-sitter-r.wasm`,
			treeSitterWasmPath: `${wasmRoot}/tree-sitter.wasm`,
			lax:                config.get<boolean>(Settings.TreeSitterLax, true)
		}]
	});
}
