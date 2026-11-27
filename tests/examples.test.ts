import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProject } from "../src/codegen";
import { resolveProjectFromRoot } from "../src/resolver";
import { analyzeProject } from "../src/sema/checker";

const repoRoot = join(import.meta.dir, "..");
const exampleRoot = join(repoRoot, "examples", "taskboard");
const modulesRoot = join(repoRoot, "modules");
const ccAvailable = spawnSync("cc", ["--version"]).status === 0;
const buildTest = ccAvailable ? test : test.skip;

describe("example projects", () => {
  buildTest("builds and runs examples/taskboard", () => {
    const outDir = mkdtempSync(join(tmpdir(), "copl-taskboard-"));
    try {
      const project = resolveProjectFromRoot(exampleRoot, {
        env: {},
        coplPath: [modulesRoot],
      });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir,
        executableName: "taskboard",
      });
      const input = [
        "add 5 Buy milk",
        "add 2 Write docs",
        "list",
        "done 1",
        "stats",
        "worker",
        "gc",
        "exit",
        "",
      ].join("\n");
      const run = spawnSync(result.executablePath, [], {
        encoding: "utf8",
        input,
      });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("worker score=42");
      expect(run.stdout).toContain("priority total=7");
      expect(run.stdout).toContain("__cleanup triggered by GC");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
