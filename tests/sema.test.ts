import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSourceUnit } from "../src/parser/parser";
import { resolveProjectFromRoot } from "../src/resolver";
import { analyzeProject, analyzeUnits } from "../src/sema/checker";
import { sourceFile } from "../src/source";

const fixtureRoot = join(import.meta.dir, "fixtures/project");

function checkSource(text: string) {
  const unit = parseSourceUnit(sourceFile("test.copl", text));
  return analyzeUnits([{ path: "test.copl", unit }]);
}

describe("semantic checker", () => {
  test("checks the fixture project and builds a symbol table", () => {
    const project = resolveProjectFromRoot(fixtureRoot, {
      env: { FIXTURE_ENTRY: "app" },
    });
    const model = analyzeProject(project);

    expect([...model.symbols.keys()].sort()).toEqual([
      "app::App",
      "app::Vector",
      "copl::io::C",
      "math::Circle",
      "math::Figure",
      "math::Shape",
    ]);
    expect(model.symbols.get("app::App")!.methods.get("run")).toHaveLength(1);
    expect(model.symbols.get("app::Vector")!.typeParams).toHaveLength(1);
  });

  test("requires instance attributes to be accessed through self", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    private int x;",
      "    public C() { self.x = 0; }",
      "    public int get() { return x; }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/must be accessed through 'self'/);
  });

  test("requires constructors to initialize all attributes", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    private int x;",
      "    public C() { }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/does not initialize attribute/);
  });

  test("rejects member access on nullable values without narrowing", () => {
    const text = [
      "namespace n {",
      "  public class Box {",
      "    public int value;",
      "    public Box() { self.value = 1; }",
      "  }",
      "  public class C {",
      "    public int read(Box? box) { return box.value; }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/nullable type/);
  });

  test("supports sized arrays, fills, spread, and copy", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public int[] build() {",
      "      int[4] xs = [...0];",
      "      int[] ys = [xs, ...0];",
      "      return copy(ys);",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).not.toThrow();
  });

  test("rejects non-worker-safe worker arguments", () => {
    const text = [
      "namespace n {",
      "  public class Payload { public Payload() { } }",
      "  public class C {",
      "    public void work(Payload payload) { }",
      "    public void run() {",
      "      Payload payload = new Payload();",
      "      &work(payload);",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/non-worker-safe/);
  });

  test("supports internal members with runtime-internal names", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    private int value;",
      "    public C() { self.value = 0; }",
      "    internal __cleanup() { self.value = 0; }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).not.toThrow();
  });

  test("rejects classes that do not implement an interface", () => {
    const text = [
      "namespace n {",
      "  public interface Reader { public int read(); }",
      "  public class C implements Reader { public C() { } }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/does not implement 'read'/);
  });
  test("checks the Vector module with occupied-slot cleanup", () => {
    const path = join(import.meta.dir, "..", "modules", "copl", "vector.copl");
    const unit = parseSourceUnit(sourceFile(path, readFileSync(path, "utf8")));
    expect(() => analyzeUnits([{ path, unit }])).not.toThrow();
  });

  test("narrows nullable values across short-circuit conditions", () => {
    const text = [
      "namespace n {",
      "  public class Box {",
      "    public int value;",
      "    public Box() { self.value = 1; }",
      "  }",
      "  public class C {",
      "    public int read(Box? box) {",
      "      if(box != null && box.value > 0) { return box.value; }",
      "      return 0;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).not.toThrow();
  });

  test("checks implicit constructors for definite initialization", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    private int value;",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/does not initialize attribute/);
  });

  test("rejects static attributes accessed through instances", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public static int value;",
      "    public int read() { return self.value; }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/static attribute/);
  });

  test("accepts void pointers for extern C functions", () => {
    const text = [
      "namespace n {",
      "  public extern class C {",
      "    public extern static ptr<void> malloc(uint size);",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).not.toThrow();
  });

  test("reserves double-underscore member names for internals", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public void __bad() { }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/reserved '__' prefix/);
  });

  test("does not flatten nested array literals implicitly", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public int[][] build() {",
      "      int[][] values = [[1], [2, 3]];",
      "      return values;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).not.toThrow();
  });

  test("rejects negative sized-array lengths", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public void build() {",
      "      int[-1] values = [...0];",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/array size cannot be negative/);
  });

  test("rejects worker methods that capture self", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    private int value;",
      "    public C() { self.value = 0; }",
      "    public void work() { self.value++; }",
      "    public void run() { &work(); }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/worker-safe/);
  });

  test("requires explicit super in subclass constructors", () => {
    const text = [
      "namespace n {",
      "  public class Base {",
      "    public Base() { }",
      "  }",
      "  public class Derived extends Base {",
      "    public Derived() { }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/super\(\.\.\.\)/);
  });

  test("rejects nullable primitive types", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public int read(int? value) { return 0; }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/nullable types are only supported/);
  });

  test("resolves overloaded methods by parameter types", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public int f(int value) { return value; }",
      "    public int f(char value) { return 1; }",
      "    public int f(int[] value) { return 2; }",
      "    public int run() { return self.f(7) + self.f('a') + self.f([1]); }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).not.toThrow();
  });

  test("rejects duplicate overloaded method signatures", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public int f(int value) { return value; }",
      "    public int f(int other) { return other; }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/duplicate method signature/);
  });

  test("supports C-style variadic user methods", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public int sum(int count, ...) {",
      "      int total = 0;",
      "      for(int i = 0; i < count; i++) { total = total + va_int(); }",
      "      return total;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).not.toThrow();
  });

  test("rejects variadic access outside a variadic method", () => {
    const text = [
      "namespace n {",
      "  public class C {",
      "    public int bad() { return va_int(); }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).toThrow(/only valid inside a variadic method/);
  });

  test("supports C-style enums", () => {
    const text = [
      "enum Color { Red, Green, Blue }",
      "public class C {",
      "  public int f(Color value) {",
      "    switch(value) {",
      "      case Color.Red: return 1;",
      "      case Color.Green: return 2;",
      "      default: return 3;",
      "    }",
      "  }",
      "}",
    ].join("\n");
    expect(() => checkSource(text)).not.toThrow();
  });

  test("rejects duplicate enum members", () => {
    const text = "enum E { A, A }";
    expect(() => checkSource(text)).toThrow(/duplicate enum member/);
  });

});
