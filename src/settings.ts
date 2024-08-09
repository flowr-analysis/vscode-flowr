export enum Settings {
	Category = 'vscode-flowr',
	VerboseLog = 'verboseLog',

	ServerHost = 'server.host',
	ServerPort = 'server.port',
	ServerAutoConnect = 'server.autoConnect',

	StyleSliceOpacity = 'style.sliceOpacity',
	StyleSliceDisplay = 'style.sliceDisplay',
	StyleOnlyHighlightActiveSelection = 'style.onlyHighlightActiveSelection',
	StyleMermaidMaxTextLength = 'style.mermaidMaxTextLength',

	Rexecutable = 'r.executable',
}

export type SliceDisplay = 'text' | 'diff' | 'tokens'
