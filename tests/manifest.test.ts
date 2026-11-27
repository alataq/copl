import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadManifest,
  resolveEntryName,
  resolveWorkerCount,
} from "../src/manifest";

const fixtureRoot = join(import.meta.dir, "fixtures/project");

function withTempProject(
  manifest: unknown,
  run: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "copl-manifest-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/main.copl"), "namespace main {}\n");
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("manifest", () => {
  test("loads entries and worker configuration", () => {
    const manifest = loadManifest(fixtureRoot);
    expect(manifest.name).toBe("fixture");
    expect(manifest.defaultEntry).toBe("app");
    expect(manifest.entryEnvVar).toBe("FIXTURE_ENTRY");
    expect(manifest.defaultWorkers).toBe(2);
    expect(manifest.workersEnvVar).toBe("FIXTURE_WORKERS");
    expect([...manifest.entries.keys()]).toEqual(["app", "tool"]);
    expect(manifest.linkerFlags).toEqual(["-lm"]);
    expect(manifest.cc).toBe("cc");
  });

  test("selects entrypoints by environment variable", () => {
    const manifest = loadManifest(fixtureRoot);
    expect(resolveEntryName(manifest, {})).toBe("app");
    expect(resolveEntryName(manifest, { FIXTURE_ENTRY: "tool" })).toBe("tool");
    expect(() =>
      resolveEntryName(manifest, { FIXTURE_ENTRY: "missing" }),
    ).toThrow(/unknown entry 'missing'/);
  });

  test("validates and falls back for worker counts", () => {
    const manifest = loadManifest(fixtureRoot);
    expect(resolveWorkerCount(manifest, {})).toBe(2);
    expect(resolveWorkerCount(manifest, { FIXTURE_WORKERS: "8" })).toBe(8);
    expect(resolveWorkerCount(manifest, { FIXTURE_WORKERS: "0" })).toBe(2);
    expect(resolveWorkerCount(manifest, { FIXTURE_WORKERS: "-3" })).toBe(2);
    expect(resolveWorkerCount(manifest, { FIXTURE_WORKERS: "nope" })).toBe(2);
  });

  test("rejects non-positive defaultWorkers", () => {
    withTempProject(
      {
        defaultEntry: "main",
        entries: { main: "src/main.copl" },
        defaultWorkers: 0,
      },
      (root) => {
        expect(() => loadManifest(root)).toThrow(/defaultWorkers/);
      },
    );
  });

  test("rejects unknown default entries", () => {
    withTempProject(
      {
        defaultEntry: "missing",
        entries: { main: "src/main.copl" },
      },
      (root) => {
        expect(() => loadManifest(root)).toThrow(/defaultEntry/);
      },
    );
  });

  test("rejects invalid entry environment variable names", () => {
    withTempProject(
      {
        defaultEntry: "main",
        entries: { main: "src/main.copl" },
        entryEnvVar: "not valid",
      },
      (root) => {
        expect(() => loadManifest(root)).toThrow(/entryEnvVar/);
      },
    );
  });
});
