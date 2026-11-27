# VSCodium integration

A minimal extension lives at:

```text
editors/vscodium/
```

Installed extension ID:

```text
local.copl-vscode@0.1.4
```

It launches:

```text
/home/alataq/.bun/bin/bun run /home/alataq/coding/copl/src/cli.ts lsp --stdio
```

## Rebuild and reinstall

```bash
cd editors/vscodium
npm install --omit=dev --no-audit --no-fund
npx --yes @vscode/vsce package --allow-missing-repository
codium --install-extension copl-vscode-0.1.4.vsix --force
```

## Use

```bash
codium /home/alataq/coding/copl/examples/taskboard
```

Open a `.copl` file. The server starts automatically.

The extension includes a TextMate grammar for COPL keywords, types, namespaces,
methods, builtins, numbers, strings, comments, and operators. Reload the
VSCodium window after installing an update.

## Settings

- `copl.server.command` — language server executable
- `copl.server.args` — language server arguments

Environment override:

- `COPL_BUN` — overrides the server command
