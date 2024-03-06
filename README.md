# vscode-flowr
flowR Extension for Visual Studio Code 

## Installing

### From Visual Studio Marketplace
vscode-flowr is not available on the Visual Studio Marketplace yet. For now, we recommend installing from the artifact, or building from source.

### From GitHub Releases
There are no official releases yet. Stay tuned!

### From build artifacts
You can easily download the most recent build of the extension by heading to the [Actions tab](https://github.com/Code-Inspect/vscode-flowr/actions/workflows/package.yml), where you will find a list of runs. Selecting the most recent run will display a summary of it, at the bottom of which you can find the Artifacts section and the `Extension vsix` artifact. Download it und unzip it.

From Visual Studio Code, open the Extensions tab and click on the three dots in the top right to select "Install from VSIX..." Alternatively, you can use the Command Palette to select the option directly. Then, you can select the `vscode-flowr-[version].vsix` file you unzipped to install it.

## Developing

### Building and running from source
Opening the repository in Visual Studio Code allows using the [existing launch configurations](https://github.com/Code-Inspect/vscode-flowr/blob/main/.vscode/launch.json) which can launch Visual Studio Code with the extension enabled. To use them, open the Run and Debug view and press the Run button at the top, or use the F5 shortcut to start debugging.

You can then open the [example folder](https://github.com/Code-Inspect/vscode-flowr/tree/main/example) contained in this repository to try out the extension for yourself.

To build the extension into a `vsix` file, see [this documentation article](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

### Git hooks
This repository contains some git hooks to ensure that linting and other actions happen. Register these hooks by running:
```sh
git config core.hooksPath .githooks
```
