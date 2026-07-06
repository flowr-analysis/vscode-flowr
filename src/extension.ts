import * as vscode from 'vscode';
import * as path from 'path';
import { FlowrInternalSession } from './flowr/internal-session';
import { FlowrServerSession } from './flowr/server-session';
import { getConfig, Settings } from './settings';
import { registerSliceCommands } from './slice';
import { registerDiagramCommands } from './flowr/diagrams/diagram';
import type { FlowrSession } from './flowr/utils';
import { selectionSlicer } from './selection-slicer';
import { positionSlicers } from './position-slicer';
import { flowrVersion } from '@eagleoutice/flowr/util/version';
import { registerDependencyInternalCommands, registerDependencyView } from './flowr/views/dependency-view';
import { DropPathsOption, FlowrConfig, InferWorkingDirectory, VariableResolve  } from '@eagleoutice/flowr/config';
import type { BuiltInDefinitions } from '@eagleoutice/flowr/dataflow/environments/built-in-config';
import { deepMergeObject } from '@eagleoutice/flowr/util/objects';
import { registerLintCommands } from './lint';
import { NoTelemetry, registerTelemetry, telemetry, TelemetryEvent } from './telemetry';
import { registerHoverOverValues } from './hover-values';
import { registerPackageInfo } from './package-info';
import { registerProjectView } from './flowr/views/project-view';
import { packageDbSummary } from './package-db';
import { TreeSitterExecutor } from '@eagleoutice/flowr/r-bridge/lang-4.x/tree-sitter/tree-sitter-executor';
import { showRepl } from './flowr/terminals/flowr-repl';

/**
 * Public-facing API for the flowR extension, which includes a variety of helpful utilities.
 * Currently, items exposed by the public-facing API are required and used for unit tests.
 */
export interface FlowrExtensionApi {
	flowrConfig: () => FlowrConfig
}

export const MINIMUM_R_MAJOR = 3;
export const BEST_R_MAJOR = 4;

let extensionContext: vscode.ExtensionContext;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let flowrSession: FlowrSession | undefined;
/** coalesces concurrent lazy session inits so a burst of feature calls doesn't spawn (and tear down) duplicates */
let sessionInitPromise: Promise<FlowrSession> | undefined;

/**
 *
 */
export async function activate(context: vscode.ExtensionContext): Promise<FlowrExtensionApi> {
	extensionContext = context;
	outputChannel = vscode.window.createOutputChannel('flowR');
	outputChannel.appendLine(`flowR extension activated (ships with flowR v${flowrVersion().toString()}, web: ${isWeb()})`);

	registerDiagramCommands(context, outputChannel);
	registerSliceCommands(context, outputChannel);
	registerLintCommands(context, outputChannel);
	registerDependencyInternalCommands(context, outputChannel);
	registerTelemetry(context, outputChannel);

	// make flowR's bundled package database discoverable before the first analysis runs
	configurePackageDatabase();
	updateFlowrConfig();
	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(Settings.Category)) {
			configurePackageDatabase();
			updateFlowrConfig();
		}
	});

	registerCommand(context, 'vscode-flowr.session.internal', async() => {
		await establishInternalSession();
		return flowrSession;
	});
	registerCommand(context, 'vscode-flowr.session.connect', async() => {
		await establishServerSession();
		return flowrSession;
	});
	registerCommand(context, 'vscode-flowr.session.disconnect', () => {
		if(flowrSession instanceof FlowrServerSession) {
			destroySession();
		}
	});
	registerCommand(context, 'vscode-flowr.repl', async() => {
		try {
			showRepl(context, await getFlowrSession());
		} catch(e){
			vscode.window.showErrorMessage('Failed to start flowR REPL');
			console.error(e);
		}
	});
	registerCommand(context, 'vscode-flowr.settings.open', async() => {
		await vscode.commands.executeCommand('workbench.action.openSettings', Settings.Category);
	});

	registerCommand(context, 'vscode-flowr.feedback', () => {
		void vscode.window.showQuickPick(['Report a Bug', 'Provide Feedback'], { placeHolder: 'Report a bug or provide Feedback' }).then((result: string | undefined) => {
			if(result === 'Report a Bug') {
				const body = encodeURIComponent(`
<!-- Please describe your issue, suggestion or feature request in more detail below! -->



<!-- Automatically generated issue metadata, please do not edit or delete content below this line -->
---
flowR version: ${flowrVersion().toString()}  
Extension version: ${(extensionContext.extension.packageJSON as { version: string }).version} (${vscode.ExtensionMode[extensionContext.extensionMode]} mode)  
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
	});

	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	context.subscriptions.push(statusBarItem);
	updateStatusBar();

	context.subscriptions.push(new vscode.Disposable(() => destroySession()),
		...registerHoverOverValues(outputChannel),
		...registerPackageInfo(outputChannel));

	setTimeout(() => {
		const { dispose: disposeDep, update: updateDependencyView } = registerDependencyView(outputChannel);
		registerCommand(context, 'vscode-flowr.dependencyView.update', async() => {
			return await updateDependencyView();
		});
		context.subscriptions.push(new vscode.Disposable(() => disposeDep()));

		const { dispose: disposeProject } = registerProjectView(outputChannel);
		context.subscriptions.push(new vscode.Disposable(() => disposeProject()));
	}, 10);
	if(typeof process !== 'undefined' && typeof process.on === 'function') {
		process.on('SIGINT', () => destroySession());
	}

	if(getConfig().get<boolean>(Settings.ServerAutoConnect)) {
		await establishServerSession();
	}

	// initialize the api :)
	return {
		flowrConfig: () => VSCodeFlowrConfiguration
	};
}

/**
 *
 */
export async function establishInternalSession() {
	destroySession();
	flowrSession = new FlowrInternalSession(outputChannel);
	await flowrSession.initialize();
	return flowrSession;
}
/**
 *
 */
export async function getFlowrSession() {
	if(flowrSession) {
		return flowrSession;
	}
	// initialize a default session if none is active (tree-sitter backend on the web, where we can't run R),
	// coalescing concurrent callers onto a single init
	sessionInitPromise ??= establishInternalSession().finally(() => {
		sessionInitPromise = undefined;
	});
	return await sessionInitPromise;
}

/**
 *
 */
export async function establishServerSession() {
	destroySession();
	flowrSession = new FlowrServerSession(outputChannel);
	await flowrSession.initialize();
	return flowrSession;
}

/**
 *
 */
export function destroySession() {
	flowrSession?.destroy();
	flowrSession = undefined;
}

/**
 *
 */
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
			let info = `R version ${flowrSession.rVersion}  \nflowR version ${flowrVersion().toString()}  \nEngine ${flowrSession.parser?.name}`;
			if(flowrSession.parser instanceof TreeSitterExecutor) {
				info += ` version ${flowrSession.parser.treeSitterVersion()}`;
			}
			info += `  \n${packageDbSummary()}`;
			tooltip.push(info);
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
			for(const [doc, slicer] of positionSlicers) {
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

	if(!(telemetry instanceof NoTelemetry)){
		text.push('$(record) Telemetry active');
	}

	if(text.length) {
		statusBarItem.show();
		statusBarItem.text = text.join(' ');
		statusBarItem.tooltip = tooltip.length ? tooltip.reduce((m, s) => m.appendMarkdown('\n\n').appendMarkdown(s), new vscode.MarkdownString()) : undefined;
	} else {
		statusBarItem.hide();
	}
}

/**
 *
 */
export function isWeb() {
	// uiKind doesn't do the check we want here, since it still returns the desktop environment if we're in the vscode desktop fake browser version
	// also, this is the recommended check according to https://code.visualstudio.com/updates/v1_101#_web-environment-detection
	return !(typeof process === 'object' && process.versions.node);
}

/**
 *
 */
export function getWasmRootPath(): string {
	if(!isWeb()) {
		return __dirname;
	} else {
		const uri = vscode.Uri.joinPath(extensionContext.extensionUri, '/dist/web');
		// in the fake browser version of vscode, it needs to be a special scheme, so we do this check
		return uri.scheme !== 'file' ? uri.toString() : `vscode-file://vscode-app/${uri.fsPath}`;
	}
}


/**
 *
 */
// we're just passing through vscode's command args syntax here :)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerCommand(context: vscode.ExtensionContext, command: string, callback: (...args: any[]) => any, thisArg?: any): void {
	context.subscriptions.push(vscode.commands.registerCommand(command, a => {
		telemetry.event(TelemetryEvent.UsedCommand, { command, args: a });
		// eslint-disable-next-line @typescript-eslint/no-unsafe-return
		return callback(a);
	}, thisArg));
}

/**
 * The absolute path to the package database that we ship inside the extension bundle
 * (copied into `dist/{node,web}` by webpack). Returns `undefined` on the web, where we cannot
 * load a database from the file system.
 */
export function getBundledPackageDbPath(): string | undefined {
	if(isWeb()) {
		return undefined;
	}
	return path.join(getWasmRootPath(), 'pkgdb-latest.json.br');
}

/**
 * Wires flowR's package database into the analysis. The database ships as a file inside the extension
 * bundle (it lives in `node_modules` otherwise and would not be part of the packaged extension), so we
 * point flowR at it via the environment variables understood by flowR's pkgdb plugin. This must run
 * before the first analysis so the plugin picks the settings up. Node-only; on the web we skip it, as
 * file-system based loading is unavailable there.
 */
function configurePackageDatabase() {
	if(isWeb() || typeof process === 'undefined' || !process.env) {
		return;
	}
	const config = getConfig();
	if(!config.get<boolean>(Settings.PackageDbEnabled, true)) {
		process.env.FLOWR_DISABLE_DEFAULT_PKGDB = 'true';
		delete process.env.FLOWR_PKGDB;
		outputChannel?.appendLine('[flowR] Package database disabled via configuration');
		return;
	}
	delete process.env.FLOWR_DISABLE_DEFAULT_PKGDB;
	const sources: string[] = [];
	const bundled = getBundledPackageDbPath();
	if(bundled) {
		sources.push(bundled);
	}
	const custom = config.get<string>(Settings.PackageDbCustomPath, '')?.trim();
	if(custom) {
		if(/^[a-z][a-z0-9+.-]*:\/\//i.test(custom)) {
			// flowR splits FLOWR_PKGDB by the OS path delimiter, which would corrupt a URL - only support local files here
			outputChannel?.appendLine(`[flowR] Ignoring package database URL "${custom}": only local file paths are supported as a custom database`);
		} else {
			sources.push(custom);
		}
	}
	if(sources.length > 0) {
		process.env.FLOWR_PKGDB = sources.join(path.delimiter);
		outputChannel?.appendLine(`[flowR] Using package database source(s): ${sources.join(', ')}`);
	}
}

// we never want to access the default flowR config on accident,
// so we set it to undefined by default until it is loaded during extension initialization
export let VSCodeFlowrConfiguration: FlowrConfig = undefined as unknown as FlowrConfig;

/**
 * Reads the package-database settings into the shape flowR expects under `solver.pkgdb`. That config field
 * only exists from flowR 2.11.1 on, so we feature-detect it and return an empty object on older versions -
 * keeping the extension compatible with both without a hard version check.
 */
function pkgDbConfigFromSettings(config = getConfig()): { pkgdb?: { enabled: boolean, eagerlyLoad: boolean, eagerlyLoadExports: boolean } } {
	const solverDefaults = FlowrConfig.default().solver as object | undefined;
	if(!solverDefaults || !('pkgdb' in solverDefaults)) {
		return {};
	}
	return {
		pkgdb: {
			enabled:            config.get<boolean>(Settings.PackageDbEnabled, true),
			eagerlyLoad:        config.get<boolean>(Settings.PackageDbEagerlyLoad, false),
			eagerlyLoadExports: config.get<boolean>(Settings.PackageDbEagerlyLoadExports, false)
		}
	};
}

function updateFlowrConfig() {
	const config = getConfig();
	const wasmRoot = getWasmRootPath();
	// we don't want to *amend* here since updates to our extension config shouldn't add additional entries while keeping old ones (definitions etc.)
	VSCodeFlowrConfiguration = deepMergeObject<FlowrConfig>(FlowrConfig.default(), {
		ignoreSourceCalls: config.get<boolean>(Settings.IgnoreSourceCalls, false),
		solver:            {
			variables:     config.get<VariableResolve>(Settings.SolverVariableHandling, VariableResolve.Alias),
			resolveSource: {
				ignoreCapitalization:  config.get<boolean>(Settings.SolverSourceIgnoreCapitalization, true),
				inferWorkingDirectory: config.get<InferWorkingDirectory>(Settings.SolverSourceInferWorkingDirectory, InferWorkingDirectory.ActiveScript),
				searchPath:            config.get<string[]>(Settings.SolverSourceSearchPath, []),
				dropPaths:             config.get<DropPathsOption>(Settings.SolverSourceDropPaths, DropPathsOption.No)
			},
			...pkgDbConfigFromSettings(config)
		},
		semantics: {
			environment: {
				overwriteBuiltIns: {
					loadDefaults: config.get<boolean>(Settings.BuiltInsLoadDefaults, true),
					definitions:  config.get<BuiltInDefinitions>(Settings.BuiltInsDefinitions, [])
				}
			}
		},
		defaultEngine: FlowrInternalSession.getEngineToUse(),
		engines:       [{
			type:               FlowrInternalSession.getEngineToUse(),
			wasmPath:           `${wasmRoot}/tree-sitter-r.wasm`,
			treeSitterWasmPath: `${wasmRoot}/tree-sitter.wasm`,
			lax:                config.get<boolean>(Settings.TreeSitterLax, true)
		}]
	} as Partial<FlowrConfig>);
}
