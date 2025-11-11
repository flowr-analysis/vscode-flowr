import type { AsyncOrSync } from 'ts-essentials';
import type { RefresherConfigKeys } from './settings';
import { Settings , getConfig } from './settings';
import * as vscode from 'vscode';


type Callback<T> = () => AsyncOrSync<T>;

export interface ConfigurableRefresherConstructor {
	/**
	 * The name of the refresher instance (will show up in console output)
	 */
	name:                   string;
	/**
	 * The keys that are used to configure the refresher by the user
	 */
	keys:                   RefresherConfigKeys
	/**
	 * The function that should be called, when the content should be updated 
	 * according to the policy configured by the config
	 */
	refreshCallback:        Callback<void>;
	/**
	 * (optional) The function that should be called, when the config changes
	 */
	configChangedCallback?: Callback<void>;
	/**
	 * (optional) The function that should be called, when the user opens a non supported file
	 * (i.e. not an R file), and the content should be cleared 
	 */
	clearCallback?:         Callback<void>;
	/**
	 * (optional) The refresher will call this function before running the actual refreshCallback.
	 * If this function returns true, the refreshCallback will be executed.
	 */
	shouldUpdateHook?:      (doc: vscode.TextDocument) => boolean;
	/**
	 * Logging output channel
	 */
	output:                 vscode.OutputChannel;
}

export const enum RefreshType {
	Never = 'never', 
	Interval = 'interval',
	Adaptive = 'adaptive',
	OnSave = 'on save',
	OnChange = 'on change'
}

/**
 * Document Language ids that the refresher will trigger on
 */
const TriggerOnLanguageIds = ['r', 'rmd'];

/**
 * Runs a callback based on a configurable refresh policy.
 * The callback can be called based on an interval
 */
export class ConfigurableRefresher {
	private activeInterval:                   NodeJS.Timeout | undefined;
	private activeDisposable:                 vscode.Disposable | undefined;
	private disposables:                      vscode.Disposable[] = [];
	private readonly spec:                    ConfigurableRefresherConstructor;
	private lastDocumentVersion?:             number;
	private static documentChangedDisposable: vscode.Disposable | undefined;
	private static onChangeRefreshers:        ConfigurableRefresher[] = [];


	constructor(c: ConfigurableRefresherConstructor) {
		this.spec = c;
        
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(e => {
			if(!e.affectsConfiguration(Settings.Category)) {
				return;
			}
			this.runConfigChangedCallback();
			this.update();
			this.runRefreshCallback();
		}));

		this.disposables.push(vscode.window.onDidChangeActiveTextEditor(_ => {
			this.runRefreshCallback();
		}));

		this.update();
	}

	public forceRefresh() {
		void this.spec.refreshCallback();
	}

	public dispose() {
		ConfigurableRefresher.unregisterRefresherForOnChanged(this);
		clearInterval(this.activeInterval);
		this.activeDisposable?.dispose();

		for(const d of this.disposables) {
			d.dispose();
		}
	}

	/**
	 * Gets called immediatly before running the refreshCallback to avoid unnecessary updates.
	 * Can be overriden by @see ConfigurableRefresherConstructor.shouldUpdateHook
	 */
	private shouldUpdate(): boolean {
		if(!vscode.window.activeTextEditor) {
			return false;
		}

		// optionaly, run specified hook instead of default behaviour
		if(this.spec.shouldUpdateHook) {
			return this.spec.shouldUpdateHook(vscode.window.activeTextEditor.document);
		}

		const update = this.lastDocumentVersion == undefined || vscode.window.activeTextEditor.document.version > this.lastDocumentVersion;
		this.lastDocumentVersion = vscode.window.activeTextEditor.document.version;
		return update;
	}

	private runRefreshCallback() {
		if(!isRTypeLanguage(vscode.window.activeTextEditor?.document)) {
			this.lastDocumentVersion = undefined;
			void this.spec.clearCallback?.();
			return false;
		}

		if(this.shouldUpdate()) {
			void this.spec.refreshCallback();
		}
	}

	private runConfigChangedCallback() {
		void this.spec.configChangedCallback?.();
	}

	// If we have to run checks on every keystroke, we don't want to repeat the checks for all refreshers!
	private static onTextDocumentChanged(e: vscode.TextDocumentChangeEvent) {
		if(!isChangeRelevant(e)) {
			return;
		}

		for(const refresher of ConfigurableRefresher.onChangeRefreshers) {
			refresher.runRefreshCallback();
		}
	}

	private static unregisterRefresherForOnChanged(refresher: ConfigurableRefresher) {
		const idx = this.onChangeRefreshers.indexOf(refresher);
		if(idx !== -1) {
			this.onChangeRefreshers.splice(idx, 1);
		}

		if(this.onChangeRefreshers.length === 0) {
			this.documentChangedDisposable?.dispose();
			this.documentChangedDisposable = undefined;
		}
	}

	private static registerRefresherForOnChanged(refresher: ConfigurableRefresher) {
		if(!ConfigurableRefresher.documentChangedDisposable) {
			ConfigurableRefresher.documentChangedDisposable = vscode.workspace.onDidChangeTextDocument((e) => {
				ConfigurableRefresher.onTextDocumentChanged(e); 
			});
		}

		this.onChangeRefreshers.push(refresher);
	}

	private update() {
		this.spec.output.append(`[${this.spec.name}] Updating Configuration`);
	
		if(this.activeInterval) {
			clearInterval(this.activeInterval);
			this.activeInterval = undefined;
		}
		if(this.activeDisposable) {
			this.activeDisposable.dispose();
			this.activeDisposable = undefined;
		}

		ConfigurableRefresher.unregisterRefresherForOnChanged(this);

		switch(getConfig().get<RefreshType>(this.spec.keys.updateType, RefreshType.Never)) {
			case 'never': break;
			case 'interval': {
				this.activeInterval = setInterval(() => this.runRefreshCallback(), getConfig().get<number>(this.spec.keys.interval, 10) * 1000);
				break;
			}
			case 'adaptive': {
				const breakOff = getConfig().get<number>(this.spec.keys.adaptiveBreak, 5000);
				if(getActiveEditorCharLength() > breakOff) {
					this.activeInterval = setInterval(() => this.runRefreshCallback(), getConfig().get<number>(this.spec.keys.interval, 10) * 1000);
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(() => {
						if(getActiveEditorCharLength() <= breakOff) {
							this.update();
						}
					});
				} else {
					this.activeDisposable = vscode.workspace.onDidChangeTextDocument(e => {	
						if(isChangeRelevant(e)) {
							this.runRefreshCallback();
						}
						
						if(getActiveEditorCharLength() > breakOff) {
							this.update();
						}
					});
				}
				break;
			}
			case 'on save':
				this.activeDisposable = vscode.workspace.onWillSaveTextDocument(() => this.runRefreshCallback());
				break;
			case 'on change':
				ConfigurableRefresher.registerRefresherForOnChanged(this);
				break;
			default:
				this.spec.output.appendLine(`[${this.spec.name}] Invalid update type: ${getConfig().get<string>(this.spec.keys.updateType)}`);
		}
	}
}

function getActiveEditorCharLength() {
	return vscode.window.activeTextEditor?.document.getText().length ?? 0;
}

function isChangeRelevant(e: vscode.TextDocumentChangeEvent): boolean {
	return e.contentChanges.length > 0 
		   && isRTypeLanguage(vscode.window.activeTextEditor?.document)
		   && e.document === vscode.window.activeTextEditor?.document 
		   && e.document.version >= (vscode.window.activeTextEditor?.document.version ?? 0);
}


export function isRTypeLanguage(doc?: vscode.TextDocument): doc is vscode.TextDocument {
	return !!doc && TriggerOnLanguageIds.indexOf(doc.languageId) !== -1;
}