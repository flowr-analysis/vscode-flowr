// shim for @eagleoutice/flowr/documentation/doc-util/doc-files (see webpack.config.js); only its string constants are used, doc-gen helpers just throw
const FlowrGithubGroupName = 'flowr-analysis';
const FlowrGithubBaseRef = `https://github.com/${FlowrGithubGroupName}`;

function unavailable(name) {
	return () => {
		throw new Error(`${name} is not available in this bundle`);
	};
}

module.exports = {
	FlowrGithubGroupName,
	FlowrGithubBaseRef,
	FlowrSiteBaseRef: `https://${FlowrGithubGroupName}.github.io/flowr`,
	RemoteFlowrFilePathBaseRef: `${FlowrGithubBaseRef}/flowr/tree/main/`,
	FlowrWikiBaseRef: `${FlowrGithubBaseRef}/flowr/wiki`,
	FlowrGithubRef: `${FlowrGithubBaseRef}/flowr`,
	FlowrNpmRef: 'https://www.npmjs.com/package/@eagleoutice/flowr',
	FlowrDockerRef: 'https://hub.docker.com/r/eagleoutice/flowr',
	FlowrCodecovRef: `https://app.codecov.io/gh/${FlowrGithubGroupName}/flowr`,
	FlowrVsCode: 'https://marketplace.visualstudio.com/items?itemName=code-inspect.vscode-flowr',
	FlowrPositron: 'https://open-vsx.org/extension/code-inspect/vscode-flowr',
	FlowrRStudioAddin: `${FlowrGithubBaseRef}/rstudio-addin-flowr`,
	FlowrRAdapter: `${FlowrGithubBaseRef}/flowr-r-adapter`,
	toPosixPath: p => p.replace(/\\/g, '/'),
	getFilePathMd: unavailable('getFilePathMd'),
	getFileContentFromRoot: unavailable('getFileContentFromRoot'),
	linkFlowRSourceFile: unavailable('linkFlowRSourceFile')
};
