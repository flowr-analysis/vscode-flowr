# Version 0.8.2 (2026-07-21)
- Update to flowR 2.13.1, fixing a webpack bundling break caused by flowR's new doc-files module
- Autocomplete package names for library, attach and similar calls, with the newest known version shown alongside
- Use proper R partial argument matching for argument name completion and signature help
- Show S3 and S4 class ownership and more accurate doc links in the signature database view and hovers
- Suggest similar package names on hover when a library call references an unknown package
- Add a "Guess Dependency Versions" command to the Dependency View, producing a Markdown report
- Fix Ctrl+hover incorrectly opening package doc pages, only Ctrl+click does now
- Ctrl+click a call to a package function to open its source, without underlining it in the editor
- Collapse "Go to Definition" on a function call to its body instead of listing both the call and the binding
- Fix Signature DB sync failing due to a wrong release tag and picking a shard codec this runtime can't decompress
- Warn when guessing dependency versions without the full CRAN history scope downloaded
- Support spaces and --param/--required filters in the Signature DB search, matching flowR's own query syntax

# Version 0.8.1 (2026-07-15)
- Update to flowR 2.12.3, various sigdb improvements

# Version 0.7.1 (2026-07-06)
- Improve hover-over and package presentation

# Version 0.7.0 (2026-07-06)
- Package Db, flowR 2.11.1

# Version 0.6.18 (2026-07-02)
- Fix auto-activate flowR sidebar

# Version 0.6.17 (2026-07-02)
- Update flowR to 2.10.10, Various Stability Fixes

# Version 0.6.16 (2026-05-31)
- Update flowR to 2.10.6, Improve Activation

# Version 0.6.15 (2026-05-28)
- Fix minor usability errors, improve zoom and pan

# Version 0.6.14 (2026-04-07)
- Update flowR to 2.10.3, Migrate Tree-Sitter

# Version 0.6.13 (2026-03-27)
- More Linting Rules per Default

# Version 0.6.12 (2026-03-26)
- Bump flowR (and fighting release tokens)

# Version 0.6.11 (2026-03-26)
- Bump flowR, Update Tests

# Version 0.6.10 (2026-02-03)
- Fixes, bump flowR to 2.8.15

# Version 0.6.9 (2026-01-17)
- Bugfixes and Call-Graph View

# Version 0.6.8 (2026-01-06)
- Bump flowR to 2.8.5

# Version 0.6.7 (2025-12-23)
- CFG Simplification Support

# Version 0.6.6 (2025-12-22)
- Improve flowR performance

# Version 0.6.5 (2025-12-21)
- Fix refresh for hover-over values

# Version 0.6.4 (2025-12-17)
- Selective Graph Views, Hover-Over Values, Bug-Fixes

# Version 0.6.3 (2025-10-20)
- Standardize rmd support

# Version 0.6.2 (2025-09-30)
- Preview: linter quickfix support

# Version 0.6.1 (2025-09-08)
- Automatically Updating Linter

# Version 0.6.0 (2025-09-05)
- Visualizations in the Dependency-View, Backward- and Forward-Slices

# Version 0.5.16 (2025-08-20)
- Bump flowR to 2.4.7

# Version 0.5.15 (2025-08-20)
- Bump flowR to 2.4.4

# Version 0.5.14 (2025-08-04)
- Update to flowR 2.2.15, web detection and minor fixes

# Version 0.5.13 (2025-05-13)
- Feedback Button and Description Updates

# Version 0.5.12 (2025-03-17)
- Update to flowR 2.2.12

# Version 0.5.11 (2025-02-25)
- Fix: drop `setImmediate`

# Version 0.5.10 (2025-02-25)
- Minor UI Improvements

# Version 0.5.9 (2025-02-23)
- Update to flowR 2.2.10, fix slices, improve docs

# Version 0.5.8 (2025-02-21)
- Bugfixes, Improved Sourcing, Simplified DFG

# Version 0.5.7 (2025-02-19)
- Tree-Sitter Patches

# Version 0.5.6 (2025-02-19)
- Tree-Sitter Patches

# Version 0.5.5 (2025-02-19)
- Improved Dependency View, More Configuration, Working REPL

# Version 0.5.4 (2025-02-17)
- Configuration Options for the Dependency Query

# Version 0.5.3 (2025-02-17)
- Improve the Dependency View Further, REPL for local use

# Version 0.5.2 (2025-02-16)
- Access to the flowR REPL

# Version 0.5.1 (2025-02-15)
- Dependency View

# Version 0.5.0 (2025-02-14)
- Support for flowR Tree-Sitter Backend

# Version 0.4.3 (2024-10-02)
- Fix: robustify against trailing paths

# Version 0.4.2 (2024-10-02)
- Support WSS (in the browser)

# Version 0.4.1 (2024-10-02)
- Support wss

# Version 0.4.0 (2024-10-01)
- Web-Able Extension

# Version 0.3.9 (2024-09-17)
- Fix: Dataflow-Graph Rendering for Recent FlowR Updates

# Version 0.3.8 (2024-09-14)
- Update to flowR 2.0.24

# Version 0.3.7 (2024-08-30)
- Update to flowR 2.0.17

# Version 0.3.6 (2024-08-28)
- Update to flowR 2.0.15

# Version 0.3.5 (2024-08-09)
- Indicate if a Graph Is Too Large for Mermaid

# Version 0.3.4 (2024-06-27)
- Update to flowR 2.0.11

# Version 0.3.3 (2024-06-25)
- Upgrade to flowR 2.0.10

# Version 0.3.2 (2024-06-02)
- Support for R 3.6.0

# Version 0.3.1 (2024-05-28)
- Upgrade to integrated flowR v2.0.2

# Version 0.3.0 (2024-05-11)
- Upgrade to [flowr v2.0.0](https://github.com/flowr-analysis/flowr/releases/tag/v2.0.0), see the [release notes](https://github.com/flowr-analysis/flowr/releases/tag/v2.0.0) for more information on the changes.

# Version 0.2.1 (2024-05-09)
- Documenting the new features in the README ([#83](https://github.com/flowr-analysis/vscode-flowr/pull/83)) and improving the command names.

# Version 0.2.0 (2024-05-07)
- Allow slicing for multiple cursors, automatic updates of the slice based on the selection, placement of markers and improved preview of reconstructed slice, all thanks to @ManuelHentschel in [#81](https://github.com/flowr-analysis/vscode-flowr/pull/81)!

# Version 0.1.1 (2024-04-13)
- Fixed dataflow display not taking up its max width correctly

# Version 0.1.0 (2024-04-10)
- Added a command to display a source file's dataflow graph

# Version 0.0.3 (2024-03-12)
- Wait for shell initialization before running commands to avoid errors on startup

# Version 0.0.2 (2024-03-12)
- Display additional information in the status bar
- Allow configuring the extension
- Added the ability to interface with a flowR server

# Version 0.0.1 (2024-03-06)
Initial release
