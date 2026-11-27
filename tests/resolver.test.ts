import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveProjectFromRoot } from "../src/resolver";

const fixtureRoot = join(import.meta.dir, "fixtures/project");

function withTempProject(
  files: Readonly<Record<string, string>>,
  run: (root: string) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "copl-resolver-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("resolver", () => {
  test("resolves local and module imports in dependency order", () => {
    const project = resolveProjectFromRoot(fixtureRoot, {
      env: { FIXTURE_ENTRY: "app" },
    });

    expect(project.entryName).toBe("app");
    expect(project.files).toHaveLength(3);
    expect(project.files.at(-1)!.path).toBe(
      resolve(fixtureRoot, "src/app.copl"),
    );

    const ioFile = project.files.find((file) =>
      file.path.endsWith(join("modules", "copl", "io.copl")),
    );
    expect(ioFile).toBeDefined();
    expect(
      ioFile!.unit.namespaces.some(
        (namespace) => namespace.name.join("::") === "copl::io",
      ),
    ).toBe(true);
  });

  test("honors an explicit entry override", () => {
    const project = resolveProjectFromRoot(fixtureRoot, { entryName: "tool" });
    expect(project.entryName).toBe("tool");
    expect(project.files).toHaveLength(1);
    expect(project.files[0]!.path).toBe(resolve(fixtureRoot, "src/tool.copl"));
  });

  test("detects circular file imports", () => {
    withTempProject(
      {
        "manifest.json": JSON.stringify({
          defaultEntry: "a",
          entries: { a: "src/a.copl" },
        }),
        "src/a.copl": "import local.b;\nnamespace a { public class A { public A() {} } }\n",
        "src/b.copl": "import local.a;\nnamespace b { public class B { public B() {} } }\n",
      },
      (root) => {
        expect(() => resolveProjectFromRoot(root, { env: {} })).toThrow(
          /circular file import/,
        );
      },
    );
  });

  test("detects duplicate class names in the same namespace", () => {
    withTempProject(
      {
        "manifest.json": JSON.stringify({
          defaultEntry: "a",
          entries: { a: "src/a.copl" },
        }),
        "src/a.copl": [
          "import local.b;",
          "namespace shared { public class Thing { public Thing() {} } }",
        ].join("\n"),
        "src/b.copl": [
          "namespace shared { public class Thing { public Thing() {} } }",
        ].join("\n"),
      },
      (root) => {
        expect(() => resolveProjectFromRoot(root, { env: {} })).toThrow(
          /duplicate class 'shared::Thing'/,
        );
      },
    );
  });

  test("reports unresolved imports with the searched paths", () => {
    withTempProject(
      {
        "manifest.json": JSON.stringify({
          defaultEntry: "a",
          entries: { a: "src/a.copl" },
        }),
        "src/a.copl": "import local.missing.file;\nnamespace a { public class A { public A() {} } }\n",
      },
      (root) => {
        expect(() => resolveProjectFromRoot(root, { env: {} })).toThrow(
          /cannot resolve import 'local.missing.file'/,
        );
      },
    );
  });
});
