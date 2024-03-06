# vscode-flowr
*flowR* Extension for Visual Studio Code. For more information on *flowR*, check out [the main repository](https://github.com/Code-Inspect/flowr).

![A screenshot of the extension being used to reconstruct a slice](media/splash.png)

**This extension is still work in progress, as is this README. Please stay tuned for cool features and cooler documentation!**

## Installing

### From Visual Studio Marketplace
vscode-flowr is not available on the Visual Studio Marketplace yet. For now, we recommend installing from GitHub Releases, or building from source.

### From GitHub Releases
You can find official releases of the extension in the [Releases](https://github.com/Code-Inspect/vscode-flowr/releases) section of the repository. Simply select the version you would like to download, open up the Assets section at the bottom, and download the `vscode-flowr-[version].vsix` contained in it.

From Visual Studio Code, open the Extensions tab and click on the three dots in the top right to select "Install from VSIX..." Alternatively, you can use the Command Palette to select the option directly. Then, you can select the `vsix` file you downloaded to install it.

### From build artifacts
You can easily download the most recent build of the extension by heading to the [Actions tab](https://github.com/Code-Inspect/vscode-flowr/actions/workflows/package.yml), where you will find a list of runs. Selecting the most recent run will display a summary of it, at the bottom of which you can find the Artifacts section and the `Extension vsix` artifact. Download it und unzip it.

Then, you can install it the same way as you would the `vsix` downloaded [from GitHub Releases](#from-github-releases).

## Using

**To use this extension, a working installation of [R](https://www.r-project.org/) is required**, and R needs to be included in your `PATH` environment variable. You may need to [do so manually](https://www.hanss.info/sebastian/post/rtools-path/) on Windows. (There are [plans](https://github.com/Code-Inspect/vscode-flowr/issues/5) to allow for the extension to install R automatically.)

Although it is not required, we recommend using the [R extension](https://marketplace.visualstudio.com/items?itemName=REditorSupport.r) for Visual Studio Code along with this extension. For more information on R development in Visual Studio Code, you can also check out [this helpful article](https://code.visualstudio.com/docs/languages/r).

### Slicing
You can generate a [slice](https://github.com/Code-Inspect/flowr/wiki/Terminology#program-slice) of the currently highlighted variable in any R code by using the "Slice for Cursor Position" command. All code that is not part of the generated slice will then be grayed out.

To clear the slice highlighting, use the "Clear Slice Presentation" command.

You can also reconstruct a piece of code based on the slice of a variable by using the "Slice for Cursor Position (Reconstruct)" command. The reconstructed code will be opened in a new file.

## Developing

### Building and running from source
After cloning the repository, required dependencies can be installed using [npm](https://www.npmjs.com/):
```
npm ci
```

Note that this does not install [R](https://www.r-project.org/), which is also not strictly required for development, but obviously highly encouraged.

Opening the cloned repository in Visual Studio Code allows using the [existing launch configurations](https://github.com/Code-Inspect/vscode-flowr/blob/main/.vscode/launch.json) which can launch Visual Studio Code with the extension enabled. To use them, open the Run and Debug view and press the Run button at the top, or use the <kbd>F5</kbd> shortcut to start debugging.

You can then open the [example folder](https://github.com/Code-Inspect/vscode-flowr/tree/main/example) contained in this repository to try out the extension for yourself.

To build the extension into a `vsix` file, see [this documentation article](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

### Git hooks
This repository contains some git hooks to ensure that linting and other actions happen. Register these hooks by running:
```sh
git config core.hooksPath .githooks
```
