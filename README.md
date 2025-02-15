# R Code Analyzer (vscode-flowr)

[![Marketplace](https://badgen.net/vs-marketplace/v/code-inspect.vscode-flowr)](https://marketplace.visualstudio.com/items?itemName=code-inspect.vscode-flowr)

This extension brings [_flowR_](https://github.com/flowr-analysis/flowr) to Visual Studio Code.
With it, you gain access to the following features (this extension is under active development, so many more features are planned):

1. [**Slicing**](#slicing): Reduce the Program to just the parts relevant to a specific variable or figure.
   This is useful, when you want to reuse code for a figure or statistical analysis in another context or if you just want to understand the code better.
2. [**Dependency View**](#dependency-view): View the library a given script loads, the files it reads and writes, as well as the sourced scripts.
   This helps you understanding what is required to run a script, where it reads data from, and where it writes data to.
3. [**Dataflow Graph**](#dataflow): Visualize the dataflow in a script.
   This helps you understand how data is transformed in a script and where it is used.

## Use

This section provides a brief overview of the features provided by this extension and how to use them. See [below](#installing) for instructions on how to install the extension.

### Prerequisites

Installing the extension is sufficient for all features!
Yet, flowR may benefit from a local R installation (which has to be available on your `PATH`) so it can incorporate your local R setup into its analysis.

Additionally, we recommend using the [R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) for Visual Studio Code along with this extension. For more information on R development in Visual Studio Code, you can also check out [this helpful article](https://code.visualstudio.com/docs/languages/r).

### Slicing

Slicing describes the process of reducing a program to just the parts relevant to a specific variable or figure.
With the extension loaded, select a variable you are interested in and either press <kbd>Ctrl</kbd>+<kbd>S</kbd> to slice for it once or <kbd>Ctrl</kbd>+<kbd>P</kbd> to mark the position and continuously update the slice as you edit the file.
The editor will gray out all code that is not part of the generated slice.

#### Detailed Explanation

You can generate a [slice](https://github.com/flowr-analysis/flowr/wiki/Terminology#program-slice) of the currently highlighted variable in any R code by using the "Slice for Cursor Position" command. All code that is not part of the generated slice will then be grayed out.

Optionally, you can also use one of the two "Toggle Continuous Slice" options, which will automatically cause the slice to be updated when code changes occur or when the cursor is moved.

You can also view the reconstruction of a piece of code based on the current slice. The "Show Current Slice in Editor (Reconstruct)" command opens a view next to the current editor that will automatically update the reconstruction as you slice.

To clear the slice highlighting, use the "Clear Current Slice Presentation" command.

![A screenshot of the extension being used to reconstruct a slice](media/reconstruct.png)

### Dependency View

![A screenshot of a dependency diagram for a piece of code](media/dependencies.png)

Using the extension, the sidebar should contain a flowR icon which holds more information on the current file, listing the libraries loaded, the files read and written, and the sourced scripts. If you expand the respective sections, clicking on the found entries should open them in the editor. The context menu (available with a right click) allows you to [slice](#slicing) for the selected entry.

### Dataflow

You can generate and view the dataflow graph for any R source file by using the "Show Dataflow Graph" command while the file is open in the active editor. The dataflow graph will then be displayed in an interactive tab on the side, where you can pan and zoom to inspect it.

In the future, we plan on including the ability to select nodes in the dataflow graph and have relevant code sections highlighted, and vice versa.

![A screenshot of a dataflow diagram for a piece of code](media/dataflow.png)

## Installing

### From Visual Studio Marketplace

You can get the extension here: <https://marketplace.visualstudio.com/items?itemName=code-inspect.vscode-flowr>.

### From GitHub Release

You can find official releases of the extension in the [Releases](https://github.com/flowr-analysis/vscode-flowr/releases) section of the repository. Simply select the version you would like to download, open up the asset's section at the bottom, and download the `vscode-flowr-[version].vsix` contained in it.

From Visual Studio Code, open the Extensions tab and click on the three dots in the top right to select "Install from VSIX..." Alternatively, you can use the Command Palette to select the option directly. Then, you can select the `vsix` file you downloaded to install it.

### From Build Artifact

You can easily download the most recent build of the extension by heading to the [Actions tab](https://github.com/flowr-analysis/vscode-flowr/actions/workflows/package.yml), where you will find a list of runs. Selecting the most recent run will display a summary of it, at the bottom of which you can find the Artifacts section and the `Extension vsix` artifact. Download it and unzip it.

Then, you can install it the same way as you would the `vsix` downloaded [from GitHub Releases](#from-github-release).

## Development

### Building and Running from Source

After cloning the repository, required dependencies can be installed using [npm](https://www.npmjs.com/):

```shell
npm ci
```

Note that this does not install [R](https://www.r-project.org/), which is also not strictly required for development, but (obviously) highly encouraged.

Opening the cloned repository in Visual Studio Code allows using the [existing launch configurations](https://github.com/flowr-analysis/vscode-flowr/blob/main/.vscode/launch.json) which can launch Visual Studio Code with the extension enabled. To use them, open the Run and Debug view and press the Run button at the top, or use the <kbd>F5</kbd> shortcut to start debugging.

You can then open the [example folder](https://github.com/flowr-analysis/vscode-flowr/tree/main/example) contained in this repository to try out the extension for yourself.

To build the extension into a `vsix` file, see [this documentation article](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

### Git Hooks

This repository contains some git hooks to ensure that linting and other actions happen. Register these hooks by running:

```shell
git config core.hooksPath .githooks
```
