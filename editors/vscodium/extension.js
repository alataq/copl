const { workspace } = require("vscode");
const { LanguageClient } = require("vscode-languageclient/node");

let client;

function activate(context) {
  const config = workspace.getConfiguration("copl");
  const command =
    process.env.COPL_BUN ||
    config.get("server.command") ||
    "/home/alataq/.bun/bin/bun";
  const configuredArgs = config.get("server.args");
  const args = Array.isArray(configuredArgs)
    ? configuredArgs
    : ["run", "/home/alataq/coding/copl/src/cli.ts", "lsp", "--stdio"];
  const cwd = workspace.workspaceFolders && workspace.workspaceFolders.length > 0
    ? workspace.workspaceFolders[0].uri.fsPath
    : context.extensionPath;

  const serverOptions = {
    command,
    args,
    options: { cwd },
  };
  const clientOptions = {
    documentSelector: [{ scheme: "file", language: "copl" }],
    synchronize: {
      fileEvents: workspace.createFileSystemWatcher("**/*.copl"),
    },
  };

  client = new LanguageClient(
    "copl",
    "COPL Language Server",
    serverOptions,
    clientOptions,
  );
  context.subscriptions.push(client.start());
}

function deactivate() {
  return client ? client.stop() : undefined;
}

module.exports = { activate, deactivate };
