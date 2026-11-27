import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AttributeDecl,
  ClassDecl,
  ForStmt,
  MethodDecl,
  NamedType,
  VarDeclStmt,
  WorkerCallExpr,
} from "../src/ast";
import { parseSourceUnit } from "../src/parser/parser";
import { sourceFile } from "../src/source";

const fixture = join(import.meta.dir, "fixtures/project/src/app.copl");

describe("parser", () => {
  test("parses the full Phase 1 fixture", () => {
    const path = fixture;
    const unit = parseSourceUnit(sourceFile(path, readFileSync(path, "utf8")));

    expect(unit.imports.map((entry) => entry.segments.join("."))).toEqual([
      "local.math.figures",
      "copl.io",
    ]);
    expect(unit.cIncludes[0]!.header).toBe("stdio.h");
    expect(unit.cLinks[0]!.flag).toBe("-lm");
    expect(unit.cInlines[0]!.code).toContain("copl_double");

    const appNamespace = unit.namespaces.find(
      (namespace) => namespace.name.join("::") === "app",
    )!;
    expect(appNamespace).toBeDefined();

    const app = appNamespace.members[0] as ClassDecl;
    expect(app.kind).toBe("ClassDecl");
    expect(app.name).toBe("App");
    expect(app.isFinal).toBe(true);
    expect(app.isExtern).toBe(false);
    expect(app.typeParams).toHaveLength(0);

    const constructor = app.members.find(
      (member) => member.kind === "ConstructorDecl",
    )!;
    expect(constructor.kind).toBe("ConstructorDecl");
    expect(constructor.visibility).toBe("public");

    const run = app.members.find(
      (member) => member.kind === "MethodDecl" && member.name === "run",
    ) as MethodDecl;
    expect(run.visibility).toBe("public");
    expect(run.returnType.kind).toBe("PrimitiveType");
    expect(run.params[0]!.type.kind).toBe("ArrayType");

    const vectorDecl = run.body!.statements[0] as VarDeclStmt;
    expect(vectorDecl.kind).toBe("VarDeclStmt");
    const vectorType = vectorDecl.type as NamedType;
    expect(vectorType.kind).toBe("NamedType");
    expect(vectorType.name).toEqual(["Vector"]);
    expect(vectorType.typeArgs).toHaveLength(1);
    expect(vectorType.typeArgs[0]!.kind).toBe("PrimitiveType");

    const forStatement = run.body!.statements.find(
      (statement) => statement.kind === "ForStmt",
    ) as ForStmt;
    expect(forStatement.initializer?.kind).toBe("VarDeclStmt");
    expect(forStatement.condition?.kind).toBe("BinaryExpr");
    expect(forStatement.update?.kind).toBe("AssignStmt");

    const workerStatements = run.body!.statements.filter(
      (statement) => statement.kind === "ExprStmt",
    );
    const workerCalls = workerStatements
      .map((statement) => statement.expression)
      .filter((expression): expression is WorkerCallExpr => expression.kind === "WorkerCallExpr");
    expect(workerCalls.map((call) => [call.method, call.workers])).toEqual([
      ["work", undefined],
      ["work2", 2],
    ]);
  });

  test("parses qualified type names and generic arguments", () => {
    const text = [
      "namespace demo {",
      "  public class Holder {",
      "    private copl::io::File file;",
      "    private Box<Vector<int>> box;",
      "    public Holder(copl::io::File file) { self.file = file; }",
      "    public Box<Vector<int>> get() { return self.box; }",
      "  }",
      "}",
    ].join("\n");
    const unit = parseSourceUnit(sourceFile("demo.copl", text));
    const holder = unit.namespaces[0]!.members[0] as ClassDecl;
    const fileAttribute = holder.members[0] as AttributeDecl;
    expect((fileAttribute.type as NamedType).name).toEqual(["copl", "io", "File"]);

    const boxAttribute = holder.members[1] as AttributeDecl;
    const boxType = boxAttribute.type as NamedType;
    expect(boxType.name).toEqual(["Box"]);
    expect(boxType.typeArgs[0]!.kind).toBe("NamedType");
  });

  test("requires visibility on class members", () => {
    const text = "namespace n { public class C { int value; } }";
    expect(() => parseSourceUnit(sourceFile("bad.copl", text))).toThrow(
      /visibility modifier required/,
    );
  });

  test("rejects missing method bodies unless extern", () => {
    const text = "namespace n { public class C { public int f(); } }";
    expect(() => parseSourceUnit(sourceFile("bad.copl", text))).toThrow(
      /method body is required/,
    );
  });

  test("parses extern classes for C interop", () => {
    const text = [
      "namespace copl::io {",
      "  public extern class C {",
      "    public extern static int puts(char[] text);",
      "  }",
      "}",
    ].join("\n");
    const unit = parseSourceUnit(sourceFile("io.copl", text));
    const namespace = unit.namespaces[0]!;
    expect(namespace.name).toEqual(["copl", "io"]);
    const externClass = namespace.members[0] as ClassDecl;
    expect(externClass.isExtern).toBe(true);
    const method = externClass.members[0] as MethodDecl;
    expect(method.isExtern).toBe(true);
    expect(method.isStatic).toBe(true);
    expect(method.body).toBeUndefined();
  });
  test("parses top-level classes without a namespace", () => {
    const text = [
      "public class Item {",
      "  public Item() { }",
      "}",
      "public interface Loader {",
      "  public int load();",
      "}",
    ].join("\n");
    const unit = parseSourceUnit(sourceFile("top.copl", text));
    expect(unit.namespaces).toHaveLength(1);
    expect(unit.namespaces[0]!.name).toEqual([]);
    expect(unit.namespaces[0]!.members.map((member) => member.name)).toEqual([
      "Item",
      "Loader",
    ]);
  });

});
