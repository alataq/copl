#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildProject, generateC } from "./codegen";
import { CoplError, formatDiagnostic, formatDiagnostics, type Diagnostic } from "./diagnostics";
import { LanguageServer } from "./lsp";
import { loadManifest, resolveWorkerCount, type LoadedManifest } from "./manifest";
import { defaultModuleRoots } from "./modulePaths";
import { resolveProject, type ResolvedProject } from "./resolver";
import { analyzeProject } from "./sema/checker";
import type { SemanticModel } from "./sema/symbols";

const VERSION = "0.1.0";

const USAGE = `coplc - COPL bootstrap compiler (v0)

Usage:
  coplc check   [project] [options]
  coplc build   [project] [options]
  coplc emit-c  [project] [options]
  coplc run     [project] [options] [-- program args...]
  coplc clean   [project] [options]
  coplc init    [dir]
  coplc lsp     [project] [--stdio]
  coplc version
  coplc help

Common options:
  --project <dir>       Project root
  --entry <name>        Entry override
  --copl-path <dirs>    Module roots, repeatable or ':'-separated
  --json                Machine-readable output
  --no-color            Disable color
  --quiet, -q           Less output
  --verbose, -v         More output
  --help, -h            Show help
  --version             Show version

Build options:
  --out-dir <dir>       Output directory
  --name <name>         Executable/source base name
  --cc <compiler>       C compiler
  --cflags <flags>      Extra C flags
  --ldflags <flags>     Extra linker flags
  --keep-c              Keep generated C (currently always kept)`;

interface CliOptions {
  command: string;
  project?: string;
  entry?: string;
  coplPath: string[];
  json: boolean;
  color: boolean;
  quiet: boolean;
  verbose: boolean;
  outDir?: string;
  name?: string;
  cc?: string;
  cflags: string[];
  ldflags: string[];
  keepC: boolean;
  programArgs: string[];
  help: boolean;
  version: boolean;
}

interface LoadedProject {
  root: string;
  manifest: LoadedManifest;
  project: ResolvedProject;
  model: SemanticModel;
}

function usageError(message: string): never {
  throw new CoplError(message, undefined, "usage");
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    command: argv[0] ?? "help",
    coplPath: [],
    json: false,
    color: process.stdout.isTTY === true,
    quiet: false,
    verbose: false,
    cflags: [],
    ldflags: [],
    keepC: false,
    programArgs: [],
    help: false,
    version: false,
  };
  const positional: string[] = [];

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") {
      options.programArgs = argv.slice(index + 1);
      break;
    }
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    const inline = equals >= 0 ? arg.slice(equals + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[index + 1];
      if (next === undefined) {
        usageError(`option '${name}' requires a value`);
      }
      index += 1;
      return next;
    };
    switch (name) {
      case "--project":
        options.project = value();
        break;
      case "--entry":
        options.entry = value();
        break;
      case "--copl-path":
        options.coplPath.push(...value().split(":").filter((part) => part.length > 0));
        break;
      case "--json":
        options.json = true;
        break;
      case "--no-color":
        options.color = false;
        break;
      case "--color":
        options.color = true;
        break;
      case "--quiet":
      case "-q":
        options.quiet = true;
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--out-dir":
        options.outDir = value();
        break;
      case "--name":
        options.name = value();
        break;
      case "--cc":
        options.cc = value();
        break;
      case "--cflags":
        options.cflags.push(...splitFlags(value()));
        break;
      case "--ldflags":
        options.ldflags.push(...splitFlags(value()));
        break;
      case "--keep-c":
        options.keepC = true;
        break;
      case "--stdio":
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--version":
        options.version = true;
        break;
      default:
        usageError(`unknown option '${arg}'`);
    }
  }

  if (positional.length > 1) {
    usageError(`unexpected argument '${positional[1]}'`);
  }
  if (positional[0]) {
    options.project = positional[0];
  }
  return options;
}

function splitFlags(value: string): string[] {
  return value.split(/\s+/).filter((part) => part.length > 0);
}

function findProjectRoot(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "manifest.json"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function projectRoot(options: CliOptions): string {
  const root = options.project ?? findProjectRoot(process.cwd());
  if (!root) {
    usageError("no project found; pass a project directory or run inside a project");
  }
  return resolve(root);
}

function loadProject(options: CliOptions): LoadedProject {
  const root = projectRoot(options);
  const manifest = loadManifest(root);
  const coplPath = [...options.coplPath, ...defaultModuleRoots()];
  const project = resolveProject(manifest, {
    entryName: options.entry,
    coplPath,
  });
  const model = analyzeProject(project);
  return { root, manifest, project, model };
}

function colorize(options: CliOptions, code: string, text: string): string {
  return options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

function printDiagnostics(diagnostics: readonly Diagnostic[], options: CliOptions): void {
  for (const diagnostic of diagnostics) {
    console.error(
      colorize(
        options,
        diagnostic.severity === "error" ? "31" : "33",
        formatDiagnostic(diagnostic),
      ),
    );
    if (diagnostic.span) {
      try {
        const source = readFileSync(diagnostic.span.file, "utf8").split("\n");
        const line = source[diagnostic.span.start.line - 1];
        if (line !== undefined) {
          console.error(`  ${line}`);
          console.error(
            `  ${" ".repeat(Math.max(0, diagnostic.span.start.column - 1))}^`,
          );
        }
      } catch {
      }
    }
  }
}

function outputJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function runCheck(options: CliOptions): number {
  const loaded = loadProject(options);
  const workers = resolveWorkerCount(loaded.manifest);
  if (options.json) {
    outputJson({
      command: "check",
      entry: loaded.project.entryName,
      entryPath: loaded.project.entryPath,
      files: loaded.project.files.length,
      workers,
    });
    return 0;
  }
  if (!options.quiet) {
    console.log(
      `checked ${loaded.project.files.length} file(s); entry '${loaded.project.entryName}' -> ${loaded.project.entryPath}`,
    );
    console.log(
      `workers: default=${loaded.manifest.defaultWorkers}, resolved=${workers}${loaded.manifest.workersEnvVar ? ` (env ${loaded.manifest.workersEnvVar})` : ""}`,
    );
  }
  return 0;
}

function runBuild(options: CliOptions): number {
  const loaded = loadProject(options);
  const result = buildProject(loaded.project, loaded.model, {
    outDir: options.outDir,
    executableName: options.name,
    cc: options.cc,
    cflags: options.cflags,
    ldflags: options.ldflags,
  });
  if (options.json) {
    outputJson({
      command: "build",
      source: result.sourcePath,
      executable: result.executablePath,
    });
    return 0;
  }
  if (!options.quiet) {
    console.log(`emitted ${result.sourcePath}`);
    console.log(
      `built ${loaded.manifest.name ?? loaded.project.entryName} -> ${result.executablePath}`,
    );
  }
  return 0;
}

function runEmit(options: CliOptions): number {
  const loaded = loadProject(options);
  process.stdout.write(generateC(loaded.project, loaded.model).code);
  return 0;
}

function runRun(options: CliOptions): number {
  const loaded = loadProject(options);
  const result = buildProject(loaded.project, loaded.model, {
    outDir: options.outDir,
    executableName: options.name,
    cc: options.cc,
    cflags: options.cflags,
    ldflags: options.ldflags,
  });
  if (!options.quiet) {
    console.error(`built ${result.executablePath}`);
  }
  const run = spawnSync(result.executablePath, options.programArgs, {
    stdio: "inherit",
  });
  return run.status ?? 1;
}

function runClean(options: CliOptions): number {
  const root = projectRoot(options);
  loadManifest(root);
  const outDir = options.outDir ?? join(root, "build");
  rmSync(outDir, { recursive: true, force: true });
  if (!options.quiet) {
    console.log(`removed ${outDir}`);
  }
  return 0;
}

function runInit(options: CliOptions): number {
  const root = resolve(options.project ?? process.cwd());
  const manifestPath = join(root, "manifest.json");
  if (existsSync(manifestPath)) {
    usageError(`manifest already exists at ${manifestPath}`);
  }
  const name = basename(root).replace(/[^A-Za-z0-9_.-]/g, "_") || "app";
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        defaultEntry: "app",
        entries: { app: "src/main.copl" },
        defaultWorkers: 1,
        linkerFlags: [],
        cc: "cc",
      },
      null,
      2,
    ) + "\n",
  );
  const main = join(root, "src", "main.copl");
  if (!existsSync(main)) {
    writeFileSync(
      main,
      [
        "public class App {",
        "    public App() { }",
        "",
        "    public int run(int[] args) {",
        "        return 0;",
        "    }",
        "}",
        "",
      ].join("\n"),
    );
  }
  if (!options.quiet) {
    console.log(`initialized ${root}`);
  }
  return 0;
}

async function runLsp(): Promise<number> {
  await new LanguageServer().run();
  return 0;
}

function helpText(): string {
  return USAGE;
}

function exitCodeFor(error: CoplError): number {
  if (error.diagnostics.some((diagnostic) => diagnostic.code === "usage")) {
    return 2;
  }
  if (error.diagnostics.some((diagnostic) => diagnostic.code === "build")) {
    return 4;
  }
  return 1;
}

async function main(argv: readonly string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CoplError) {
      console.error(formatDiagnostics(error.diagnostics));
      return 2;
    }
    throw error;
  }
  if (options.version) {
    console.log(VERSION);
    return 0;
  }
  if (options.help || options.command === "help" || options.command === "--help") {
    console.log(helpText());
    return 0;
  }

  try {
    switch (options.command) {
      case "check":
        return runCheck(options);
      case "build":
        return runBuild(options);
      case "emit-c":
        return runEmit(options);
      case "run":
        return runRun(options);
      case "clean":
        return runClean(options);
      case "init":
        return runInit(options);
      case "lsp":
        return await runLsp();
      case "version":
        console.log(VERSION);
        return 0;
      default:
        usageError(`unknown command '${options.command}'`);
    }
  } catch (error) {
    if (error instanceof CoplError) {
      if (options.json) {
        outputJson({
          command: options.command,
          error: error.diagnostics.map((diagnostic) => ({
            message: diagnostic.message,
            code: diagnostic.code,
            severity: diagnostic.severity,
            file: diagnostic.span?.file,
            line: diagnostic.span?.start.line,
            column: diagnostic.span?.start.column,
          })),
        });
      } else {
        printDiagnostics(error.diagnostics, options);
      }
      return exitCodeFor(error);
    }
    throw error;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 3;
  });
