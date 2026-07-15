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
import { registerCompletion } from './completion';
import { registerProjectView } from './flowr/views/project-view';
import { registerSigDbView } from './flowr/views/sigdb-view';
import { registerSigDbNotifications } from './sigdb-notifications';
import { sigDbSummary, getSigDbMountPaths } from './package-db';
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

	// make flowR's bundled signature database discoverable before the first analysis runs
	configureSigDb();
	updateFlowrConfig();
	// pre-download base R signatures on first activation for better UX
	void predownloadBaseRSignatures();
	vscode.workspace.onDidChangeConfiguration(e => {
		if(e.affectsConfiguration(Settings.Category)) {
			configureSigDb();
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
	statusBarItem.command = 'workbench.view.extension.flowr';
	context.subscriptions.push(statusBarItem);
	updateStatusBar();

	context.subscriptions.push(new vscode.Disposable(() => destroySession()),
		...registerHoverOverValues(outputChannel),
		...registerPackageInfo(outputChannel),
		registerCompletion());

	setTimeout(() => {
		const { dispose: disposeDep, update: updateDependencyView } = registerDependencyView(outputChannel);
		registerCommand(context, 'vscode-flowr.dependencyView.update', async() => {
			return await updateDependencyView();
		});
		context.subscriptions.push(new vscode.Disposable(() => disposeDep()));

		const { dispose: disposeProject } = registerProjectView(outputChannel);
		const { dispose: disposeSigDb } = registerSigDbView(context, outputChannel);
		const { dispose: disposeSigDbNotif } = registerSigDbNotifications(context, outputChannel);
		context.subscriptions.push(
			new vscode.Disposable(() => disposeProject()),
			new vscode.Disposable(() => disposeSigDb()),
			new vscode.Disposable(() => disposeSigDbNotif())
		);
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
		const connected = flowrSession.state === 'connected';
		text.push(`$(cloud) flowR ${flowrSession.state}${connected && flowrSession.rVersion ? ` (R ${flowrSession.rVersion})` : ''}`);
		if(connected) {
			tooltip.push(`R version ${flowrSession.rVersion}  \nflowR version ${flowrSession.flowrVersion}`);
		}
		if(flowrSession.working){
			text.push('$(loading~spin) Analyzing');
		}
	} else if(flowrSession instanceof FlowrInternalSession) {
		const active = flowrSession.state === 'active';
		text.push(`$(console) flowR ${flowrSession.state}${active && flowrSession.rVersion ? ` (R ${flowrSession.rVersion})` : ''}`);
		if(active) {
			let info = `R version ${flowrSession.rVersion}  \nflowR version ${flowrVersion().toString()}  \nEngine ${flowrSession.parser?.name}`;
			if(flowrSession.parser instanceof TreeSitterExecutor) {
				info += ` version ${flowrSession.parser.treeSitterVersion()}`;
			}
			info += `  \n${sigDbSummary()}`;
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
 * The absolute path to the signature database that we ship inside the extension bundle
 * (copied into `dist/node` by webpack). Returns `undefined` on the web.
 */
export function getBundledSigDbPath(): string | undefined {
	if(isWeb()) {
		return undefined;
	}
	return path.join(getWasmRootPath(), 'sigdb');
}

/** Log whether flowR will auto-sync the signature database in the background (see `sigDbConfigFromSettings`) */
function predownloadBaseRSignatures(): void {
	if(isWeb() || typeof process === 'undefined' || !process.env) {
		return;
	}
	const config = getConfig();
	if(!config.get<boolean>(Settings.SigDbEnabled, true) || !config.get<boolean>(Settings.SigDbAutoSync, false)) {
		return;
	}
	outputChannel?.appendLine('[flowR] SigDB auto-sync enabled - checking for changed shards in the background');
}

/**
 * Re-reads the signature-database settings and on-disk state (`FLOWR_SIGDB`/`additionalPaths`) and destroys the
 * active flowR session, so the next feature call builds a fresh one that actually mounts what is now on disk.
 * Without this, downloading/removing a scope from the Signature DB view had no effect on an already-running
 * session - `configureSigDb()`/`updateFlowrConfig()` only ever ran at activation and on a settings change, and
 * even a re-run alone would not help an *already-constructed* session, which bakes the sigdb paths in once.
 */
export function refreshSigDbConfig() {
	configureSigDb();
	updateFlowrConfig();
	destroySession();
}

function configureSigDb() {
	if(isWeb() || typeof process === 'undefined' || !process.env) {
		return;
	}
	const config = getConfig();
	if(!config.get<boolean>(Settings.SigDbEnabled, true)) {
		process.env.FLOWR_DISABLE_DEFAULT_SIGDB = 'true';
		delete process.env.FLOWR_SIGDB;
		outputChannel?.appendLine('[flowR] Signature database disabled via configuration');
		return;
	}
	delete process.env.FLOWR_DISABLE_DEFAULT_SIGDB;
	const sources = sigDbAdditionalSources(config);
	if(sources.length > 0) {
		process.env.FLOWR_SIGDB = sources.join(path.delimiter);
		outputChannel?.appendLine(`[flowR] Using signature database source(s): ${sources.join(', ')}`);
	}
}

/**
 * Every real, on-disk signature-database source beyond the bundled default: the synced bundle's non-overlapping
 * manifest files (see `getSigDbMountPaths` - mounting `base` *and* `current` together duplicates every base
 * package and crashes flowR's own dependency resolution) plus the user's own configured `customPath`. Shared
 * by `configureSigDb()` (which feeds it to the `FLOWR_SIGDB` env var the sigdb plugin reads directly) and
 * `sigDbConfigFromSettings()` (which feeds the *same* list into `FlowrConfig.solver.sigdb.additionalPaths`), so
 * every flowR-backed feature - the REPL, hover/definition, dependency view, linting - sees identical sigdb
 * sources regardless of which of the two mechanisms it happens to consult.
 */
function sigDbAdditionalSources(config = getConfig()): string[] {
	const sources = getSigDbMountPaths();
	const custom = config.get<string>(Settings.SigDbCustomPath, '')?.trim();
	if(custom) {
		sources.push(custom);
	}
	return sources;
}

// we never want to access the default flowR config on accident,
// so we set it to undefined by default until it is loaded during extension initialization
export let VSCodeFlowrConfiguration: FlowrConfig = undefined as unknown as FlowrConfig;

/**
 * Reads the signature-database settings into the shape flowR expects under `solver.sigdb` (`enabled`,
 * `autoSync`, `eagerlyLoad`, `additionalPaths`). Without this, those VS Code settings only ever reached
 * flowR indirectly through the `FLOWR_SIGDB`/`FLOWR_DISABLE_DEFAULT_SIGDB` env vars set by
 * `configureSigDb()` - `autoSync`'s opt-in background re-sync and `eagerlyLoad`'s upfront database mount
 * (both real flowR features, see `flowr-analyzer-builder.js`/`flowr-analyzer-package-versions-sigdb-plugin.js`)
 * were never actually triggered because nothing set them on the real `FlowrConfig` object.
 */
function sigDbConfigFromSettings(config = getConfig()): {
	sigdb?: { enabled: boolean, autoSync: boolean, eagerlyLoad: boolean, additionalPaths: string[] }
} {
	const solverDefaults = FlowrConfig.default().solver as object | undefined;
	if(!solverDefaults || !('sigdb' in solverDefaults)) {
		return {};
	}
	return {
		sigdb: {
			enabled:         config.get<boolean>(Settings.SigDbEnabled, true),
			autoSync:        config.get<boolean>(Settings.SigDbAutoSync, false),
			eagerlyLoad:     config.get<boolean>(Settings.SigDbEagerlyLoad, false),
			additionalPaths: isWeb() ? [] : sigDbAdditionalSources(config)
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
			...sigDbConfigFromSettings(config)
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
