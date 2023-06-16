/*
   Copyright 2023 Bernhard Walter
  
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
  
      http://www.apache.org/licenses/LICENSE-2.0
  
   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

import * as vscode from "vscode";
import * as output from "./output";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { CadqueryController } from "./controller";
import { CadqueryViewer } from "./viewer";
import { createLibraryManager, installLib, Library } from "./libraryManager";
import { createStatusManager } from "./statusManager";
import { download } from "./examples";
import { getCurrentFolder } from "./utils";
import { version } from "./version";
import * as semver from "semver";


export async function activate(context: vscode.ExtensionContext) {
    let controller: CadqueryController;
    let isWatching = false;

    let statusManager = createStatusManager();
    await statusManager.refresh("");

    let libraryManager = createLibraryManager(statusManager);
    await libraryManager.refresh();

    const ocp_vscode_lib = libraryManager.installed["ocp_vscode"];

    if (ocp_vscode_lib) {
        if (semver.eq(ocp_vscode_lib[0], version)) {
            output.info(`ocp_vscode library version ${ocp_vscode_lib[0]} matches extension version ${version}`);
        } else if (semver.gt(ocp_vscode_lib[0], version)) {
            vscode.window.showErrorMessage(
                `ocp_vscode library version ${ocp_vscode_lib[0]} is newer than extension version ${version} ` +
                `- update your OCP CAD Viewer extension`);
        } else {
            vscode.window.showInformationMessage(
                `ocp_vscode library version ${ocp_vscode_lib[0]} is older than extension version ${version} ` +
                `- update your ocp_vscode library in the Library Manager`, "Cancel", "Install").then(async (selection) => {
                    if (selection === "Install") {
                        await installLib(libraryManager, "ocp_vscode");
                    }
                })
        }
    } else {
        output.info(`ocp_vscode library not installed`);
    }

    //	Statusbar

    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

    const default_watch = vscode.workspace.getConfiguration("OcpCadViewer.advanced")[
        "watchByDefault"
    ];
    if (default_watch) {
        isWatching = true;
        statusBarItem.text = 'OCP:on';
        statusBarItem.tooltip = 'OCP CAD Viewer: Visual watch on';
    } else {
        isWatching = false;
        statusBarItem.text = 'OCP:off';
        statusBarItem.tooltip = 'OCP CAD Viewer: Visual watch off';
    }
    statusBarItem.command = 'ocpCadViewer.toggleWatch';
    context.subscriptions.push(statusBarItem);
    statusBarItem.show();

    //	Commands

    context.subscriptions.push(
        vscode.commands.registerCommand('ocpCadViewer.toggleWatch', () => {
            if (statusBarItem.text === 'OCP:on') {
                isWatching = false;
                statusBarItem.text = 'OCP:off';
                statusBarItem.tooltip = 'OCP CAD Viewer: Visual debug off';
            } else {
                isWatching = true;
                statusBarItem.text = 'OCP:on';
                statusBarItem.tooltip = 'OCP CAD Viewer: Visual debug on';
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.ocpCadViewer",
            async () => {
                output.show();

                let useDefault = true;
                let port = 3939;

                while (true) {
                    if (!useDefault) {
                        let value = await vscode.window.showInputBox({
                            prompt: `Port ${port} in use, select another port`,
                            placeHolder: "1024 .. 49152",
                            validateInput: (text: string) => {
                                let port = Number(text);
                                if (Number.isNaN(port)) {
                                    return "Not a valid number";
                                } else if (port < 1024 || port > 49151) {
                                    return "Number out of range";
                                }
                                return null;
                            }
                        });
                        if (value === undefined) {
                            output.error("Cancelling");
                            break;
                        }

                        port = Number(value);
                    }
                    const editor = vscode.window?.activeTextEditor?.document;
                    if (editor === undefined) {
                        output.error("No editor open");
                        vscode.window.showErrorMessage("No editor open");

                        break;
                    }
                    const column = vscode.window?.activeTextEditor?.viewColumn;

                    controller = new CadqueryController(
                        context,
                        port,
                        statusManager
                    );

                    if (controller.isStarted()) {
                        vscode.window.showTextDocument(editor, column);

                        if (port !== 3939) {
                            vscode.window.showWarningMessage(
                                `In Python first call ocp_vscode's "set_port(${port})"`
                            );
                        }
                        statusManager.refresh(port.toString());

                        output.show();
                        output.debug("Command cadqueryViewer registered");
                        controller.logo();
                        break;
                    } else {
                        output.info(`Restarting ...`);
                        useDefault = false;
                    }
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.installLibrary",
            async (library: Library) => {
                await installLib(libraryManager, library.label);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.installVscodeSnippets",
            async () => {
                let snippets = vscode.workspace.getConfiguration("OcpCadViewer.snippets")[
                    "dotVscodeSnippets"
                ];
                let libs = Object.keys(snippets);
                let lib = (await vscode.window.showQuickPick(libs, {
                    placeHolder: `Select the CAD library`
                }));
                if (lib === undefined) {
                    return;
                }

                let dotVscode = await vscode.window.showInputBox({
                    prompt: "Location of the .vscode folder",
                    value: `${getCurrentFolder()}/.vscode`
                });
                if (dotVscode === undefined) {
                    return;
                }

                let prefix = await vscode.window.showInputBox({
                    prompt: `Do you use a import alias (import ${lib} as xy)? Just press return if not.`,
                    placeHolder: `xy`
                });
                if (prefix === undefined) {
                    return;
                }
                if (prefix !== "" && prefix[prefix.length - 1] !== ".") {
                    prefix = prefix + ".";
                }

                let filename = path.join(dotVscode, `${lib}.code-snippets`);
                if (!fs.existsSync(dotVscode)) {
                    fs.mkdirSync(dotVscode, { recursive: true });
                }

                let snippetCode = JSON.stringify(snippets[lib], null, 2);
                snippetCode = snippetCode.replace(/\{prefix\}/g, prefix);
                fs.writeFileSync(filename, snippetCode);
                vscode.window.showInformationMessage(`Installed snippets for ${lib} into ${dotVscode}`);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.downloadExamples",
            async (library: Library) => {
                let root = getCurrentFolder();
                if (root === "") {
                    vscode.window.showInformationMessage("First open a file in your project");
                    return;
                }
                const input = await vscode.window.showInputBox({ "prompt": "Select target folder", "value": root });
                if (input === undefined) {
                    return;
                }
                await download(library.getParent(), input);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.installIPythonExtension",
            async (library: Library) => {
                let reply =
                    (await vscode.window.showQuickPick(["yes", "no"], {
                        placeHolder: `Install the VS Code extension "HoangKimLai.ipython"?`
                    })) || "";
                if (reply === "" || reply === "no") {
                    return;
                }

                vscode.window.showInformationMessage(
                    "Installing VS Code extension 'HoangKimLai.ipython' ..."
                );

                await vscode.commands.executeCommand(
                    "workbench.extensions.installExtension",
                    "HoangKimLai.ipython"
                );

                vscode.window.showInformationMessage(
                    "VS Code extension 'HoangKimLai.ipython' installed"
                );
                statusManager.hasIpythonExtension = true;
                statusManager.refresh(statusManager.port);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.installPythonModule",
            async () => {
                await installLib(libraryManager, "ocp_vscode");
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.pasteSnippet",
            (library: Library) => {
                libraryManager.pasteImport(library.label);
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.ipythonRunCell",
            () => {
                vscode.commands.executeCommand("ipython.runCellAndMoveToNext");
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.refreshLibraries",
            () => libraryManager.refresh()
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.preferences",
            () => vscode.commands.executeCommand("workbench.action.openSettings", "OCP CAD Viewer")
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("ocpCadViewer.refreshStatus", () =>
            statusManager.refresh("")
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("ocpCadViewer.openViewer", async () => {
            statusManager.openViewer();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.restartIpython",
            async () => {
                let terminals = vscode.window.terminals;
                terminals.forEach((terminal: any) => {
                    if (terminal.name === "IPython") {
                        terminal.dispose();
                    }
                });

                if (!statusManager.hasIpythonExtension) {
                    vscode.window.showErrorMessage(
                        "Extension 'HoangKimLai.ipython' not installed"
                    );
                } else {
                    vscode.commands.executeCommand("ipython.createTerminal");
                }
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            "ocpCadViewer.quickstart",
            async (arg) => {
                const conf = vscode.workspace.getConfiguration("OcpCadViewer.advanced")
                let commands = conf["quickstartCommands"][arg];
                let requiredPythonVersion = "";
                let requireConda = false;
                if (os.platform() === "darwin" && os.arch() === "arm64") {
                    commands = commands["appleSilicon"];
                    requiredPythonVersion = "3.10";
                    requireConda = true;
                } else {
                    commands = commands["others"];
                }
                installLib(libraryManager, "", commands, requiredPythonVersion, requireConda);
            }
        )
    );

    vscode.debug.registerDebugAdapterTrackerFactory('*', {
        async createDebugAdapterTracker(session) {
            var expr = "";

            output.info("Debug session started");

            return {
                async onDidSendMessage(message) {
                    if (message.event === 'stopped' && isWatching) {
                        // load the watch commands from the settings
                        expr = vscode.workspace.getConfiguration("OcpCadViewer.advanced")[
                            "watchCommands"
                        ];

                        // get the current stack trace, line number and frame id
                        const trace = await session.customRequest('stackTrace', { threadId: 1 });
                        const frameId = trace.stackFrames[0].id;

                        // call the visual debug command
                        await session.customRequest('evaluate', {
                            expression: expr,
                            context: 'repl',
                            frameId: frameId
                        });

                        // lastDebugLine = lineNo;

                    } else if (message.event === 'terminated') {
                        output.info("Debug session terminated");
                    }
                },
            };
        },
    });

    //	Register Web view

    vscode.window.registerWebviewPanelSerializer(CadqueryViewer.viewType, {
        async deserializeWebviewPanel(
            webviewPanel: vscode.WebviewPanel,
            state: any
        ) {
            CadqueryViewer.revive(webviewPanel, context.extensionUri);
        }
    });

    vscode.workspace.onDidChangeConfiguration((event: any) => {
        let affected = event.affectsConfiguration(
            "python.defaultInterpreterPath"
        );
        if (affected) {
            let pythonPath =
                vscode.workspace.getConfiguration("python")[
                "defaultInterpreterPath"
                ];
            libraryManager.refresh(pythonPath);
            controller.dispose();
            CadqueryViewer.currentPanel?.dispose();
        }
    });

    const extension = vscode.extensions.getExtension('ms-python.python')!;
    await extension.activate();
    extension?.exports.settings.onDidChangeExecutionDetails((event: any) => {
        let pythonPath = extension.exports.settings.getExecutionDetails().execCommand[0];
        libraryManager.refresh(pythonPath);
        controller.dispose();
        CadqueryViewer.currentPanel?.dispose();
    });
}

export function deactivate() {
    output.debug("OCP CAD Viewer extension deactivated");
    CadqueryViewer.currentPanel?.dispose();
}
