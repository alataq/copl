# LSP server

Start:

```bash
coplc lsp --stdio
```

Transport:

- JSON-RPC 2.0
- `Content-Length` framing
- stdin/stdout

## Lifecycle

- `initialize`
- `initialized`
- `shutdown`
- `exit`

## Documents

- `textDocument/didOpen`
- `textDocument/didChange`
- `textDocument/didSave`
- `textDocument/didClose`

Unsaved open documents are supplied to the resolver as overlays.

## Capabilities

- `textDocument/publishDiagnostics`
- `textDocument/documentSymbol`
- `textDocument/hover`
- `textDocument/definition`
- `textDocument/references`
- `textDocument/rename`
- `textDocument/completion`
- `textDocument/formatting`
- `textDocument/codeAction`
- `workspace/symbol`

## Behavior

- project root is discovered from the open file's nearest `manifest.json`
- if no project is found, the document is analyzed standalone
- diagnostics come from parse/semantic/C-type failures
- hover and definition search the semantic model for types, methods, and fields
- references and rename use identifier occurrences across project files and open
  overlays
- formatting currently trims trailing whitespace and ensures a final newline
- code actions currently return no edits

## Current limitations

- semantic diagnostics are fail-fast in the compiler, so one semantic error is
  reported at a time
- formatting is intentionally minimal
- completion currently offers keywords, type names, methods, and fields without
  context filtering
- rename is textual across identifier occurrences rather than a full symbol
  graph rename

## VSCodium

See `vscodium.md` for the bundled VSCodium extension and install steps.
