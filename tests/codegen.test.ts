import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProject, generateC } from "../src/codegen";
import { resolveProjectFromRoot } from "../src/resolver";
import { analyzeProject } from "../src/sema/checker";

const fixtureRoot = join(import.meta.dir, "fixtures/project");
const ccAvailable = spawnSync("cc", ["--version"]).status === 0;
const buildTest = ccAvailable ? test : test.skip;

function loadFixture() {
  const project = resolveProjectFromRoot(fixtureRoot, {
    env: { FIXTURE_ENTRY: "app" },
  });
  const model = analyzeProject(project);
  return { project, model };
}

describe("C11 code generation", () => {
  test("emits class, generic, and main scaffolding", () => {
    const { project, model } = loadFixture();
    const generated = generateC(project, model);

    expect(generated.code).toContain("typedef struct copl_app__App copl_app__App;");
    expect(generated.code).toContain("typedef struct copl_app__Vector_int copl_app__Vector_int;");
    expect(generated.code).toContain("int main(int argc, char** argv)");
    expect(generated.code).toContain("copl_args_from_main(argc, argv)");
    expect(generated.linkFlags).toContain("-lm");
  });

  buildTest("builds and runs the fixture executable", () => {
    const { project, model } = loadFixture();
    const outDir = mkdtempSync(join(tmpdir(), "copl-build-"));
    try {
      const result = buildProject(project, model, {
        outDir,
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(1);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
  buildTest("builds and runs the Vector module", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-vector-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "modules", "copl"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "modules", "copl", "vector.copl"),
        readFileSync(
          join(import.meta.dir, "..", "modules", "copl", "vector.copl"),
          "utf8",
        ),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "import copl.vector;",
          "namespace app {",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      std::Vector<int> values = new std::Vector<int>();",
          "      values.add(10);",
          "      values.add(20);",
          "      values.add(30);",
          "      values.remove(20);",
          "      values.__cleanup();",
          "      std::Vector<int> copied = new std::Vector<int>(values);",
          "      return values.getLength() * 10 + copied.getLength();",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(22);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("builds inheritance and static methods", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-inherit-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "namespace app {",
          "  public class Base {",
          "    protected int x;",
          "    public Base() { self.x = 1; }",
          "    public int get() { return self.x; }",
          "  }",
          "  public class Derived extends Base {",
          "    private int y;",
          "    public Derived() { super(); self.y = 2; }",
          "    public int sum() { return self.get() + self.y; }",
          "  }",
          "  public class Util {",
          "    public static int base;",
          "    public static int add(int a, int b) { return a + b; }",
          "    public Util() { }",
          "  }",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      Derived d = new Derived();",
          "      Util.base = 5;",
          "      return d.sum() + Util.add(Util.base, 1);",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("deep-copies arrays of class references", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-deep-array-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "namespace app {",
          "  public class Box {",
          "    public int value;",
          "    public Box(int value) { self.value = value; }",
          "  }",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      Box[] boxes = new Box[2];",
          "      boxes[0] = new Box(1);",
          "      boxes[1] = new Box(2);",
          "      Box[] copied = copy(boxes);",
          "      boxes[0].value = 99;",
          "      return copied[0].value;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("dispatches interface methods through type IDs", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-interface-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "namespace app {",
          "  public interface Shape {",
          "    public int area();",
          "  }",
          "  public class Square implements Shape {",
          "    private int side;",
          "    public Square(int side) { self.side = side; }",
          "    public int area() { return self.side * self.side; }",
          "  }",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      Shape shape = new Square(3);",
          "      return shape.area();",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(9);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("deep-copies arrays of arrays", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-nested-array-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "namespace app {",
          "  public class Box {",
          "    public int value;",
          "    public Box(int value) { self.value = value; }",
          "  }",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      Box[][] grid = [[new Box(1)]];",
          "      Box[][] copied = copy(grid);",
          "      grid[0][0].value = 99;",
          "      return copied[0][0].value;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("runs tasks with probes and implicit joins", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-task-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "namespace app {",
          "  public class Main {",
          "    public Main() { }",
          "    public int work(int value) { return value * 2; }",
          "    public int run(int[] args) {",
          "      Task<int> task = &work(4);",
          "      while(! &task) { }",
          "      int result = task;",
          "      int direct = &work(3);",
          "      Task<int> dedicated = &2work(5);",
          "      int dedicatedResult = dedicated;",
          "      &work(1);",
          "      return result + direct + dedicatedResult;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(24);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("collects unreachable class objects", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-gc-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "namespace app {",
          "  public class Box {",
          "    public int value;",
          "    public Box(int value) { self.value = value; }",
          "  }",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      int total = 0;",
          "      for(int i = 0; i < 5000; i = i + 1) {",
          "        Box box = new Box(i);",
          "        total = total + box.value;",
          "      }",
          "      return total % 200;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("builds and runs String overloads", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-string-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "modules", "copl"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "modules", "copl", "vector.copl"),
        readFileSync(
          join(import.meta.dir, "..", "modules", "copl", "vector.copl"),
          "utf8",
        ),
      );
      writeFileSync(
        join(root, "modules", "copl", "string.copl"),
        readFileSync(
          join(import.meta.dir, "..", "modules", "copl", "string.copl"),
          "utf8",
        ),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "import copl.string;",
          "namespace app {",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      std::String a = new std::String('a');",
          "      std::String b = new std::String(\"bc\");",
          "      std::String c = a.concat('d').concat(\"ef\").concat(b);",
          "      std::String sub = c.substring(1, 4);",
          "      std::String empty = new std::String();",
          "      if(!c.equals(\"adefbc\")) { return 0; }",
          "      if(sub.getLength() != 3) { return 0; }",
          "      if(sub.charAt(0) != 'd') { return 0; }",
          "      if(!empty.isEmpty()) { return 0; }",
          "      if(!String.format(\"v=%d\", 42).equals(\"v=42\")) { return 0; }",
          "      if(!String.format(\"%c\", 'x').equals(\"x\")) { return 0; }",
          "      if(!String.format(\"%s\", \"hi\").equals(\"hi\")) { return 0; }",
          "      if(new String(\"-12\").toInt() != -12) { return 0; }",
          "      if(new String(\"1.5\").toFloat() != 1.5) { return 0; }",
          "      if(!String.format(\"%d %u %c %b %f %s %%\", 42, uint(7), 'x', true, 1.5, \"ok\").equals(\"42 7 x true 1.500000 ok %\")) { return 0; }",
          "      return c.getLength();",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(6);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("builds and runs Console overloads and readLine", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-console-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "modules", "copl", "io"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      for (const module of ["vector.copl", "string.copl"]) {
        writeFileSync(
          join(root, "modules", "copl", module),
          readFileSync(
            join(import.meta.dir, "..", "modules", "copl", module),
            "utf8",
          ),
        );
      }
      writeFileSync(
        join(root, "modules", "copl", "io", "console.copl"),
        readFileSync(
          join(import.meta.dir, "..", "modules", "copl", "io", "console.copl"),
          "utf8",
        ),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "import copl.io.console;",
          "namespace app {",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      Console.print('a');",
          "      Console.print(\"bc\");",
          "      std::String text = new std::String(\"de\");",
          "      Console.println(text);",
          "      Console.printf(\"v=%d\\n\", 7);",
          "      Console.printf(\"c=%c\\n\", 'x');",
          "      Console.printf(\"s=%s\\n\", \"ok\");",
          "      Console.printf(\"%d %s\\n\", 9, \"ok\");",
          "      Console.flush();",
          "      std::String? line = Console.readLine();",
          "      if(line != null) {",
          "        Console.println(line);",
          "        return line.getLength();",
          "      }",
          "      return 0;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], {
        encoding: "utf8",
        input: "hello\n",
      });
      expect(run.status).toBe(5);
      expect(run.stdout).toContain("abcde\nv=7\nc=x\ns=ok\n9 ok\nhello\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("handles blank lines and EOF in Console.readLine", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-console-eof-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "modules", "copl", "io"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      for (const module of ["vector.copl", "string.copl"]) {
        writeFileSync(
          join(root, "modules", "copl", module),
          readFileSync(
            join(import.meta.dir, "..", "modules", "copl", module),
            "utf8",
          ),
        );
      }
      writeFileSync(
        join(root, "modules", "copl", "io", "console.copl"),
        readFileSync(
          join(import.meta.dir, "..", "modules", "copl", "io", "console.copl"),
          "utf8",
        ),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "import copl.io.console;",
          "namespace app {",
          "  public class Main {",
          "    public Main() { }",
          "    public int run(int[] args) {",
          "      std::String? blank = Console.readLine();",
          "      if(blank != null) {",
          "        if(blank.getLength() != 0) { return 2; }",
          "        std::String? eof = Console.readLine();",
          "        if(eof != null) { return 3; }",
          "        return 0;",
          "      }",
          "      return 1;",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], {
        encoding: "utf8",
        input: "\n",
      });
      expect(run.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("builds C-style variadic user methods", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-vararg-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "namespace app {",
          "  public class Main {",
          "    public Main() { }",
          "    public int sum(int count, ...) {",
          "      int total = 0;",
          "      for(int i = 0; i < count; i++) { total = total + va_int(); }",
          "      return total;",
          "    }",
          "    public int run(int[] args) {",
          "      return self.sum(3, 10, 20, 30);",
          "    }",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(60);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  buildTest("builds C-style enums", () => {
    const root = mkdtempSync(join(tmpdir(), "copl-enum-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "manifest.json"),
        JSON.stringify({
          defaultEntry: "app",
          entries: { app: "src/main.copl" },
        }),
      );
      writeFileSync(
        join(root, "src", "main.copl"),
        [
          "enum Code { A = 5, B, C = 2, D }",
          "public class Main {",
          "  public Main() { }",
          "  public int run(int[] args) {",
          "    Code code = Code.B;",
          "    if(code == Code.B) {",
          "      return int(Code.A) + int(Code.B) + int(Code.D);",
          "    }",
          "    return 0;",
          "  }",
          "}",
        ].join("\n"),
      );
      const project = resolveProjectFromRoot(root, { env: {} });
      const model = analyzeProject(project);
      const result = buildProject(project, model, {
        outDir: join(root, "build"),
        executableName: "app",
      });
      const run = spawnSync(result.executablePath, [], { encoding: "utf8" });
      expect(run.status).toBe(14);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
