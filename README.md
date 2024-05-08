# vscode-flowr

[![Marketplace](https://badgen.net/vs-marketplace/v/code-inspect.vscode-flowr)](https://marketplace.visualstudio.com/items?itemName=code-inspect.vscode-flowr)

This is the *flowR* extension for Visual Studio Code which allows you to retrieve program slices directly within your IDE. For more information on *flowR* and its capabilities, please check out [the main repository](https://github.com/Code-Inspect/flowr).

## Use

**To use this extension, a working installation of [R](https://www.r-project.org/) is required**, and R needs to be included in your `PATH` environment variable. You may need to [do so manually](https://www.hanss.info/sebastian/post/rtools-path/) on Windows.

Although it is not required, we recommend using the [R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) for Visual Studio Code along with this extension. For more information on R development in Visual Studio Code, you can also check out [this helpful article](https://code.visualstudio.com/docs/languages/r).

### Slicing

You can generate a [slice](https://github.com/Code-Inspect/flowr/wiki/Terminology#program-slice) of the currently highlighted variable in any R code by using the "Slice for Cursor Position" command. All code that is not part of the generated slice will then be grayed out.

Optionally, you can also use one of the two "Toggle Continuous Slice" options, which will automatically cause the slice to be updated when code changes occur or when the cursor is moved.

You can also view the reconstruction of a piece of code based on the current slice. The "Show Current Slice in Editor (Reconstruct)" command opens a view next to the current editor that will automatically update the reconstruction as you slice.

To clear the slice highlighting, use the "Clear Current Slice Presentation" command.

![A screenshot of the extension being used to reconstruct a slice](media/reconstruct.png)

### Dataflow

You can generate and view the dataflow graph for any R source file by using the "Show Dataflow Graph" command while the file is open in the active editor. The dataflow graph will then be displayed in an interactive tab on the side, where you can pan and zoom to inspect it.

In the future, we plan on including the ability to select nodes in the dataflow graph and have relevant code sections highlighted, and vice versa.

![A screenshot of a dataflow diagram for a piece of code](media/dataflow.png)

## Installing

### From Visual Studio Marketplace

You can get the extension here: <https://marketplace.visualstudio.com/items?itemName=code-inspect.vscode-flowr>.

### From GitHub Release

You can find official releases of the extension in the [Releases](https://github.com/Code-Inspect/vscode-flowr/releases) section of the repository. Simply select the version you would like to download, open up the asset's section at the bottom, and download the `vscode-flowr-[version].vsix` contained in it.

From Visual Studio Code, open the Extensions tab and click on the three dots in the top right to select "Install from VSIX..." Alternatively, you can use the Command Palette to select the option directly. Then, you can select the `vsix` file you downloaded to install it.

### From Build Artifact

You can easily download the most recent build of the extension by heading to the [Actions tab](https://github.com/Code-Inspect/vscode-flowr/actions/workflows/package.yml), where you will find a list of runs. Selecting the most recent run will display a summary of it, at the bottom of which you can find the Artifacts section and the `Extension vsix` artifact. Download it and unzip it.

Then, you can install it the same way as you would the `vsix` downloaded [from GitHub Releases](#from-github-release).

## Development

### Building and Running from Source

After cloning the repository, required dependencies can be installed using [npm](https://www.npmjs.com/):

```shell
npm ci
```

Note that this does not install [R](https://www.r-project.org/), which is also not strictly required for development, but (obviously) highly encouraged.

Opening the cloned repository in Visual Studio Code allows using the [existing launch configurations](https://github.com/Code-Inspect/vscode-flowr/blob/main/.vscode/launch.json) which can launch Visual Studio Code with the extension enabled. To use them, open the Run and Debug view and press the Run button at the top, or use the <kbd>F5</kbd> shortcut to start debugging.

You can then open the [example folder](https://github.com/Code-Inspect/vscode-flowr/tree/main/example) contained in this repository to try out the extension for yourself.

To build the extension into a `vsix` file, see [this documentation article](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

### Git Hooks

This repository contains some git hooks to ensure that linting and other actions happen. Register these hooks by running:

```shell
git config core.hooksPath .githooks
```
