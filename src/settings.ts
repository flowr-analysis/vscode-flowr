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

	TreeSitterTimeout = 'tree-sitter.timeout',

	DependencyViewUpdateType = 'dependencyView.updateType',
	DependencyViewUpdateInterval = 'dependencyView.updateInterval',
	DependencyViewKeepOnError = 'dependencyView.keepOnError',
	DependencyViewAutoReveal = 'dependencyView.autoReveal',
	DependencyViewCacheLimit = 'dependencyView.cacheLimit',
	DependenciesQueryIgnoreDefaults = 'dependencyView.query.ignoreDefaults',
	DependenciesQueryOverrides = 'dependencyView.query.overrides',

	Rengine = 'r.engine',
	Rexecutable = 'r.executable',

	SolverVariableHandling = 'config.solver.variableHandling',
	SolverPointerTracking = 'config.solver.pointerTracking',
	BuiltInsLoadDefaults = 'config.overwriteBuiltIns.loadDefaults',
	BuiltInsDefinitions = 'config.overwriteBuiltIns.definitions',
	IgnoreSourceCalls = 'config.ignoreSourceCalls',

	ErrorMessageTimer = 'errorMessage.Timer',
}

export type SliceDisplay = 'text' | 'diff' | 'tokens'
export type ConnectionType = 'auto' | 'websocket' | 'websocket-secure' | 'tcp'
