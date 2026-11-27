# Distribution

The `Makefile` builds and packages the compiler plus standard modules.

## Targets

```text
make check          typecheck + tests
make build          native compiler binary in build/make/coplc
make dist           host tarball + sha256
make dist-all       x64 and arm64 tarballs
make smoke          stage dist and run the TaskBoard example with it
make build && sudo make install   install compiler + modules
sudo make uninstall remove installed files
make vscode         package the VSCodium extension
make install-vscode install the packaged VSCodium extension
make clean          remove build/ and dist/
make version        print VERSION
```

## Version

Edit `VERSION` or override:

```bash
make dist VERSION=0.2.0
```

## Distribution layout

```text
coplc-v0.1.0-linux-x64/
  bin/coplc
  share/copl/modules/
    copl/vector.copl
    copl/string.copl
    copl/io/console.copl
  VERSION
  README.md
  BUILD-INFO
  doc/
```

Archive:

```text
dist/coplc-v0.1.0-linux-x64.tar.gz
dist/coplc-v0.1.0-linux-x64.tar.gz.sha256
```

## Installed layout

Default install prefix:

```text
/usr/local/bin/coplc
/usr/local/share/copl/modules/
```

Overrides:

```bash
make build
sudo make install PREFIX=/opt/copl
make install DESTDIR=/tmp/stage
```

## Module discovery

The compiler looks for standard modules in:

1. `$COPL_HOME/modules`
2. `$COPL_PATH`
3. `../share/copl/modules` relative to the executable
4. development `modules/` when running via Bun

Project-local `modules/` still takes priority through the resolver.

## Cross builds

```bash
make dist-all
```

Builds:

```text
bun-linux-x64
bun-linux-arm64
```

## VSCodium

```bash
make vscode
make install-vscode
```
