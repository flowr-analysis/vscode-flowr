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
	LinterRuleConfigs = 'linter.ruleConfigs'
}

export type SliceDisplay = 'text' | 'diff' | 'tokens'
export type ConnectionType = 'auto' | 'websocket' | 'websocket-secure' | 'tcp'
