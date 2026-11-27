import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CoplError } from "../diagnostics";
import type { ResolvedProject } from "../resolver";
import type { SemanticModel } from "../sema/symbols";
import { generateC, type GeneratedC } from "./c";

export { generateC, type GeneratedC } from "./c";

export interface BuildOptions {
  readonly outDir?: string;
  readonly executableName?: string;
  readonly cc?: string;
  readonly cflags?: readonly string[];
  readonly ldflags?: readonly string[];
}

export interface BuildResult {
  readonly sourcePath: string;
  readonly executablePath: string;
  readonly generated: GeneratedC;
}

function sanitizeFile(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function uniqueFlags(flags: readonly string[]): string[] {
  return [...new Set(flags)];
}

export function buildProject(
  project: ResolvedProject,
  model: SemanticModel,
  options: BuildOptions = {},
): BuildResult {
  const generated = generateC(project, model);
  const outDir = resolve(options.outDir ?? join(project.manifest.root, "build"));
  mkdirSync(outDir, { recursive: true });

  const executableName = sanitizeFile(
    options.executableName ?? project.manifest.name ?? project.entryName,
  );
  const sourcePath = join(outDir, `${executableName}.c`);
  const executablePath = join(outDir, executableName);
  writeFileSync(sourcePath, generated.code, "utf8");

  const compiler = options.cc ?? project.manifest.cc ?? "cc";
  const flags = uniqueFlags([
    ...(options.cflags ?? []),
    "-std=c11",
    "-pthread",
    sourcePath,
    "-o",
    executablePath,
    ...project.manifest.linkerFlags,
    ...generated.linkFlags,
    ...(options.ldflags ?? []),
  ]);
  const result = spawnSync(compiler, flags, {
    cwd: project.manifest.root,
    encoding: "utf8",
  });
  if (result.error) {
    throw new CoplError(
      `failed to run C compiler '${compiler}': ${result.error.message}`,
      undefined,
      "build",
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CoplError(
      `C compiler exited with status ${result.status}${detail ? `:\n${detail}` : ""}`,
      undefined,
      "build",
    );
  }

  return {
    sourcePath,
    executablePath,
    generated,
  };
}
