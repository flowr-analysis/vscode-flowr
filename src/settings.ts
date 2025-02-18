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

	Rengine = 'r.engine',
	Rexecutable = 'r.executable',

	SolverVariableHandling = 'solver.variableHandling',
	SolverPointerTracking = 'solver.pointerTracking',

	BuiltInsLoadDefaults = 'overwriteBuiltIns.loadDefaults',
	BuiltInsDefinitions = 'overwriteBuiltIns.definitions',

	DependenciesQueryIgnoreDefaults = 'dependenciesQuery.ignoreDefaults',
	DependenciesQueryOverrides = 'dependenciesQuery.overrides',

	ErrorMessageTimer = 'errorMessage.Timer',
	IgnoreSourceCalls = 'ignoreSourceCalls',
}

export type SliceDisplay = 'text' | 'diff' | 'tokens'
export type ConnectionType = 'auto' | 'websocket' | 'websocket-secure' | 'tcp'
