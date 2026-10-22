import type { ValueOf } from 'ts-essentials';
import * as vscode from 'vscode';


export enum Settings {
	Category = 'vscode-flowr',
	VerboseLog = 'verboseLog',

	ServerHost = 'server.host',
	ServerPort = 'server.port',
	ServerAutoConnect = 'server.autoConnect',
	ServerConnectionType = 'server.connectionType',

	StyleSliceOpacity = 'style.sliceOpacity',
	StyleSliceDisplay = 'style.sliceDisplay',
	StyleOnlyHighlightActiveSelection = 'style.onlyHighlightActiveSelection',
	StyleMermaidMaxTextLength = 'style.mermaidMaxTextLength',
	StyleTokenBackground = 'style.tokenBackgroundColor',
	StyleLineCategoryIndicators = 'style.lineCategoryIndicators',

	SliceAutomaticReconstruct = 'slice.automaticReconstruct',
	SliceRevisitThreshold = 'slice.revisitThreshold',
	SliceIncludeCallees = 'slice.includeCallees',
	SliceInlineSources = 'slice.inlineSources',
	SlicePositionCombination = 'slice.positionCombination',
	SliceNegative = 'slice.negative',

	TreeSitterTimeout = 'tree-sitter.timeout',
	TreeSitterLax = 'tree-sitter.lax',

	DependencyViewUpdateType = 'dependencyView.updateType',
	DependencyViewUpdateInterval = 'dependencyView.updateInterval',
	DependencyViewAdaptiveBreak = 'dependencyView.adaptiveCharacterLimit',
	DependencyViewKeepOnError = 'dependencyView.keepOnError',
	DependencyViewAutoReveal = 'dependencyView.autoReveal',
	DependencyViewCacheLimit = 'dependencyView.cacheLimit',
	DependenciesQueryIgnoreDefaults = 'dependencyView.query.ignoreDefaults',
	DependenciesQueryOverrides = 'dependencyView.query.overrides',
	DependenciesQueryEnabledCategories = 'dependencyView.query.enabledCategories',

	Rengine = 'r.engine',
	Rexecutable = 'r.executable',

	SolverVariableHandling = 'config.solver.variableHandling',
	SolverSourceIgnoreCapitalization = 'config.solver.resolveSource.ignoreCapitalization',
	SolverSourceInferWorkingDirectory = 'config.solver.resolveSource.inferWorkingDirectory',
	SolverSourceSearchPath = 'config.solver.resolveSource.searchPath',
	SolverSourceDropPaths = 'config.solver.resolveSource.dropPaths',

	BuiltInsLoadDefaults = 'config.overwriteBuiltIns.loadDefaults',
	BuiltInsDefinitions = 'config.overwriteBuiltIns.definitions',
	IgnoreSourceCalls = 'config.ignoreSourceCalls',

	SigDbEnabled = 'config.solver.sigdb.enabled',
	SigDbAutoSync = 'config.solver.sigdb.autoSync',
	SigDbEagerlyLoad = 'config.solver.sigdb.eagerlyLoad',
	SigDbCustomPath = 'config.solver.sigdb.customPath',

	CompletionEnabled = 'completion.enabled',
	CompletionAlwaysAvailablePackages = 'completion.alwaysAvailablePackages',
	CompletionShowS3Methods = 'completion.showS3Methods',
	CompletionWithRlanguageServer = 'completion.withRLanguageServer',

	McpEnabled = 'mcp.enabled',

	SymbolsEnabled = 'symbols.enabled',
	SymbolsWithRlanguageServer = 'symbols.withRLanguageServer',

	RecordingEnabled = 'recording.enabled',
	RecordingAcronym = 'recording.acronym',
	RecordingDirectory = 'recording.directory',

	ErrorMessageTimer = 'errorMessage.Timer',

	DebugFlowrLoglevel = 'debug.flowrLogLevel',

	LinterEnabledRules = 'linter.enabledRules',
	LinterRuleConfigs = 'linter.ruleConfigs',
	LinterUpdateType = 'linter.updateType',
	LinterUpdateInterval = 'linter.updateInterval',
	LinterAdaptiveBreak = 'linter.adaptiveCharacterLimit',

	ValuesOnHover = 'values.hover',
	ValuesHoverResolve = 'values.hover.resolve',
	ValuesHoverDataFrames = 'values.hover.dataFrames',

	PackageInfoEnabled = 'packageInfo.enabled',
}

export enum DiagramSettingsKeys {
	Sync = 'sync',
	Mode = 'mode',
	SimplificationPasses = 'cfgSimplificationPasses',
	SimplifyCfg = 'simplifyCfg',
	SimplifyDfg = 'simplifyDfg'

}

export const DiagramSettingsPrefix = 'diagram';

export type DefaultsMaps =  {
	[K in keyof typeof Settings]?: unknown
};

export interface RefresherConfigKeys {
	updateType:    ValueOf<typeof Settings>,
	adaptiveBreak: ValueOf<typeof Settings>,
	interval:      ValueOf<typeof  Settings>
}

export const LinterRefresherConfigKeys =  {
	updateType:    Settings.LinterUpdateType,
	interval:      Settings.LinterUpdateInterval,
	adaptiveBreak: Settings.LinterAdaptiveBreak
} satisfies RefresherConfigKeys;

export const DependencyViewRefresherConfigKeys =  {
	updateType:    Settings.DependencyViewUpdateType,
	interval:      Settings.DependencyViewUpdateInterval,
	adaptiveBreak: Settings.DependencyViewAdaptiveBreak
} satisfies RefresherConfigKeys;

/** how the slices of several tracked positions are combined */
export type SliceCombination = 'union' | 'intersection';
export type SliceDisplay = 'text' | 'diff' | 'tokens';
export type ConnectionType = 'auto' | 'websocket' | 'websocket-secure' | 'tcp';

/** the extension's workspace configuration section */
export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(Settings.Category);
}

/** writes a setting where it is currently set (workspace or user), so that a toggle is not shadowed by a workspace value */
export async function updateWhereSet(key: string, value: unknown): Promise<void> {
	// the settings are read without a folder scope, so folder values are not considered here either
	const config = getConfig();
	const target = config.inspect(key)?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
	try {
		await config.update(key, value, target);
	} catch(e) {
		void vscode.window.showErrorMessage(`flowR: Could not change ${key}: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** whether verbose logging is enabled */
export function isVerbose(): boolean {
	return getConfig().get<boolean>(Settings.VerboseLog, false);
}
