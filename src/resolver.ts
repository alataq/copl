import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import type * as ast from "./ast";
import { CoplError } from "./diagnostics";
import { loadManifest, resolveEntry, type Environment, type LoadedManifest } from "./manifest";
import { parseSourceUnit } from "./parser/parser";
import { sourceFile } from "./source";

export interface ProjectFile {
  readonly path: string;
  readonly unit: ast.SourceUnit;
}

export interface ResolvedProject {
  readonly manifest: LoadedManifest;
  readonly entryName: string;
  readonly entryPath: string;
  readonly files: readonly ProjectFile[];
  readonly units: ReadonlyMap<string, ast.SourceUnit>;
  readonly importGraph: ReadonlyMap<string, readonly string[]>;
}

export interface ResolveOptions {
  readonly env?: Environment;
  readonly coplPath?: readonly string[];
  readonly entryName?: string;
  readonly overlays?: ReadonlyMap<string, string>;
}

function defaultCoplPath(env: Environment): string[] {
  const raw = env.COPL_PATH;
  if (!raw) {
    return [];
  }
  return raw.split(delimiter).filter((entry) => entry.length > 0);
}

function resolveImportPath(
  root: string,
  declaration: ast.ImportDecl,
  coplPath: readonly string[],
): string {
  const candidates: string[] = [];

  if (declaration.isLocal) {
    const localSegments = declaration.segments.slice(1);
    if (localSegments.length === 0) {
      throw new CoplError(
        "local import must name a file",
        declaration.span,
        "import",
      );
    }
    candidates.push(join(root, "src", ...localSegments) + ".copl");
  } else {
    candidates.push(join(root, "modules", ...declaration.segments) + ".copl");
    for (const base of coplPath) {
      candidates.push(join(base, ...declaration.segments) + ".copl");
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return resolve(candidate);
    }
  }

  const importName = declaration.segments.join(".");
  throw new CoplError(
    `cannot resolve import '${importName}'; searched: ${candidates.map((path) => relative(root, path)).join(", ")}`,
    declaration.span,
    "import",
  );
}

export function resolveProject(
  manifest: LoadedManifest,
  options: ResolveOptions = {},
): ResolvedProject {
  const env = options.env ?? process.env;
  const coplPath = options.coplPath ?? defaultCoplPath(env);
  const entry = options.entryName
    ? manifest.entries.get(options.entryName)
    : resolveEntry(manifest, env);
  if (!entry) {
    const known = [...manifest.entries.keys()].join(", ");
    throw new CoplError(
      `unknown entry '${options.entryName}'; valid entries: ${known}`,
      undefined,
      "entry",
    );
  }
  const root = manifest.root;

  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const files: ProjectFile[] = [];
  const units = new Map<string, ast.SourceUnit>();
  const importGraph = new Map<string, readonly string[]>();

  const visit = (filePath: string, fromSpan?: ast.Node["span"]): void => {
    const canonical = resolve(filePath);
    const status = state.get(canonical);
    if (status === "visiting") {
      const cycleStart = stack.indexOf(canonical);
      const chain = [...stack.slice(cycleStart), canonical]
        .map((path) => relative(root, path))
        .join(" -> ");
      throw new CoplError(
        `circular file import: ${chain}`,
        fromSpan,
        "import-cycle",
      );
    }
    if (status === "done") {
      return;
    }

    state.set(canonical, "visiting");
    stack.push(canonical);

    let text = options.overlays?.get(canonical);
    if (text === undefined) {
      try {
        text = readFileSync(canonical, "utf8");
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CoplError(
          `cannot read '${relative(root, canonical)}': ${detail}`,
          fromSpan,
          "import",
        );
      }
    }

    const unit = parseSourceUnit(sourceFile(canonical, text));
    const dependencies: string[] = [];
    for (const declaration of unit.imports) {
      const dependency = resolveImportPath(root, declaration, coplPath);
      dependencies.push(dependency);
      visit(dependency, declaration.span);
    }

    importGraph.set(canonical, dependencies);
    units.set(canonical, unit);
    stack.pop();
    state.set(canonical, "done");
    files.push({ path: canonical, unit });
  };

  visit(entry.absolutePath);

  const declarations = new Map<
    string,
    { readonly file: string; readonly span: ast.Node["span"]; readonly kind: string }
  >();
  for (const file of files) {
    for (const namespace of file.unit.namespaces) {
      const namespaceName = namespace.name.join("::");
      for (const member of namespace.members) {
        const key = namespaceName.length > 0
          ? `${namespaceName}::${member.name}`
          : member.name;
        const previous = declarations.get(key);
        if (previous) {
          throw new CoplError(
            `duplicate ${member.kind === "ClassDecl" ? "class" : "interface"} '${key}'; already declared at ${relative(root, previous.file)}`,
            member.span,
            "duplicate-type",
          );
        }
        declarations.set(key, {
          file: file.path,
          span: member.span,
          kind: member.kind,
        });
      }
    }
  }

  return {
    manifest,
    entryName: entry.name,
    entryPath: entry.absolutePath,
    files,
    units,
    importGraph,
  };
}

export function resolveProjectFromRoot(
  rootDir: string,
  options: ResolveOptions = {},
): ResolvedProject {
  return resolveProject(loadManifest(rootDir), options);
}
