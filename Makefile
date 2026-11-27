SHELL := /bin/bash

VERSION ?= $(shell cat VERSION)
BUN ?= bun
CC ?= cc
PREFIX ?= /usr/local
DESTDIR ?=
BINDIR ?= $(PREFIX)/bin
SHAREDIR ?= $(PREFIX)/share/copl
MODULEDIR ?= $(SHAREDIR)/modules

BUILDROOT ?= build/make
DISTDIR ?= dist
UNAME_M := $(shell uname -m)

ifeq ($(UNAME_M),aarch64)
ARCH ?= arm64
else
ARCH ?= x64
endif

BUN_TARGET ?= bun-linux-$(ARCH)
DIST_NAME := coplc-v$(VERSION)-linux-$(ARCH)
DIST_ROOT := $(DISTDIR)/$(DIST_NAME)
COMPILER := $(BUILDROOT)/coplc
VSCODE_DIR := editors/vscodium

.PHONY: all help version check typecheck test build dist dist-stage dist-archive dist-all smoke install uninstall clean vscode install-vscode

all: check

help:
	@printf '%s\n' \
		'COPL build targets:' \
		'  make check          Typecheck and run tests' \
		'  make typecheck      Run TypeScript typechecking' \
		'  make test           Run test suite' \
		'  make build          Build compiler binary' \
		'  make dist           Build host distribution tarball' \
		'  make dist-all       Build x64 and arm64 tarballs' \
		'  make smoke          Build and run the example using the dist binary' \
		'  make build && sudo make install' \
		'  sudo make uninstall Remove installed compiler and modules' \
		'  make vscode         Package the VSCodium extension' \
		'  make install-vscode Install the packaged VSCodium extension' \
		'  make clean          Remove build and dist outputs' \
		'  make version        Print version'

version:
	@echo $(VERSION)

typecheck:
	$(BUN) x tsc --noEmit

test:
	$(BUN) test

check: typecheck test

build:
	mkdir -p $(BUILDROOT)
	$(BUN) build --compile --target=$(BUN_TARGET) src/cli.ts --outfile $(COMPILER)

dist-stage: build
	rm -rf $(DIST_ROOT)
	mkdir -p $(DIST_ROOT)/bin
	mkdir -p $(DIST_ROOT)/share/copl/modules
	install -m 0755 $(COMPILER) $(DIST_ROOT)/bin/coplc
	cp -R modules/. $(DIST_ROOT)/share/copl/modules/
	cp VERSION $(DIST_ROOT)/VERSION
	cp README.md $(DIST_ROOT)/README.md
	cp LICENSE $(DIST_ROOT)/LICENSE
	cp -R doc $(DIST_ROOT)/doc
	@printf 'COPL %s\nLinux %s\n\nRun: bin/coplc help\n' "$(VERSION)" "$(ARCH)" > $(DIST_ROOT)/BUILD-INFO

dist-archive: dist-stage
	tar -C $(DISTDIR) -czf $(DISTDIR)/$(DIST_NAME).tar.gz $(DIST_NAME)
	cd $(DISTDIR) && sha256sum $(DIST_NAME).tar.gz > $(DIST_NAME).tar.gz.sha256

dist: check dist-archive

dist-all:
	$(MAKE) dist ARCH=x64 BUN_TARGET=bun-linux-x64
	$(MAKE) dist ARCH=arm64 BUN_TARGET=bun-linux-arm64

smoke: dist-stage
	$(DIST_ROOT)/bin/coplc build examples/taskboard --out-dir $(BUILDROOT)/smoke
	printf 'add 5 smoke\nstats\nworker\ngc\nexit\n' | $(BUILDROOT)/smoke/taskboard

install:
	@test -x $(COMPILER) || { echo "compiler not built; run 'make build' first" >&2; exit 1; }
	install -d $(DESTDIR)$(BINDIR)
	install -d $(DESTDIR)$(MODULEDIR)
	install -m 0755 $(COMPILER) $(DESTDIR)$(BINDIR)/coplc
	cp -R modules/. $(DESTDIR)$(MODULEDIR)/

uninstall:
	rm -f $(DESTDIR)$(BINDIR)/coplc
	rm -rf $(DESTDIR)$(MODULEDIR)

vscode:
	cd $(VSCODE_DIR) && npm install --omit=dev --no-audit --no-fund
	cd $(VSCODE_DIR) && npx --yes @vscode/vsce package --allow-missing-repository

install-vscode: vscode
	cd $(VSCODE_DIR) && codium --install-extension copl-vscode-*.vsix --force

clean:
	rm -rf $(BUILDROOT) $(DISTDIR)
