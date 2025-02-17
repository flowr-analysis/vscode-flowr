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
	
	DependencyViewUpdateType = 'dependencyView.updateType',
	DependencyViewUpdateInterval = 'dependencyView.updateInterval',
	DependencyViewKeepOnError = 'dependencyView.keepOnError',
	DependencyViewAutoReveal = 'dependencyView.autoReveal',

	ErrorMessageTimer = 'errorMessage.Timer',
	Rengine = 'r.engine',
	Rexecutable = 'r.executable',
}

export type SliceDisplay = 'text' | 'diff' | 'tokens'
export type ConnectionType = 'auto' | 'websocket' | 'websocket-secure' | 'tcp'
