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

	SliceAutomaticReconstruct = 'slice.automaticReconstruct',
	SliceRevisitThreshold = 'slice.revisitThreshold',

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
	SolverPointerTracking = 'config.solver.pointerTracking',
	SolverSourceIgnoreCapitalization = 'config.solver.resolveSource.ignoreCapitalization',
	SolverSourceInferWorkingDirectory = 'config.solver.resolveSource.inferWorkingDirectory',
	SolverSourceSearchPath = 'config.solver.resolveSource.searchPath',
	SolverSourceDropPaths = 'config.solver.resolveSource.dropPaths',

	BuiltInsLoadDefaults = 'config.overwriteBuiltIns.loadDefaults',
	BuiltInsDefinitions = 'config.overwriteBuiltIns.definitions',
	IgnoreSourceCalls = 'config.ignoreSourceCalls',

	ErrorMessageTimer = 'errorMessage.Timer',

	DebugFlowrLoglevel = 'debug.flowrLogLevel',

	LinterEnabledRules = 'linter.enabledRules',
	LinterRuleConfigs = 'linter.ruleConfigs',
	LinterUpdateType = 'linter.updateType',
	LinterUpdateInterval = 'linter.updateInterval',
	LinterAdaptiveBreak = 'linter.adaptiveCharacterLimit',
}

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

export type SliceDisplay = 'text' | 'diff' | 'tokens'
export type ConnectionType = 'auto' | 'websocket' | 'websocket-secure' | 'tcp'

export function getConfig(): vscode.WorkspaceConfiguration {
	return vscode.workspace.getConfiguration(Settings.Category);
}

export function isVerbose(): boolean {
	return getConfig().get<boolean>(Settings.VerboseLog, false);
}
