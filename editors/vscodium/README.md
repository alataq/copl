# COPL for VSCodium

Minimal VSCodium extension that launches:

```text
bun run /home/alataq/coding/copl/src/cli.ts lsp --stdio
```

Open a folder containing a COPL project (`manifest.json`) and edit `.copl` files.

Environment overrides:

- `COPL_BUN` — path to bun
- `COPL_CLI` — path to coplc cli.ts
