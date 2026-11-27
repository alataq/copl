import type * as ast from "../ast";
import { CoplError } from "../diagnostics";
import type { ResolvedProject } from "../resolver";
import type { Span } from "../source";
import type {
  ClassSemType,
  PrimitiveSemType,
  SemType,
} from "./types";
import {
  BOOL,
  BYTE,
  CHAR,
  FLOAT,
  I32,
  INT,
  NULL,
  U32,
  UINT,
  VOID,
  arrayType,
  classType,
  displayType,
  enumType,
  isBool,
  isInteger,
  isNumeric,
  isVoid,
  metaType,
  nullableType,
  pointerType,
  primitiveType,
  taskType,
  typeKey,
  typeParamType,
  typesEqual,
} from "./types";
import type {
  ConstructorResolution,
  ConstructorSymbol,
  FieldSymbol,
  MethodResolution,
  MethodSymbol,
  ParamSymbol,
  SemanticModel,
  TypeParamSymbol,
  TypeSymbol,
} from "./symbols";

export interface SourceUnitFile {
  readonly path: string;
  readonly unit: ast.SourceUnit;
}

interface VarInfo {
  readonly name: string;
  readonly type: SemType;
  readonly isFinal: boolean;
  readonly span: Span;
}

interface Scope {
  readonly parent?: Scope;
  readonly vars: Map<string, VarInfo>;
}

interface FunctionContext {
  readonly owner: TypeSymbol;
  readonly returnType: SemType;
  readonly isStatic: boolean;
  readonly isConstructor: boolean;
  readonly isVariadic: boolean;
  scopes: Scope[];
  loopDepth: number;
  switchDepth: number;
  readonly initializedFields: Set<string>;
  readonly narrowed: Map<string, SemType>;
  superCalled: boolean;
}

interface FieldLookup {
  readonly field: FieldSymbol;
  readonly type: SemType;
}

interface MethodLookup {
  readonly method: MethodSymbol;
  readonly returnType: SemType;
  readonly params: readonly ParamSymbol[];
}

const VISIBILITY_RANK: Readonly<Record<ast.Visibility, number>> = {
  private: 0,
  protected: 1,
  internal: 2,
  public: 3,
};

function integerFits(value: bigint, name: ast.PrimitiveName): boolean {
  switch (name) {
    case "int":
      return value >= -9223372036854775808n && value <= 9223372036854775807n;
    case "i32":
      return value >= -2147483648n && value <= 2147483647n;
    case "uint":
      return value >= 0n && value <= 18446744073709551615n;
    case "u32":
      return value >= 0n && value <= 4294967295n;
    case "byte":
      return value >= 0n && value <= 255n;
    case "char":
      return value >= 0n && value <= 1114111n;
    default:
      return false;
  }
}

function isIntLiteral(expr: ast.Expr): expr is ast.IntLiteralExpr {
  return expr.kind === "IntLiteralExpr";
}

function isFloatLiteral(expr: ast.Expr): expr is ast.FloatLiteralExpr {
  return expr.kind === "FloatLiteralExpr";
}

function isStringLiteral(expr: ast.Expr): expr is ast.StringLiteralExpr {
  return expr.kind === "StringLiteralExpr";
}

function isNullLiteral(expr: ast.Expr): expr is ast.NullLiteralExpr {
  return expr.kind === "NullLiteralExpr";
}

function cloneScope(scope: Scope): Scope {
  return {
    parent: scope.parent,
    vars: new Map(scope.vars),
  };
}

function cloneContext(context: FunctionContext): FunctionContext {
  return {
    owner: context.owner,
    returnType: context.returnType,
    isStatic: context.isStatic,
    isConstructor: context.isConstructor,
    isVariadic: context.isVariadic,
    scopes: context.scopes.map(cloneScope),
    loopDepth: context.loopDepth,
    switchDepth: context.switchDepth,
    initializedFields: new Set(context.initializedFields),
    narrowed: new Map(context.narrowed),
    superCalled: context.superCalled,
  };
}

function exprKey(expr: ast.Expr): string | undefined {
  switch (expr.kind) {
    case "IdentifierExpr":
      return `id:${expr.name}`;
    case "SelfExpr":
      return "self";
    case "MemberExpr": {
      const object = exprKey(expr.object);
      return object ? `${object}.${expr.member}` : undefined;
    }
    case "IndexExpr": {
      const object = exprKey(expr.object);
      return object ? `${object}[]` : undefined;
    }
    default:
      return undefined;
  }
}

function isSelfFieldAssignment(expr: ast.Expr): expr is ast.MemberExpr {
  return (
    expr.kind === "MemberExpr" &&
    expr.object.kind === "SelfExpr"
  );
}

function containsSelf(node: unknown): boolean {
  if (node === null || typeof node !== "object") {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((value) => containsSelf(value));
  }
  if ((node as { kind?: unknown }).kind === "SelfExpr") {
    return true;
  }
  return Object.values(node).some((value) => containsSelf(value));
}

export class SemanticChecker {
  private readonly symbols = new Map<string, TypeSymbol>();
  private readonly orderedSymbols: TypeSymbol[] = [];
  private readonly files: readonly SourceUnitFile[];
  private readonly expressionTypes = new Map<ast.Expr, SemType>();
  private readonly typeRefs = new Map<ast.TypeRef, SemType>();
  private readonly methodCalls = new Map<ast.CallExpr, MethodResolution>();
  private readonly constructorCalls = new Map<ast.NewObjectExpr, ConstructorResolution>();
  private readonly superConstructorCalls = new Map<ast.CallExpr, ConstructorSymbol>();
  private readonly workerCalls = new Map<ast.WorkerCallExpr, MethodResolution>();

  constructor(files: readonly SourceUnitFile[]) {
    this.files = files;
  }

  analyze(): SemanticModel {
    this.collectSymbols();
    for (const symbol of this.orderedSymbols) {
      this.resolveHeader(symbol);
    }
    this.validateHierarchy();
    for (const symbol of this.orderedSymbols) {
      this.checkTypeBody(symbol);
    }
    return {
      symbols: this.symbols,
      files: this.files.map((file) => file.path),
      expressionTypes: this.expressionTypes,
      typeRefs: this.typeRefs,
      methodCalls: this.methodCalls,
      constructorCalls: this.constructorCalls,
      superConstructorCalls: this.superConstructorCalls,
      workerCalls: this.workerCalls,
    };
  }

  private fail(message: string, span?: Span, code = "sema"): never {
    throw new CoplError(message, span, code);
  }

  private collectSymbols(): void {
    for (const file of this.files) {
      for (const namespace of file.unit.namespaces) {
        const namespaceName = namespace.name.join("::");
        for (const declaration of namespace.members) {
          const key = namespaceName.length > 0
            ? `${namespaceName}::${declaration.name}`
            : declaration.name;
          if (this.symbols.has(key)) {
            this.fail(
              `duplicate type '${key}'`,
              declaration.span,
              "duplicate-type",
            );
          }
          const typeParams: TypeParamSymbol[] = [];
          const seenParams = new Set<string>();
          const declaredParams = declaration.kind === "EnumDecl"
            ? []
            : declaration.typeParams;
          for (const param of declaredParams) {
            if (seenParams.has(param.name)) {
              this.fail(
                `duplicate type parameter '${param.name}'`,
                param.span,
                "type-param",
              );
            }
            seenParams.add(param.name);
            typeParams.push({ name: param.name, span: param.span });
          }
          const symbol: TypeSymbol = {
            kind: declaration.kind === "ClassDecl"
              ? "class"
              : declaration.kind === "InterfaceDecl"
                ? "interface"
                : "enum",
            name: declaration.name,
            namespace: namespace.name,
            qualifiedName: key,
            decl: declaration,
            typeParams,
            enumMembers: new Map(),
            fields: new Map(),
            methods: new Map(),
            constructors: [],
            interfaces: [],
            superClass: undefined,
            isExtern: declaration.kind === "ClassDecl" ? declaration.isExtern : false,
            isFinal: declaration.kind === "ClassDecl" ? declaration.isFinal : false,
            file: file.path,
          };
          this.symbols.set(key, symbol);
          this.orderedSymbols.push(symbol);
        }
      }
    }
  }

  private typeParamMap(type: ClassSemType): Map<string, SemType> {
    const map = new Map<string, SemType>();
    type.symbol.typeParams.forEach((param, index) => {
      const arg = type.args[index];
      map.set(
        `${type.symbol.qualifiedName}::${param.name}`,
        arg ?? typeParamType(type.symbol.qualifiedName, param.name),
      );
    });
    return map;
  }

  private substitute(type: SemType, map: ReadonlyMap<string, SemType>): SemType {
    switch (type.kind) {
      case "typeParam":
        return map.get(`${type.owner}::${type.name}`) ?? type;
      case "class":
        return classType(
          type.symbol,
          type.args.map((arg) => this.substitute(arg, map)),
        );
      case "array":
        return arrayType(this.substitute(type.element, map));
      case "pointer":
        return pointerType(
          type.target ? this.substitute(type.target, map) : undefined,
        );
      case "nullable":
        return nullableType(this.substitute(type.inner, map));
      default:
        return type;
    }
  }

  private selfType(owner: TypeSymbol): ClassSemType {
    return classType(
      owner,
      owner.typeParams.map((param) =>
        typeParamType(owner.qualifiedName, param.name),
      ),
    );
  }

  private lookupTypeSymbol(
    name: readonly string[],
    owner: TypeSymbol,
    span: Span,
  ): TypeSymbol {
    if (name.length === 0) {
      this.fail("empty type name", span, "type-name");
    }
    if (name.length > 1) {
      const key = name.join("::");
      const symbol = this.symbols.get(key);
      if (!symbol) {
        this.fail(`unknown type '${key}'`, span, "type-name");
      }
      return symbol;
    }

    const simple = name[0]!;
    for (let depth = owner.namespace.length; depth >= 0; depth -= 1) {
      const prefix = owner.namespace.slice(0, depth).join("::");
      const key = prefix.length > 0 ? `${prefix}::${simple}` : simple;
      const symbol = this.symbols.get(key);
      if (symbol) {
        return symbol;
      }
    }

    const matches = this.orderedSymbols.filter(
      (symbol) => symbol.name === simple,
    );
    if (matches.length === 1) {
      return matches[0]!;
    }
    if (matches.length > 1) {
      this.fail(
        `ambiguous type '${simple}'; candidates: ${matches.map((symbol) => symbol.qualifiedName).join(", ")}`,
        span,
        "type-name",
      );
    }
    this.fail(`unknown type '${simple}'`, span, "type-name");
  }

  private resolveTypeRef(
    ref: ast.TypeRef,
    owner: TypeSymbol,
    context?: FunctionContext,
    allowVoid = false,
  ): SemType {
    const type = this.inferTypeRef(ref, owner, context, allowVoid);
    this.typeRefs.set(ref, type);
    return type;
  }

  private inferTypeRef(
    ref: ast.TypeRef,
    owner: TypeSymbol,
    context?: FunctionContext,
    allowVoid = false,
  ): SemType {
    switch (ref.kind) {
      case "PrimitiveType": {
        if (ref.name === "void" && !allowVoid) {
          this.fail("'void' is only valid as a return type", ref.span, "type");
        }
        return primitiveType(ref.name);
      }
      case "NamedType": {
        if (ref.name.length === 1 && ref.name[0] === "Task") {
          if (ref.typeArgs.length !== 1) {
            this.fail(
              "built-in 'Task' expects exactly one type argument",
              ref.span,
              "type-args",
            );
          }
          const result = this.resolveTypeRef(
            ref.typeArgs[0]!,
            owner,
            context,
            true,
          );
          if (result.kind === "task") {
            this.fail("tasks cannot contain tasks", ref.span, "type");
          }
          return taskType(result);
        }
        if (ref.name.length === 1) {
          const param = owner.typeParams.find(
            (candidate) => candidate.name === ref.name[0],
          );
          if (param) {
            if (ref.typeArgs.length > 0) {
              this.fail(
                `type parameter '${param.name}' cannot take type arguments`,
                ref.span,
                "type",
              );
            }
            return typeParamType(owner.qualifiedName, param.name);
          }
        }

        const symbol = this.lookupTypeSymbol(ref.name, owner, ref.span);
        const args = ref.typeArgs.map((arg) =>
          this.resolveTypeRef(arg, owner, context),
        );
        if (symbol.kind === "enum") {
          if (args.length > 0) {
            this.fail(
              `enum '${symbol.qualifiedName}' cannot take type arguments`,
              ref.span,
              "type-args",
            );
          }
          return enumType(symbol);
        }
        if (symbol.typeParams.length !== args.length) {
          if (args.length === 0 && symbol === owner) {
            return this.selfType(owner);
          }
          this.fail(
            `type '${symbol.qualifiedName}' expects ${symbol.typeParams.length} type argument(s), got ${args.length}`,
            ref.span,
            "type-args",
          );
        }
        return classType(symbol, args);
      }
      case "PointerType":
        return pointerType(
          ref.target
            ? this.resolveTypeRef(ref.target, owner, context, true)
            : undefined,
        );
      case "ArrayType": {
        const element = this.resolveTypeRef(ref.element, owner, context);
        if (isVoid(element)) {
          this.fail("arrays cannot contain 'void'", ref.span, "type");
        }
        if (ref.size) {
          this.checkArraySize(ref.size, owner, context);
        }
        return arrayType(element);
      }
      case "NullableType": {
        const inner = this.resolveTypeRef(ref.inner, owner, context);
        if (inner.kind === "nullable") {
          this.fail("nested nullable types are not allowed", ref.span, "type");
        }
        if (isVoid(inner)) {
          this.fail("'void' cannot be nullable", ref.span, "type");
        }
        if (inner.kind !== "class" && inner.kind !== "array") {
          this.fail(
            "nullable types are only supported for object references and arrays",
            ref.span,
            "type",
          );
        }
        return nullableType(inner);
      }
    }
  }

  private checkArraySize(
    expr: ast.Expr,
    owner: TypeSymbol,
    context?: FunctionContext,
  ): void {
    if (context) {
      const type = this.valueType(this.checkExpr(expr, INT, context));
      if (!isInteger(type)) {
        this.fail("array size must be an integer", expr.span, "array-size");
      }
      if (
        (isIntLiteral(expr) && expr.value < 0n) ||
        (expr.kind === "UnaryExpr" &&
          expr.op === "-" &&
          expr.operand.kind === "IntLiteralExpr")
      ) {
        this.fail("array size cannot be negative", expr.span, "array-size");
      }
      return;
    }
    if (!isIntLiteral(expr) || expr.value < 0n) {
      this.fail(
        "array size in a type signature must be a non-negative integer literal",
        expr.span,
        "array-size",
      );
    }
  }

  private resolveHeader(symbol: TypeSymbol): void {
    const decl = symbol.decl;
    if (decl.kind === "EnumDecl") {
      let next = 0n;
      const seen = new Set<string>();
      for (const member of decl.members) {
        if (seen.has(member.name)) {
          this.fail(
            `duplicate enum member '${member.name}'`,
            member.span,
            "duplicate-member",
          );
        }
        seen.add(member.name);
        const value = member.value ?? next;
        if (value < -2147483648n || value > 2147483647n) {
          this.fail(
            `enum value for '${member.name}' is outside the C int range`,
            member.span,
            "enum-value",
          );
        }
        symbol.enumMembers.set(member.name, {
          name: member.name,
          value,
          span: member.span,
        });
        next = value + 1n;
      }
      return;
    }
    if (decl.kind === "ClassDecl") {
      if (decl.extends) {
        if (symbol.isExtern) {
          this.fail(
            "extern classes cannot extend another class",
            decl.extends.span,
            "extern",
          );
        }
        const superType = this.resolveTypeRef(decl.extends, symbol);
        if (superType.kind !== "class") {
          this.fail("a class can only extend a class", decl.extends.span, "inherit");
        }
        if (superType.symbol.kind !== "class") {
          this.fail(
            "a class cannot extend an interface",
            decl.extends.span,
            "inherit",
          );
        }
        symbol.superClass = superType;
      }
      for (const implemented of decl.implements) {
        if (symbol.isExtern) {
          this.fail(
            "extern classes cannot implement interfaces",
            implemented.span,
            "extern",
          );
        }
        const interfaceType = this.resolveTypeRef(implemented, symbol);
        if (
          interfaceType.kind !== "class" ||
          interfaceType.symbol.kind !== "interface"
        ) {
          this.fail(
            "'implements' requires an interface",
            implemented.span,
            "inherit",
          );
        }
        symbol.interfaces.push(interfaceType);
      }
    } else {
      for (const extended of decl.extends) {
        const interfaceType = this.resolveTypeRef(extended, symbol);
        if (
          interfaceType.kind !== "class" ||
          interfaceType.symbol.kind !== "interface"
        ) {
          this.fail(
            "an interface can only extend interfaces",
            extended.span,
            "inherit",
          );
        }
        symbol.interfaces.push(interfaceType);
      }
    }

    for (const member of symbol.decl.kind === "ClassDecl"
      ? symbol.decl.members
      : []) {
      if (member.kind === "AttributeDecl") {
        this.resolveAttribute(symbol, member);
      } else if (member.kind === "MethodDecl") {
        this.resolveMethod(symbol, member);
      } else {
        this.resolveConstructor(symbol, member);
      }
    }

    if (symbol.decl.kind === "InterfaceDecl") {
      for (const method of symbol.decl.methods) {
        if (method.visibility !== "public") {
          this.fail(
            "interface methods must be public",
            method.span,
            "visibility",
          );
        }
        if (method.body) {
          this.fail(
            "interface methods cannot have a body",
            method.span,
            "interface",
          );
        }
        this.resolveMethod(symbol, method);
      }
    }

    if (
      symbol.kind === "class" &&
      !symbol.isExtern &&
      symbol.constructors.length === 0
    ) {
      symbol.constructors = [{
        kind: "constructor",
        owner: symbol,
        visibility: "public",
        params: [],
        isImplicit: true,
      }];
    }
  }

  private resolveAttribute(symbol: TypeSymbol, decl: ast.AttributeDecl): void {
    if (symbol.fields.has(decl.name)) {
      this.fail(
        `duplicate attribute '${decl.name}'`,
        decl.span,
        "duplicate-member",
      );
    }
    if (symbol.methods.has(decl.name)) {
      this.fail(
        `attribute '${decl.name}' conflicts with a method`,
        decl.span,
        "duplicate-member",
      );
    }
    if (symbol.isExtern) {
      this.fail(
        "extern classes cannot declare attributes",
        decl.span,
        "extern",
      );
    }
    this.checkInternalName(decl.name, decl.visibility, decl.span);
    const type = this.resolveTypeRef(decl.type, symbol);
    if (decl.isStatic && decl.isFinal && !decl.initializer) {
      this.fail(
        `static final attribute '${decl.name}' requires an initializer`,
        decl.span,
        "final",
      );
    }
    symbol.fields.set(decl.name, {
      kind: "field",
      name: decl.name,
      owner: symbol,
      visibility: decl.visibility,
      isFinal: decl.isFinal,
      isStatic: decl.isStatic,
      type,
      decl,
    });
  }

  private resolveMethod(symbol: TypeSymbol, decl: ast.MethodDecl): void {
    if (symbol.fields.has(decl.name)) {
      this.fail(
        `method '${decl.name}' conflicts with an attribute`,
        decl.span,
        "duplicate-member",
      );
    }
    this.checkInternalName(decl.name, decl.visibility, decl.span);
    const returnType = this.resolveTypeRef(decl.returnType, symbol, undefined, true);
    if (decl.isStatic && decl.isFinal) {
      this.fail("static methods cannot be final", decl.span, "modifier");
    }
    if (symbol.kind === "interface" && decl.isExtern) {
      this.fail("interface methods cannot be extern", decl.span, "interface");
    }
    if (symbol.kind === "interface" && decl.isVariadic) {
      this.fail(
        "variadic interface methods are not supported yet",
        decl.span,
        "interface",
      );
    }
    if (decl.isVariadic && decl.isStatic && decl.params.length === 0) {
      this.fail(
        "a static variadic method needs at least one fixed parameter",
        decl.span,
        "variadic",
      );
    }
    if (symbol.isExtern && !decl.isExtern) {
      this.fail(
        "methods of an extern class must be extern",
        decl.span,
        "extern",
      );
    }
    const params = this.resolveParams(symbol, decl.params);
    const overloads = symbol.methods.get(decl.name) ?? [];
    for (const existing of overloads) {
      if (
        existing.isVariadic === decl.isVariadic &&
        existing.params.length === params.length &&
        existing.params.every((param, index) =>
          typesEqual(param.type, params[index]!.type),
        )
      ) {
        this.fail(
          `duplicate method signature '${decl.name}'`,
          decl.span,
          "duplicate-member",
        );
      }
    }
    overloads.push({
      kind: "method",
      name: decl.name,
      owner: symbol,
      visibility: decl.visibility,
      isFinal: decl.isFinal,
      isStatic: decl.isStatic,
      isExtern: decl.isExtern,
      isVariadic: decl.isVariadic,
      returnType,
      params,
      decl,
    });
    symbol.methods.set(decl.name, overloads);
  }

  private resolveConstructor(
    symbol: TypeSymbol,
    decl: ast.ConstructorDecl,
  ): void {
    if (symbol.kind !== "class") {
      this.fail("interfaces cannot have constructors", decl.span, "interface");
    }
    if (symbol.isExtern) {
      this.fail("extern classes cannot have constructors", decl.span, "extern");
    }
    if (decl.isVariadic) {
      this.fail(
        "variadic constructors are not supported yet",
        decl.span,
        "variadic",
      );
    }
    const params = this.resolveParams(symbol, decl.params);
    for (const existing of symbol.constructors) {
      if (
        existing.params.length === params.length &&
        existing.params.every((param, index) =>
          typesEqual(param.type, params[index]!.type),
        )
      ) {
        this.fail(
          `duplicate constructor signature on '${symbol.qualifiedName}'`,
          decl.span,
          "duplicate-constructor",
        );
      }
    }
    symbol.constructors.push({
      kind: "constructor",
      owner: symbol,
      visibility: decl.visibility,
      params,
      decl,
      isImplicit: false,
    });
  }

  private resolveParams(
    symbol: TypeSymbol,
    params: readonly ast.Param[],
  ): ParamSymbol[] {
    const result: ParamSymbol[] = [];
    const seen = new Set<string>();
    for (const param of params) {
      if (seen.has(param.name)) {
        this.fail(
          `duplicate parameter '${param.name}'`,
          param.span,
          "duplicate-param",
        );
      }
      seen.add(param.name);
      const type = this.resolveTypeRef(param.type, symbol);
      if (isVoid(type)) {
        this.fail("parameters cannot have type 'void'", param.span, "type");
      }
      result.push({ name: param.name, type, span: param.span });
    }
    return result;
  }

  private validateHierarchy(): void {
    const visiting = new Set<TypeSymbol>();
    const done = new Set<TypeSymbol>();

    const visit = (symbol: TypeSymbol): void => {
      if (done.has(symbol)) {
        return;
      }
      if (visiting.has(symbol)) {
        this.fail(
          `inheritance cycle involving '${symbol.qualifiedName}'`,
          symbol.decl.span,
          "inherit-cycle",
        );
      }
      visiting.add(symbol);
      if (symbol.superClass) {
        const parent = symbol.superClass.symbol;
        if (parent.isFinal) {
          this.fail(
            `cannot extend final class '${parent.qualifiedName}'`,
            symbol.decl.span,
            "inherit",
          );
        }
        visit(parent);
      }
      for (const implemented of symbol.interfaces) {
        visit(implemented.symbol);
      }
      visiting.delete(symbol);
      done.add(symbol);
    };

    for (const symbol of this.orderedSymbols) {
      visit(symbol);
    }

    for (const symbol of this.orderedSymbols) {
      if (symbol.kind !== "class") {
        continue;
      }
      const superType = symbol.superClass
        ? this.substitute(symbol.superClass, this.typeParamMap(this.selfType(symbol)))
        : undefined;
      for (const overloads of symbol.methods.values()) {
        for (const method of overloads) {
          if (superType?.kind !== "class") {
            continue;
          }
          const inherited = this.findMethodBySignature(
            superType,
            method.name,
            method.params,
            method.isVariadic,
          );
          if (!inherited || inherited.method.visibility === "private") {
            continue;
          }
          if (inherited.method.isFinal) {
            this.fail(
              `cannot override final method '${method.name}'`,
              method.decl.span,
              "override",
            );
          }
          if (inherited.method.isStatic !== method.isStatic) {
            this.fail(
              `override of '${method.name}' must ${inherited.method.isStatic ? "" : "not "}be static`,
              method.decl.span,
              "override",
            );
          }
          if (
            VISIBILITY_RANK[method.visibility] <
            VISIBILITY_RANK[inherited.method.visibility]
          ) {
            this.fail(
              `override of '${method.name}' cannot reduce visibility`,
              method.decl.span,
              "override",
            );
          }
          if (!typesEqual(method.returnType, inherited.returnType)) {
            this.fail(
              `override of '${method.name}' must return '${displayType(inherited.returnType)}'`,
              method.decl.span,
              "override",
            );
          }
        }
      }

      const interfaces = this.allInterfaces(this.selfType(symbol));
      for (const interfaceType of interfaces) {
        const map = this.typeParamMap(interfaceType);
        for (const overloads of interfaceType.symbol.methods.values()) {
          for (const required of overloads) {
            const expectedReturn = this.substitute(required.returnType, map);
            const expectedParams = required.params.map((param) => ({
              ...param,
              type: this.substitute(param.type, map),
            }));
            const actual = this.findMethodBySignature(
              this.selfType(symbol),
              required.name,
              expectedParams,
              required.isVariadic,
            );
            if (!actual) {
              this.fail(
                `class '${symbol.qualifiedName}' does not implement '${required.name}' from '${interfaceType.symbol.qualifiedName}'`,
                symbol.decl.span,
                "interface",
              );
            }
            if (actual.method.isStatic) {
              this.fail(
                `method '${required.name}' must be an instance method to satisfy an interface`,
                actual.method.decl.span,
                "interface",
              );
            }
            if (!typesEqual(actual.returnType, expectedReturn)) {
              this.fail(
                `method '${required.name}' has return type '${displayType(actual.returnType)}', expected '${displayType(expectedReturn)}'`,
                actual.method.decl.span,
                "interface",
              );
            }
            if (actual.method.visibility !== "public") {
              this.fail(
                `method '${required.name}' must be public to satisfy an interface`,
                actual.method.decl.span,
                "visibility",
              );
            }
          }
        }
      }
    }
  }

  private findField(type: ClassSemType, name: string): FieldLookup | undefined {
    const direct = type.symbol.fields.get(name);
    if (direct) {
      return {
        field: direct,
        type: this.substitute(direct.type, this.typeParamMap(type)),
      };
    }
    if (type.symbol.superClass) {
      const superType = this.substitute(
        type.symbol.superClass,
        this.typeParamMap(type),
      );
      if (superType.kind === "class") {
        return this.findField(superType, name);
      }
    }
    return undefined;
  }

  private methodLookups(type: ClassSemType, name: string): MethodLookup[] {
    const map = this.typeParamMap(type);
    const result: MethodLookup[] = [];
    const direct = type.symbol.methods.get(name);
    if (direct) {
      for (const method of direct) {
        result.push({
          method,
          returnType: this.substitute(method.returnType, map),
          params: method.params.map((param) => ({
            ...param,
            type: this.substitute(param.type, map),
          })),
        });
      }
    }
    if (type.symbol.superClass) {
      const superType = this.substitute(type.symbol.superClass, map);
      if (superType.kind === "class") {
        result.push(...this.methodLookups(superType, name));
      }
    }
    if (type.symbol.kind === "interface") {
      for (const interfaceType of type.symbol.interfaces) {
        const resolved = this.substitute(interfaceType, map);
        if (resolved.kind === "class") {
          result.push(...this.methodLookups(resolved, name));
        }
      }
    }
    return result;
  }

  private findMethod(type: ClassSemType, name: string): MethodLookup | undefined {
    return this.methodLookups(type, name)[0];
  }

  private isVarargSafe(type: SemType): boolean {
    return (
      (type.kind === "primitive" && type.name !== "void") ||
      type.kind === "pointer" ||
      type.kind === "null" ||
      (type.kind === "array" &&
        type.element.kind === "primitive" &&
        type.element.name === "char")
    );
  }

  private methodMatchesArgs(
    lookup: MethodLookup,
    argTypes: readonly SemType[],
  ): boolean {
    if (argTypes.length < lookup.params.length) {
      return false;
    }
    if (!lookup.method.isVariadic && argTypes.length !== lookup.params.length) {
      return false;
    }
    if (
      !lookup.params.every((param, index) =>
        this.isAssignable(argTypes[index]!, param.type),
      )
    ) {
      return false;
    }
    if (lookup.method.isVariadic) {
      for (let index = lookup.params.length; index < argTypes.length; index += 1) {
        if (!this.isVarargSafe(argTypes[index]!)) {
          return false;
        }
      }
    }
    return true;
  }

  private findMethodForArgs(
    type: ClassSemType,
    name: string,
    argTypes: readonly SemType[],
    predicate?: (method: MethodSymbol) => boolean,
  ): MethodLookup | undefined {
    const lookups = this.methodLookups(type, name).filter(
      (lookup) => !predicate || predicate(lookup.method),
    );
    for (const lookup of lookups) {
      if (!lookup.method.isVariadic && this.methodMatchesArgs(lookup, argTypes)) {
        return lookup;
      }
    }
    for (const lookup of lookups) {
      if (lookup.method.isVariadic && this.methodMatchesArgs(lookup, argTypes)) {
        return lookup;
      }
    }
    return undefined;
  }

  private findMethodBySignature(
    type: ClassSemType,
    name: string,
    params: readonly ParamSymbol[],
    isVariadic?: boolean,
  ): MethodLookup | undefined {
    for (const lookup of this.methodLookups(type, name)) {
      if (
        (isVariadic === undefined ||
          lookup.method.isVariadic === isVariadic) &&
        lookup.params.length === params.length &&
        lookup.params.every((param, index) =>
          typesEqual(param.type, params[index]!.type),
        )
      ) {
        return lookup;
      }
    }
    return undefined;
  }

  private allInterfaces(type: ClassSemType): ClassSemType[] {
    const result: ClassSemType[] = [];
    const seen = new Set<string>();

    const visit = (current: ClassSemType): void => {
      for (const declared of current.symbol.interfaces) {
        const resolved = this.substitute(
          declared,
          this.typeParamMap(current),
        );
        if (resolved.kind !== "class") {
          continue;
        }
        const key = typeKey(resolved);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        result.push(resolved);
        visit(resolved);
      }
    };

    visit(type);
    if (type.symbol.superClass) {
      const superType = this.substitute(
        type.symbol.superClass,
        this.typeParamMap(type),
      );
      if (superType.kind === "class") {
        for (const inherited of this.allInterfaces(superType)) {
          const key = typeKey(inherited);
          if (!seen.has(key)) {
            seen.add(key);
            result.push(inherited);
          }
        }
      }
    }
    return result;
  }

  private isSubtype(from: ClassSemType, target: ClassSemType): boolean {
    if (from.symbol === target.symbol) {
      return (
        from.args.length === target.args.length &&
        from.args.every((arg, index) =>
          typesEqual(arg, target.args[index]!),
        )
      );
    }
    if (target.symbol.kind === "interface") {
      return this.allInterfaces(from).some((interfaceType) =>
        this.isSubtype(interfaceType, target),
      );
    }
    if (from.symbol.superClass) {
      const superType = this.substitute(
        from.symbol.superClass,
        this.typeParamMap(from),
      );
      if (superType.kind === "class") {
        return this.isSubtype(superType, target);
      }
    }
    return false;
  }

  private valueType(type: SemType): SemType {
    return type.kind === "task" ? type.result : type;
  }

  private isAssignable(from: SemType, to: SemType): boolean {
    if (typesEqual(from, to)) {
      return true;
    }
    if (from.kind === "task") {
      if (to.kind === "task") {
        return this.isAssignable(from.result, to.result);
      }
      return this.isAssignable(from.result, to);
    }
    if (to.kind === "task") {
      return false;
    }
    if (to.kind === "nullable") {
      if (from.kind === "null") {
        return true;
      }
      return this.isAssignable(from, to.inner);
    }
    if (from.kind === "null") {
      return false;
    }
    if (from.kind === "class" && to.kind === "class") {
      return this.isSubtype(from, to);
    }
    if (from.kind === "pointer" && to.kind === "pointer") {
      if (!from.target || !to.target) {
        return true;
      }
      return this.isAssignable(from.target, to.target);
    }
    return false;
  }

  private requireAssignable(
    from: SemType,
    to: SemType,
    span: Span,
    what: string,
  ): void {
    if (!this.isAssignable(from, to)) {
      this.fail(
        `${what} has type '${displayType(from)}', expected '${displayType(to)}'`,
        span,
        "type",
      );
    }
  }

  private checkTypeBody(symbol: TypeSymbol): void {
    if (symbol.kind === "enum") {
      return;
    }
    for (const field of symbol.fields.values()) {
      if (field.decl.initializer) {
        const context = this.initializerContext(symbol);
        const valueType = this.checkExpr(field.decl.initializer, field.type, context);
        this.requireAssignable(
          valueType,
          field.type,
          field.decl.initializer.span,
          `initializer for '${field.name}'`,
        );
      }
    }

    for (const overloads of symbol.methods.values()) {
      for (const method of overloads) {
        if (method.isExtern || !method.decl.body) {
          continue;
        }
        this.checkMethodBody(method);
      }
    }

    if (symbol.kind === "class") {
      for (const constructor of symbol.constructors) {
        if (constructor.isImplicit || !constructor.decl) {
          this.checkImplicitConstructor(symbol, constructor);
          continue;
        }
        this.checkConstructorBody(symbol, constructor);
      }
    }
  }

  private checkImplicitConstructor(
    owner: TypeSymbol,
    constructor: ConstructorSymbol,
  ): void {
    const context = this.constructorContext(owner, constructor);
    if (owner.superClass) {
      const noArg = this.findConstructor(owner.superClass, []);
      if (!noArg) {
        this.fail(
          `implicit constructor requires '${owner.superClass.symbol.qualifiedName}' to have a no-argument constructor`,
          owner.decl.span,
          "constructor",
        );
      }
      this.checkAccess(
        noArg.visibility,
        noArg.owner,
        owner,
        owner.decl.span,
        "constructor",
      );
    }
    context.superCalled = true;
    this.checkFieldsInitialized(owner, context, owner.decl.span);
  }

  private initializerContext(symbol: TypeSymbol): FunctionContext {
    return {
      owner: symbol,
      returnType: VOID,
      isStatic: true,
      isConstructor: false,
      isVariadic: false,
      scopes: [{ vars: new Map() }],
      loopDepth: 0,
      switchDepth: 0,
      initializedFields: new Set(),
      narrowed: new Map(),
      superCalled: true,
    };
  }

  private methodContext(method: MethodSymbol): FunctionContext {
    const params = new Map<string, VarInfo>();
    for (const param of method.params) {
      params.set(param.name, {
        name: param.name,
        type: param.type,
        isFinal: false,
        span: param.span,
      });
    }
    return {
      owner: method.owner,
      returnType: method.returnType,
      isStatic: method.isStatic,
      isConstructor: false,
      isVariadic: method.isVariadic,
      scopes: [{ vars: params }],
      loopDepth: 0,
      switchDepth: 0,
      initializedFields: new Set(),
      narrowed: new Map(),
      superCalled: true,
    };
  }

  private constructorContext(
    owner: TypeSymbol,
    constructor: ConstructorSymbol,
  ): FunctionContext {
    const params = new Map<string, VarInfo>();
    for (const param of constructor.params) {
      params.set(param.name, {
        name: param.name,
        type: param.type,
        isFinal: false,
        span: param.span,
      });
    }
    const initialized = new Set<string>();
    for (const field of owner.fields.values()) {
      if (!field.isStatic && field.decl.initializer) {
        initialized.add(field.name);
      }
    }
    return {
      owner,
      returnType: VOID,
      isStatic: false,
      isConstructor: true,
      isVariadic: false,
      scopes: [{ vars: params }],
      loopDepth: 0,
      switchDepth: 0,
      initializedFields: initialized,
      narrowed: new Map(),
      superCalled: false,
    };
  }

  private checkMethodBody(method: MethodSymbol): void {
    const context = this.methodContext(method);
    this.checkBlock(method.decl.body!, context);
    if (
      !isVoid(method.returnType) &&
      !this.statementAlwaysReturns(method.decl.body!)
    ) {
      this.fail(
        `method '${method.name}' must return a value on every path`,
        method.decl.body!.span,
        "return",
      );
    }
  }

  private checkConstructorBody(
    owner: TypeSymbol,
    constructor: ConstructorSymbol,
  ): void {
    const body = constructor.decl!.body;
    const context = this.constructorContext(owner, constructor);
    const superType = owner.superClass;

    let firstIndex = 0;
    const first = body.statements[0];
    if (
      first &&
      first.kind === "ExprStmt" &&
      first.expression.kind === "CallExpr" &&
      first.expression.callee.kind === "SuperExpr"
    ) {
      this.checkSuperConstructorCall(first.expression, context);
      context.superCalled = true;
      firstIndex = 1;
    }

    if (!context.superCalled) {
      if (superType) {
        this.fail(
          `subclass constructor must call super(...) as its first statement`,
          body.span,
          "constructor",
        );
      }
      context.superCalled = true;
    }

    context.scopes.push({ vars: new Map() });
    for (let index = firstIndex; index < body.statements.length; index += 1) {
      this.checkStatement(body.statements[index]!, context);
    }
    context.scopes.pop();

    this.checkFieldsInitialized(owner, context, body.span);
  }

  private checkFieldsInitialized(
    owner: TypeSymbol,
    context: FunctionContext,
    span: Span,
  ): void {
    const missing = [...owner.fields.values()]
      .filter(
        (field) =>
          !field.isStatic && !context.initializedFields.has(field.name),
      )
      .map((field) => field.name);
    if (missing.length > 0) {
      this.fail(
        `constructor does not initialize attribute(s): ${missing.join(", ")}`,
        span,
        "definite-init",
      );
    }
  }

  private checkSuperConstructorCall(
    call: ast.CallExpr,
    context: FunctionContext,
  ): void {
    if (!context.isConstructor) {
      this.fail("'super(...)' is only valid in a constructor", call.span, "super");
    }
    if (context.superCalled) {
      this.fail(
        "'super(...)' must be the first statement in a constructor",
        call.span,
        "super",
      );
    }
    const superType = context.owner.superClass;
    if (!superType) {
      this.fail("class has no superclass", call.span, "super");
    }
    const argTypes = call.args.map((arg) =>
      this.checkExpr(arg, undefined, context),
    );
    const constructor = this.findConstructor(superType, argTypes);
    if (!constructor) {
      this.fail(
        `no matching superclass constructor on '${superType.symbol.qualifiedName}'`,
        call.span,
        "constructor",
      );
    }
    this.checkAccess(
      constructor.visibility,
      constructor.owner,
      context.owner,
      call.span,
      "constructor",
    );
    this.superConstructorCalls.set(call, constructor);
  }

  private findConstructor(
    type: ClassSemType,
    argTypes: readonly SemType[],
  ): ConstructorSymbol | undefined {
    const map = this.typeParamMap(type);
    for (const constructor of type.symbol.constructors) {
      if (constructor.params.length !== argTypes.length) {
        continue;
      }
      const params = constructor.params.map((param) => ({
        ...param,
        type: this.substitute(param.type, map),
      }));
      if (
        params.every((param, index) =>
          this.isAssignable(argTypes[index]!, param.type),
        )
      ) {
        return {
          ...constructor,
          params,
        };
      }
    }
    return undefined;
  }

  private checkAccess(
    visibility: ast.Visibility,
    memberOwner: TypeSymbol,
    contextOwner: TypeSymbol,
    span: Span,
    what: string,
  ): void {
    if (visibility === "public" || visibility === "internal") {
      return;
    }
    if (visibility === "private") {
      if (memberOwner !== contextOwner) {
        this.fail(
          `cannot access private ${what} of '${memberOwner.qualifiedName}'`,
          span,
          "visibility",
        );
      }
      return;
    }
    if (
      memberOwner !== contextOwner &&
      !this.isSubclassOf(contextOwner, memberOwner)
    ) {
      this.fail(
        `cannot access protected ${what} of '${memberOwner.qualifiedName}'`,
        span,
        "visibility",
      );
    }
  }

  private isSubclassOf(owner: TypeSymbol, target: TypeSymbol): boolean {
    let current: TypeSymbol | undefined = owner;
    while (current) {
      if (current === target) {
        return true;
      }
      current = current.superClass?.symbol;
    }
    return false;
  }

  private checkInternalName(
    name: string,
    visibility: ast.Visibility,
    span: Span,
  ): void {
    if (
      name.startsWith("__") &&
      visibility !== "internal" &&
      visibility !== "private"
    ) {
      this.fail(
        `member '${name}' uses the reserved '__' prefix and must be internal or private`,
        span,
        "internal-name",
      );
    }
  }

  private checkBlock(block: ast.BlockStmt, context: FunctionContext): void {
    context.scopes.push({ vars: new Map() });
    for (const statement of block.statements) {
      this.checkStatement(statement, context);
    }
    context.scopes.pop();
  }

  private checkScopedStatement(
    statement: ast.Stmt,
    context: FunctionContext,
  ): void {
    context.scopes.push({ vars: new Map() });
    this.checkStatement(statement, context);
    context.scopes.pop();
  }

  private checkStatement(stmt: ast.Stmt, context: FunctionContext): void {
    switch (stmt.kind) {
      case "BlockStmt":
        this.checkBlock(stmt, context);
        return;
      case "VarDeclStmt":
        this.checkVarDecl(stmt, context);
        return;
      case "ExprStmt":
        this.checkExpr(stmt.expression, undefined, context);
        return;
      case "AssignStmt":
        this.checkAssign(stmt, context);
        return;
      case "IfStmt":
        this.checkIf(stmt, context);
        return;
      case "WhileStmt":
        this.checkWhile(stmt, context);
        return;
      case "ForStmt":
        this.checkFor(stmt, context);
        return;
      case "SwitchStmt":
        this.checkSwitch(stmt, context);
        return;
      case "ReturnStmt":
        this.checkReturn(stmt, context);
        return;
      case "BreakStmt":
        if (context.loopDepth === 0 && context.switchDepth === 0) {
          this.fail("'break' outside a loop or switch", stmt.span, "break");
        }
        return;
      case "ContinueStmt":
        if (context.loopDepth === 0) {
          this.fail("'continue' outside a loop", stmt.span, "continue");
        }
        return;
      case "EnvDefaultStmt": {
        const valueType = this.checkExpr(
          stmt.value,
          arrayType(CHAR),
          context,
        );
        this.requireAssignable(
          valueType,
          arrayType(CHAR),
          stmt.value.span,
          `environment default '${stmt.name}'`,
        );
        return;
      }
    }
  }

  private checkVarDecl(stmt: ast.VarDeclStmt, context: FunctionContext): void {
    const type = this.resolveTypeRef(stmt.type, context.owner, context);
    if (isVoid(type)) {
      this.fail("variables cannot have type 'void'", stmt.span, "type");
    }
    const scope = context.scopes[context.scopes.length - 1]!;
    if (scope.vars.has(stmt.name)) {
      this.fail(
        `duplicate local variable '${stmt.name}'`,
        stmt.span,
        "duplicate-local",
      );
    }
    if (stmt.isFinal && !stmt.initializer) {
      this.fail(
        `final variable '${stmt.name}' requires an initializer`,
        stmt.span,
        "final",
      );
    }
    if (stmt.initializer) {
      const valueType = this.checkExpr(stmt.initializer, type, context);
      this.requireAssignable(
        valueType,
        type,
        stmt.initializer.span,
        `initializer for '${stmt.name}'`,
      );
    }
    scope.vars.set(stmt.name, {
      name: stmt.name,
      type,
      isFinal: stmt.isFinal,
      span: stmt.span,
    });
  }

  private checkAssign(stmt: ast.AssignStmt, context: FunctionContext): void {
    if (stmt.target.kind === "SelfExpr") {
      if (!context.isConstructor) {
        this.fail(
          "'self' can only be assigned inside a constructor",
          stmt.target.span,
          "self",
        );
      }
      if (stmt.op !== "=") {
        this.fail(
          "compound assignment to 'self' is not allowed",
          stmt.span,
          "self",
        );
      }
      const selfType = this.selfType(context.owner);
      const valueType = this.checkExpr(stmt.value, selfType, context);
      this.requireAssignable(valueType, selfType, stmt.value.span, "self assignment");
      for (const field of context.owner.fields.values()) {
        if (!field.isStatic) {
          context.initializedFields.add(field.name);
        }
      }
      return;
    }

    const targetType = this.checkLValue(stmt.target, context);
    const valueType = this.checkExpr(stmt.value, targetType, context);
    this.requireAssignable(valueType, targetType, stmt.value.span, "assignment");

    if (stmt.op !== "=") {
      if (!isNumeric(targetType)) {
        this.fail(
          `compound assignment requires a numeric target, got '${displayType(targetType)}'`,
          stmt.target.span,
          "operator",
        );
      }
      if (isSelfFieldAssignment(stmt.target)) {
        const field = this.findField(
          this.selfType(context.owner),
          stmt.target.member,
        );
        if (field?.field.isFinal) {
          this.fail(
            `cannot compound-assign final attribute '${stmt.target.member}'`,
            stmt.target.span,
            "final",
          );
        }
      }
    }

    if (
      context.isConstructor &&
      isSelfFieldAssignment(stmt.target) &&
      !context.owner.fields.get(stmt.target.member)?.isStatic
    ) {
      context.initializedFields.add(stmt.target.member);
    }
    const key = exprKey(stmt.target);
    if (key) {
      context.narrowed.delete(key);
    }
  }

  private checkLValue(expr: ast.Expr, context: FunctionContext): SemType {
    const type = this.inferLValue(expr, context);
    this.expressionTypes.set(expr, type);
    return type;
  }

  private inferLValue(expr: ast.Expr, context: FunctionContext): SemType {
    switch (expr.kind) {
      case "IdentifierExpr": {
        const variable = this.lookupVar(expr.name, context);
        if (variable) {
          if (variable.isFinal) {
            this.fail(
              `cannot assign to final variable '${variable.name}'`,
              expr.span,
              "final",
            );
          }
          return variable.type;
        }
        const field = this.findField(this.selfType(context.owner), expr.name);
        if (field) {
          if (!field.field.isStatic) {
            this.fail(
              `instance attribute '${expr.name}' must be accessed through 'self'`,
              expr.span,
              "self",
            );
          }
          this.checkAccess(
            field.field.visibility,
            field.field.owner,
            context.owner,
            expr.span,
            "attribute",
          );
          if (field.field.isFinal) {
            this.fail(
              `cannot assign to final attribute '${expr.name}'`,
              expr.span,
              "final",
            );
          }
          return field.type;
        }
        this.fail(`unknown variable '${expr.name}'`, expr.span, "name");
      }
      case "MemberExpr":
        return this.checkMemberLValue(expr, context);
      case "IndexExpr": {
        const objectType = this.valueType(this.checkExpr(expr.object, undefined, context));
        const indexType = this.valueType(this.checkExpr(expr.index, INT, context));
        if (!isInteger(indexType)) {
          this.fail("array index must be an integer", expr.index.span, "index");
        }
        if (objectType.kind === "array") {
          return objectType.element;
        }
        if (objectType.kind === "pointer" && objectType.target) {
          return objectType.target;
        }
        this.fail(
          `cannot index a value of type '${displayType(objectType)}'`,
          expr.object.span,
          "index",
        );
      }
      case "SelfExpr":
        this.fail("'self' cannot be assigned directly", expr.span, "self");
      default:
        this.fail("invalid assignment target", expr.span, "assign");
    }
  }

  private checkMemberLValue(
    expr: ast.MemberExpr,
    context: FunctionContext,
  ): SemType {
    const objectType = this.valueType(this.checkExpr(expr.object, undefined, context));
    if (objectType.kind === "meta") {
      if (objectType.symbol.kind === "enum") {
        if (!objectType.symbol.enumMembers.has(expr.member)) {
          this.fail(
            `unknown enum member '${expr.member}' on '${objectType.symbol.qualifiedName}'`,
            expr.span,
            "name",
          );
        }
        return enumType(objectType.symbol);
      }
      const field = objectType.symbol.fields.get(expr.member);
      if (!field || !field.isStatic) {
        this.fail(
          `unknown static attribute '${expr.member}' on '${objectType.symbol.qualifiedName}'`,
          expr.span,
          "name",
        );
      }
      this.checkAccess(
        field.visibility,
        field.owner,
        context.owner,
        expr.span,
        "attribute",
      );
      if (field.isFinal) {
        this.fail(
          `cannot assign to final attribute '${expr.member}'`,
          expr.span,
          "final",
        );
      }
      return field.type;
    }
    if (objectType.kind !== "class") {
      this.fail(
        `cannot assign to a member of '${displayType(objectType)}'`,
        expr.object.span,
        "assign",
      );
    }
    const field = this.findField(objectType, expr.member);
    if (!field) {
      this.fail(
        `unknown attribute '${expr.member}' on '${displayType(objectType)}'`,
        expr.span,
        "name",
      );
    }
    if (field.field.isStatic) {
      this.fail(
        `static attribute '${expr.member}' must be accessed through its class`,
        expr.span,
        "static",
      );
    }
    this.checkAccess(
      field.field.visibility,
      field.field.owner,
      context.owner,
      expr.span,
      "attribute",
    );
    if (field.field.isFinal) {
      const allowedInConstructor =
        context.isConstructor &&
        isSelfFieldAssignment(expr) &&
        !context.initializedFields.has(field.field.name);
      if (!allowedInConstructor) {
        this.fail(
          `cannot assign to final attribute '${expr.member}'`,
          expr.span,
          "final",
        );
      }
    }
    return field.type;
  }

  private checkIf(stmt: ast.IfStmt, context: FunctionContext): void {
    const conditionType = this.valueType(this.checkExpr(stmt.condition, BOOL, context));
    if (!isBool(conditionType)) {
      this.fail("if condition must be 'bool'", stmt.condition.span, "condition");
    }

    const before = new Set(context.initializedFields);
    const thenContext = cloneContext(context);
    this.applyNarrowing(stmt.condition, thenContext, true);
    this.checkScopedStatement(stmt.thenBranch, thenContext);

    let elseInitialized = before;
    if (stmt.elseBranch) {
      const elseContext = cloneContext(context);
      this.applyNarrowing(stmt.condition, elseContext, false);
      this.checkScopedStatement(stmt.elseBranch, elseContext);
      elseInitialized = elseContext.initializedFields;
    }

    context.initializedFields.clear();
    for (const field of thenContext.initializedFields) {
      if (elseInitialized.has(field)) {
        context.initializedFields.add(field);
      }
    }
    context.narrowed.clear();
  }

  private checkWhile(stmt: ast.WhileStmt, context: FunctionContext): void {
    const conditionType = this.valueType(this.checkExpr(stmt.condition, BOOL, context));
    if (!isBool(conditionType)) {
      this.fail(
        "while condition must be 'bool'",
        stmt.condition.span,
        "condition",
      );
    }
    const bodyContext = cloneContext(context);
    bodyContext.loopDepth += 1;
    this.applyNarrowing(stmt.condition, bodyContext, true);
    this.checkScopedStatement(stmt.body, bodyContext);
    context.narrowed.clear();
  }

  private checkFor(stmt: ast.ForStmt, context: FunctionContext): void {
    context.scopes.push({ vars: new Map() });
    if (stmt.initializer) {
      this.checkStatement(stmt.initializer, context);
    }
    if (stmt.condition) {
      const conditionType = this.valueType(this.checkExpr(stmt.condition, BOOL, context));
      if (!isBool(conditionType)) {
        this.fail(
          "for condition must be 'bool'",
          stmt.condition.span,
          "condition",
        );
      }
    }
    if (stmt.update) {
      this.checkStatement(stmt.update, context);
    }
    const bodyContext = cloneContext(context);
    bodyContext.loopDepth += 1;
    if (stmt.condition) {
      this.applyNarrowing(stmt.condition, bodyContext, true);
    }
    this.checkScopedStatement(stmt.body, bodyContext);
    context.scopes.pop();
    context.narrowed.clear();
  }

  private checkSwitch(stmt: ast.SwitchStmt, context: FunctionContext): void {
    const discriminantType = this.valueType(this.checkExpr(
      stmt.discriminant,
      undefined,
      context,
    ));
    if (
      !isInteger(discriminantType) &&
      !isBool(discriminantType) &&
      discriminantType.kind !== "enum"
    ) {
      this.fail(
        "switch discriminant must be an integer, bool, or enum",
        stmt.discriminant.span,
        "switch",
      );
    }
    let hasDefault = false;
    const before = new Set(context.initializedFields);
    const afterSets: Set<string>[] = [];
    for (const switchCase of stmt.cases) {
      if (switchCase.value) {
        const valueType = this.checkExpr(
          switchCase.value,
          discriminantType,
          context,
        );
        this.requireAssignable(
          valueType,
          discriminantType,
          switchCase.value.span,
          "case value",
        );
      } else {
        if (hasDefault) {
          this.fail("duplicate 'default' case", switchCase.span, "switch");
        }
        hasDefault = true;
      }
      const caseContext = cloneContext(context);
      caseContext.switchDepth += 1;
      for (const caseStatement of switchCase.statements) {
        this.checkStatement(caseStatement, caseContext);
      }
      afterSets.push(caseContext.initializedFields);
    }

    context.initializedFields.clear();
    if (afterSets.length === 0) {
      for (const field of before) {
        context.initializedFields.add(field);
      }
    } else {
      const candidates = hasDefault ? afterSets : [before, ...afterSets];
      for (const field of candidates[0]!) {
        if (candidates.every((set) => set.has(field))) {
          context.initializedFields.add(field);
        }
      }
    }
    context.narrowed.clear();
  }

  private checkReturn(stmt: ast.ReturnStmt, context: FunctionContext): void {
    if (context.isConstructor) {
      if (stmt.value) {
        this.fail(
          "constructors cannot return a value",
          stmt.value.span,
          "return",
        );
      }
      this.checkFieldsInitialized(context.owner, context, stmt.span);
      return;
    }
    if (isVoid(context.returnType)) {
      if (stmt.value) {
        this.fail(
          "void method cannot return a value",
          stmt.value.span,
          "return",
        );
      }
      return;
    }
    if (!stmt.value) {
      this.fail("return value required", stmt.span, "return");
    }
    const valueType = this.checkExpr(stmt.value, context.returnType, context);
    this.requireAssignable(
      valueType,
      context.returnType,
      stmt.value.span,
      "return value",
    );
  }

  private statementAlwaysReturns(stmt: ast.Stmt): boolean {
    switch (stmt.kind) {
      case "ReturnStmt":
        return true;
      case "BlockStmt": {
        for (const child of stmt.statements) {
          if (this.statementAlwaysReturns(child)) {
            return true;
          }
        }
        return false;
      }
      case "IfStmt":
        return Boolean(
          stmt.elseBranch &&
          this.statementAlwaysReturns(stmt.thenBranch) &&
          this.statementAlwaysReturns(stmt.elseBranch),
        );
      case "SwitchStmt":
        return (
          stmt.cases.some((switchCase) => !switchCase.value) &&
          stmt.cases.length > 0 &&
          stmt.cases.every((switchCase) =>
            switchCase.statements.some((child) =>
              this.statementAlwaysReturns(child),
            ),
          )
        );
      default:
        return false;
    }
  }

  private applyNarrowing(
    expr: ast.Expr,
    context: FunctionContext,
    truthy: boolean,
  ): void {
    if (expr.kind === "UnaryExpr" && expr.op === "!") {
      this.applyNarrowing(expr.operand, context, !truthy);
      return;
    }
    if (expr.kind === "BinaryExpr") {
      if (expr.op === "&&" && truthy) {
        this.applyNarrowing(expr.left, context, true);
        this.applyNarrowing(expr.right, context, true);
        return;
      }
      if (expr.op === "||" && !truthy) {
        this.applyNarrowing(expr.left, context, false);
        this.applyNarrowing(expr.right, context, false);
        return;
      }
      if (expr.op !== "==" && expr.op !== "!=") {
        return;
      }
      const nonNull = expr.op === "!=" ? truthy : !truthy;
      if (!nonNull) {
        return;
      }
      if (isNullLiteral(expr.left) && expr.right.kind !== "NullLiteralExpr") {
        const key = exprKey(expr.right);
        if (key) {
          const type = this.typeOfNarrowable(expr.right, context);
          if (type?.kind === "nullable") {
            context.narrowed.set(key, type.inner);
          }
        }
      } else if (
        isNullLiteral(expr.right) &&
        expr.left.kind !== "NullLiteralExpr"
      ) {
        const key = exprKey(expr.left);
        if (key) {
          const type = this.typeOfNarrowable(expr.left, context);
          if (type?.kind === "nullable") {
            context.narrowed.set(key, type.inner);
          }
        }
      }
    }
  }

  private typeOfNarrowable(
    expr: ast.Expr,
    context: FunctionContext,
  ): SemType | undefined {
    if (expr.kind === "IdentifierExpr") {
      const variable = this.lookupVar(expr.name, context);
      if (variable) {
        return variable.type;
      }
      const field = this.findField(this.selfType(context.owner), expr.name);
      return field?.type;
    }
    if (expr.kind === "MemberExpr") {
      const key = exprKey(expr);
      if (key && context.narrowed.has(key)) {
        return context.narrowed.get(key);
      }
      const objectType = this.tryExprType(expr.object, context);
      if (objectType?.kind === "class") {
        return this.findField(objectType, expr.member)?.type;
      }
    }
    return undefined;
  }

  private tryExprType(
    expr: ast.Expr,
    context: FunctionContext,
  ): SemType | undefined {
    try {
      return this.checkExpr(expr, undefined, context);
    } catch {
      return undefined;
    }
  }

  private checkExpr(
    expr: ast.Expr,
    expected: SemType | undefined,
    context: FunctionContext,
  ): SemType {
    const type = this.inferExpr(expr, expected, context);
    this.expressionTypes.set(expr, type);
    return type;
  }

  private inferExpr(
    expr: ast.Expr,
    expected: SemType | undefined,
    context: FunctionContext,
  ): SemType {
    switch (expr.kind) {
      case "IntLiteralExpr": {
        if (
          expected &&
          expected.kind === "primitive" &&
          isInteger(expected) &&
          integerFits(expr.value, expected.name)
        ) {
          return expected;
        }
        return INT;
      }
      case "FloatLiteralExpr":
        if (expected && expected.kind === "primitive" && expected.name === "float") {
          return expected;
        }
        return FLOAT;
      case "StringLiteralExpr":
        return arrayType(CHAR);
      case "CharLiteralExpr":
        return CHAR;
      case "BoolLiteralExpr":
        return BOOL;
      case "NullLiteralExpr":
        return NULL;
      case "IdentifierExpr":
        return this.checkIdentifier(expr, context);
      case "SelfExpr":
        return this.checkSelf(expr, context);
      case "SuperExpr":
        return this.checkSuper(expr, context);
      case "MemberExpr":
        return this.checkMember(expr, context);
      case "IndexExpr": {
        const objectType = this.valueType(this.checkExpr(expr.object, undefined, context));
        const indexType = this.valueType(this.checkExpr(expr.index, INT, context));
        if (!isInteger(indexType)) {
          this.fail("array index must be an integer", expr.index.span, "index");
        }
        if (objectType.kind === "array") {
          return objectType.element;
        }
        if (objectType.kind === "pointer" && objectType.target) {
          return objectType.target;
        }
        this.fail(
          `cannot index a value of type '${displayType(objectType)}'`,
          expr.object.span,
          "index",
        );
      }
      case "CallExpr":
        return this.checkCall(expr, context);
      case "NewObjectExpr": {
        const type = this.resolveTypeRef(expr.type, context.owner, context);
        if (type.kind !== "class" || type.symbol.kind !== "class") {
          this.fail(
            "'new' requires a class type",
            expr.type.span,
            "new",
          );
        }
        if (type.symbol.isExtern) {
          this.fail(
            `cannot instantiate extern class '${type.symbol.qualifiedName}'`,
            expr.type.span,
            "new",
          );
        }
        const argTypes = expr.args.map((arg) =>
          this.checkExpr(arg, undefined, context),
        );
        const constructor = this.findConstructor(type, argTypes);
        if (!constructor) {
          this.fail(
            `no matching constructor on '${type.symbol.qualifiedName}'`,
            expr.span,
            "constructor",
          );
        }
        this.checkAccess(
          constructor.visibility,
          constructor.owner,
          context.owner,
          expr.span,
          "constructor",
        );
        this.constructorCalls.set(expr, { constructor, type });
        return type;
      }
      case "NewArrayExpr": {
        const element = this.resolveTypeRef(
          expr.elementType,
          context.owner,
          context,
        );
        if (isVoid(element)) {
          this.fail("arrays cannot contain 'void'", expr.elementType.span, "type");
        }
        const sizeType = this.valueType(this.checkExpr(expr.size, INT, context));
        if (!isInteger(sizeType)) {
          this.fail("array size must be an integer", expr.size.span, "array-size");
        }
        if (
          (isIntLiteral(expr.size) && expr.size.value < 0n) ||
          (expr.size.kind === "UnaryExpr" &&
            expr.size.op === "-" &&
            expr.size.operand.kind === "IntLiteralExpr")
        ) {
          this.fail("array size cannot be negative", expr.size.span, "array-size");
        }
        return arrayType(element);
      }
      case "CastExpr": {
        const target = this.resolveTypeRef(expr.target, context.owner, context);
        const valueType = this.valueType(this.checkExpr(expr.value, undefined, context));
        this.checkCast(valueType, target, expr.span);
        return target;
      }
      case "UnaryExpr": {
        if (expr.op === "!") {
          const type = this.valueType(this.checkExpr(expr.operand, BOOL, context));
          if (!isBool(type)) {
            this.fail("operator '!' requires 'bool'", expr.span, "operator");
          }
          return BOOL;
        }
        const type = this.valueType(this.checkExpr(expr.operand, expected, context));
        if (expr.op === "~") {
          if (!isInteger(type)) {
            this.fail("operator '~' requires an integer", expr.span, "operator");
          }
          return type;
        }
        if (!isNumeric(type)) {
          this.fail(
            `operator '${expr.op}' requires a numeric operand`,
            expr.span,
            "operator",
          );
        }
        return type;
      }
      case "UpdateExpr": {
        const type = this.checkLValue(expr.operand, context);
        if (!isNumeric(type)) {
          this.fail(
            `operator '${expr.op}' requires a numeric operand`,
            expr.span,
            "operator",
          );
        }
        return type;
      }
      case "BinaryExpr":
        return this.checkBinary(expr, expected, context);
      case "TernaryExpr": {
        const conditionType = this.valueType(this.checkExpr(expr.condition, BOOL, context));
        if (!isBool(conditionType)) {
          this.fail(
            "ternary condition must be 'bool'",
            expr.condition.span,
            "condition",
          );
        }
        const thenContext = cloneContext(context);
        this.applyNarrowing(expr.condition, thenContext, true);
        const thenType = this.valueType(this.checkExpr(expr.thenExpr, expected, thenContext));
        const elseContext = cloneContext(context);
        this.applyNarrowing(expr.condition, elseContext, false);
        const elseType = this.valueType(this.checkExpr(
          expr.elseExpr,
          expected ?? thenType,
          elseContext,
        ));
        if (typesEqual(thenType, elseType)) {
          return thenType;
        }
        if (thenType.kind === "null" && elseType.kind === "nullable") {
          return elseType;
        }
        if (elseType.kind === "null" && thenType.kind === "nullable") {
          return thenType;
        }
        if (this.isAssignable(thenType, elseType)) {
          return elseType;
        }
        if (this.isAssignable(elseType, thenType)) {
          return thenType;
        }
        this.fail(
          `ternary branches have incompatible types '${displayType(thenType)}' and '${displayType(elseType)}'`,
          expr.span,
          "ternary",
        );
      }
      case "SpreadExpr":
        this.fail(
          "spread expression is only valid inside an array literal",
          expr.span,
          "spread",
        );
      case "ArrayLiteralExpr":
        return this.checkArrayLiteral(expr, expected, context);
      case "WorkerCallExpr":
        return taskType(this.checkWorkerCall(expr, context));
      case "TaskProbeExpr": {
        const type = this.checkExpr(expr.expression, undefined, context);
        if (type.kind !== "task") {
          this.fail(
            "task completion probe requires a task value",
            expr.expression.span,
            "task",
          );
        }
        return BOOL;
      }
    }
  }

  private checkIdentifier(
    expr: ast.IdentifierExpr,
    context: FunctionContext,
  ): SemType {
    if (expr.name === "copy" || expr.name === "env" || expr.name === "syscall") {
      this.fail(
        `builtin '${expr.name}' must be called`,
        expr.span,
        "builtin",
      );
    }
    const variable = this.lookupVar(expr.name, context);
    if (variable) {
      const key = exprKey(expr);
      const narrowed = key ? context.narrowed.get(key) : undefined;
      return narrowed ?? variable.type;
    }
    const field = this.findField(this.selfType(context.owner), expr.name);
    if (field) {
      if (!field.field.isStatic) {
        this.fail(
          `instance attribute '${expr.name}' must be accessed through 'self'`,
          expr.span,
          "self",
        );
      }
      this.checkAccess(
        field.field.visibility,
        field.field.owner,
        context.owner,
        expr.span,
        "attribute",
      );
      return field.type;
    }
    const symbol = this.lookupTypeSymbol([expr.name], context.owner, expr.span);
    return metaType(symbol);
  }

  private checkSelf(expr: ast.SelfExpr, context: FunctionContext): SemType {
    if (context.isStatic) {
      this.fail("'self' is not available in a static context", expr.span, "self");
    }
    return this.selfType(context.owner);
  }

  private checkSuper(expr: ast.SuperExpr, context: FunctionContext): SemType {
    if (context.isStatic) {
      this.fail("'super' is not available in a static context", expr.span, "super");
    }
    if (!context.owner.superClass) {
      this.fail("class has no superclass", expr.span, "super");
    }
    return context.owner.superClass;
  }

  private checkMember(
    expr: ast.MemberExpr,
    context: FunctionContext,
  ): SemType {
    const objectType = this.valueType(this.checkExpr(expr.object, undefined, context));
    if (objectType.kind === "meta") {
      if (objectType.symbol.kind === "enum") {
        if (!objectType.symbol.enumMembers.has(expr.member)) {
          this.fail(
            `unknown enum member '${expr.member}' on '${objectType.symbol.qualifiedName}'`,
            expr.span,
            "name",
          );
        }
        return enumType(objectType.symbol);
      }
      const field = objectType.symbol.fields.get(expr.member);
      if (!field || !field.isStatic) {
        this.fail(
          `unknown static attribute '${expr.member}' on '${objectType.symbol.qualifiedName}'`,
          expr.span,
          "name",
        );
      }
      this.checkAccess(
        field.visibility,
        field.owner,
        context.owner,
        expr.span,
        "attribute",
      );
      return field.type;
    }
    if (objectType.kind === "array") {
      if (expr.member === "len") {
        return INT;
      }
      this.fail(
        `arrays have no member '${expr.member}' (did you mean 'len'?)`,
        expr.span,
        "name",
      );
    }
    if (objectType.kind === "nullable") {
      this.fail(
        `cannot access member '${expr.member}' on nullable type '${displayType(objectType)}' without a null check`,
        expr.object.span,
        "nullable",
      );
    }
    if (objectType.kind !== "class") {
      this.fail(
        `type '${displayType(objectType)}' has no members`,
        expr.object.span,
        "name",
      );
    }
    const field = this.findField(objectType, expr.member);
    if (field) {
      if (field.field.isStatic) {
        this.fail(
          `static attribute '${expr.member}' must be accessed through its class`,
          expr.span,
          "static",
        );
      }
      this.checkAccess(
        field.field.visibility,
        field.field.owner,
        context.owner,
        expr.span,
        "attribute",
      );
      const key = exprKey(expr);
      const narrowed = key ? context.narrowed.get(key) : undefined;
      return narrowed ?? field.type;
    }
    if (this.findMethod(objectType, expr.member)) {
      this.fail(
        `method '${expr.member}' must be called`,
        expr.span,
        "call",
      );
    }
    this.fail(
      `unknown member '${expr.member}' on '${displayType(objectType)}'`,
      expr.span,
      "name",
    );
  }

  private checkCall(expr: ast.CallExpr, context: FunctionContext): SemType {
    if (expr.callee.kind === "SuperExpr") {
      this.checkSuperConstructorCall(expr, context);
      context.superCalled = true;
      return VOID;
    }
    if (expr.callee.kind === "IdentifierExpr") {
      switch (expr.callee.name) {
        case "copy": {
          if (expr.args.length !== 1) {
            this.fail("'copy' expects exactly one argument", expr.span, "builtin");
          }
          return this.checkExpr(expr.args[0]!, undefined, context);
        }
        case "env": {
          if (expr.args.length > 1) {
            this.fail("'env' expects zero or one argument", expr.span, "builtin");
          }
          if (expr.args.length === 1) {
            const argType = this.checkExpr(
              expr.args[0]!,
              arrayType(CHAR),
              context,
            );
            this.requireAssignable(
              argType,
              arrayType(CHAR),
              expr.args[0]!.span,
              "environment variable name",
            );
          }
          return arrayType(CHAR);
        }
        case "syscall": {
          if (expr.args.length === 0) {
            this.fail("'syscall' expects at least one argument", expr.span, "builtin");
          }
          for (const arg of expr.args) {
            const argType = this.checkExpr(arg, undefined, context);
            if (!isInteger(argType) && argType.kind !== "pointer") {
              this.fail(
                "syscall arguments must be integers or pointers",
                arg.span,
                "builtin",
              );
            }
          }
          return INT;
        }
        case "va_int":
          return this.checkVariadicBuiltin(expr, context, INT);
        case "va_i32":
          return this.checkVariadicBuiltin(expr, context, I32);
        case "va_u32":
          return this.checkVariadicBuiltin(expr, context, U32);
        case "va_uint":
          return this.checkVariadicBuiltin(expr, context, UINT);
        case "va_float":
          return this.checkVariadicBuiltin(expr, context, FLOAT);
        case "va_bool":
          return this.checkVariadicBuiltin(expr, context, BOOL);
        case "va_char":
          return this.checkVariadicBuiltin(expr, context, CHAR);
        case "va_ptr":
          return this.checkVariadicBuiltin(expr, context, pointerType());
        case "va_char_array":
          return this.checkVariadicBuiltin(expr, context, arrayType(CHAR));
        default:
          this.fail(
            `function '${expr.callee.name}' is not defined; use a method or builtin`,
            expr.callee.span,
            "call",
          );
      }
    }

    if (expr.callee.kind !== "MemberExpr") {
      this.fail("expression is not callable", expr.callee.span, "call");
    }

    const member = expr.callee;
    const objectType = this.valueType(this.checkExpr(member.object, undefined, context));
    const argTypes = expr.args.map((arg) =>
      this.valueType(this.checkExpr(arg, undefined, context)),
    );
    if (objectType.kind === "meta") {
      const method = this.findMethodForArgs(
        this.selfType(objectType.symbol),
        member.member,
        argTypes,
        (candidate) => candidate.isStatic,
      );
      if (!method) {
        this.fail(
          `unknown static method '${member.member}' on '${objectType.symbol.qualifiedName}'`,
          member.span,
          "name",
        );
      }
      this.checkAccess(
        method.method.visibility,
        method.method.owner,
        context.owner,
        member.span,
        "method",
      );
      const returnType = this.checkCallArgs(
        method.method.name,
        method.params,
        method.returnType,
        expr,
        context,
        method.method.isVariadic,
      );
      this.methodCalls.set(expr, {
        method: method.method,
        params: method.params,
        returnType,
      });
      return returnType;
    }
    if (objectType.kind === "nullable") {
      this.fail(
        `cannot call a method on nullable type '${displayType(objectType)}' without a null check`,
        member.object.span,
        "nullable",
      );
    }
    if (objectType.kind !== "class") {
      this.fail(
        `type '${displayType(objectType)}' has no methods`,
        member.object.span,
        "call",
      );
    }
    const method = this.findMethodForArgs(
      objectType,
      member.member,
      argTypes,
      (candidate) => !candidate.isStatic,
    );
    if (!method) {
      this.fail(
        `no matching method '${member.member}' on '${displayType(objectType)}'`,
        member.span,
        "name",
      );
    }
    this.checkAccess(
      method.method.visibility,
      method.method.owner,
      context.owner,
      member.span,
      "method",
    );
    const returnType = this.checkCallArgs(
      method.method.name,
      method.params,
      method.returnType,
      expr,
      context,
      method.method.isVariadic,
    );
    this.methodCalls.set(expr, {
      method: method.method,
      params: method.params,
      returnType,
    });
    return returnType;
  }

  private checkVariadicBuiltin(
    expr: ast.CallExpr,
    context: FunctionContext,
    type: SemType,
  ): SemType {
    if (!context.isVariadic) {
      this.fail(
        "variadic access is only valid inside a variadic method",
        expr.span,
        "variadic",
      );
    }
    if (expr.args.length !== 0) {
      this.fail("variadic access builtins take no arguments", expr.span, "variadic");
    }
    return type;
  }

  private checkCallArgs(
    name: string,
    params: readonly ParamSymbol[],
    returnType: SemType,
    call: ast.CallExpr,
    context: FunctionContext,
    isVariadic: boolean,
  ): SemType {
    if (
      call.args.length < params.length ||
      (!isVariadic && call.args.length !== params.length)
    ) {
      const expected = isVariadic
        ? `at least ${params.length}`
        : String(params.length);
      this.fail(
        `method '${name}' expects ${expected} argument(s), got ${call.args.length}`,
        call.span,
        "args",
      );
    }
    call.args.forEach((arg, index) => {
      const param = params[index];
      if (param) {
        const argType = this.checkExpr(arg, param.type, context);
        this.requireAssignable(
          argType,
          param.type,
          arg.span,
          `argument ${index + 1} of '${name}'`,
        );
      } else {
        const argType = this.valueType(this.checkExpr(arg, undefined, context));
        if (!this.isVarargSafe(argType)) {
          this.fail(
            `variadic argument ${index + 1} of '${name}' has unsupported type '${displayType(argType)}'`,
            arg.span,
            "variadic",
          );
        }
      }
    });
    return returnType;
  }

  private checkWorkerCall(
    expr: ast.WorkerCallExpr,
    context: FunctionContext,
  ): SemType {
    const argTypes = expr.args.map((arg) =>
      this.valueType(this.checkExpr(arg, undefined, context)),
    );
    const method = this.findMethodForArgs(
      this.selfType(context.owner),
      expr.method,
      argTypes,
    );
    if (!method) {
      this.fail(
        `unknown worker method '${expr.method}' on '${context.owner.qualifiedName}'`,
        expr.span,
        "worker",
      );
    }
    this.checkAccess(
      method.method.visibility,
      method.method.owner,
      context.owner,
      expr.span,
      "method",
    );
    if (!method.method.isStatic && context.isStatic) {
      this.fail(
        `worker method '${expr.method}' cannot be called from a static context`,
        expr.span,
        "worker",
      );
    }
    if (method.method.isVariadic) {
      this.fail(
        "variadic worker methods are not supported yet",
        expr.span,
        "worker",
      );
    }
    if (
      method.returnType.kind === "array" ||
      method.returnType.kind === "class" ||
      method.returnType.kind === "task" ||
      (method.returnType.kind === "nullable" &&
        (method.returnType.inner.kind === "class" ||
          method.returnType.inner.kind === "array"))
    ) {
      this.fail(
        `worker method '${expr.method}' must return void, a primitive, or a pointer`,
        expr.span,
        "worker",
      );
    }
    if (
      method.method.decl.body &&
      containsSelf(method.method.decl.body)
    ) {
      this.fail(
        `worker method '${expr.method}' accesses 'self' and is not worker-safe`,
        expr.span,
        "worker",
      );
    }
    if (expr.args.length !== method.params.length) {
      this.fail(
        `worker method '${expr.method}' expects ${method.params.length} argument(s), got ${expr.args.length}`,
        expr.span,
        "args",
      );
    }
    expr.args.forEach((arg, index) => {
      const param = method.params[index]!;
      const argType = argTypes[index]!;
      this.requireAssignable(
        argType,
        param.type,
        arg.span,
        `argument ${index + 1} of worker method '${expr.method}'`,
      );
      if (!this.isWorkerSafe(argType)) {
        this.fail(
          `argument ${index + 1} of worker method '${expr.method}' has non-worker-safe type '${displayType(argType)}'`,
          arg.span,
          "worker",
        );
      }
    });
    this.workerCalls.set(expr, {
      method: method.method,
      params: method.params,
      returnType: method.returnType,
    });
    return method.returnType;
  }

  private isWorkerSafe(type: SemType): boolean {
    switch (type.kind) {
      case "primitive":
        return type.name !== "void";
      case "pointer":
        return !type.target || this.isWorkerSafe(type.target);
      case "array":
        return this.isWorkerSafe(type.element);
      case "nullable":
        return this.isWorkerSafe(type.inner);
      case "null":
        return true;
      default:
        return false;
    }
  }

  private checkCast(from: SemType, to: SemType, span: Span): void {
    if (typesEqual(from, to)) {
      return;
    }
    if (isVoid(from) || isVoid(to)) {
      this.fail("cannot cast to or from 'void'", span, "cast");
    }
    if (isNumeric(from) && isNumeric(to)) {
      return;
    }
    if (from.kind === "pointer" && to.kind === "pointer") {
      return;
    }
    if (from.kind === "class" && to.kind === "class") {
      return;
    }
    if (from.kind === "null" && to.kind === "nullable") {
      return;
    }
    if (from.kind === "nullable" && to.kind === "nullable") {
      return;
    }
    if (
      from.kind === "enum" &&
      to.kind === "primitive" &&
      isInteger(to)
    ) {
      return;
    }
    if (
      to.kind === "enum" &&
      from.kind === "primitive" &&
      isInteger(from)
    ) {
      return;
    }
    this.fail(
      `cannot cast '${displayType(from)}' to '${displayType(to)}'`,
      span,
      "cast",
    );
  }

  private checkBinary(
    expr: ast.BinaryExpr,
    expected: SemType | undefined,
    context: FunctionContext,
  ): SemType {
    if (expr.op === "&&" || expr.op === "||") {
      const left = this.valueType(this.checkExpr(expr.left, BOOL, context));
      const rightContext = cloneContext(context);
      this.applyNarrowing(expr.left, rightContext, expr.op === "&&");
      const right = this.valueType(this.checkExpr(expr.right, BOOL, rightContext));
      if (!isBool(left) || !isBool(right)) {
        this.fail(
          `operator '${expr.op}' requires 'bool' operands`,
          expr.span,
          "operator",
        );
      }
      return BOOL;
    }

    if (expr.op === "==" || expr.op === "!=") {
      const left = this.valueType(this.checkExpr(
        expr.left,
        expected && isNumeric(expected) ? expected : undefined,
        context,
      ));
      let right = this.valueType(this.checkExpr(
        expr.right,
        isNumeric(left) ? left : undefined,
        context,
      ));
      let leftType = left;
      if (!typesEqual(leftType, right)) {
        if (isIntLiteral(expr.left) && isNumeric(right)) {
          leftType = right;
        } else if (isIntLiteral(expr.right) && isNumeric(leftType)) {
          right = leftType;
        } else if (isFloatLiteral(expr.left) && isNumeric(right)) {
          leftType = right;
        } else if (isFloatLiteral(expr.right) && isNumeric(leftType)) {
          right = leftType;
        }
      }
      if (!this.areComparable(leftType, right)) {
        this.fail(
          `cannot compare '${displayType(leftType)}' with '${displayType(right)}'`,
          expr.span,
          "operator",
        );
      }
      return BOOL;
    }

    if (
      expr.op === "<" ||
      expr.op === "<=" ||
      expr.op === ">" ||
      expr.op === ">="
    ) {
      const left = this.valueType(this.checkExpr(expr.left, undefined, context));
      const right = this.valueType(this.checkExpr(
        expr.right,
        isNumeric(left) ? left : undefined,
        context,
      ));
      let leftType = left;
      let rightType = right;
      if (!typesEqual(leftType, rightType)) {
        if (isIntLiteral(expr.left) && isNumeric(rightType)) {
          leftType = rightType;
        } else if (isIntLiteral(expr.right) && isNumeric(leftType)) {
          rightType = leftType;
        } else if (isFloatLiteral(expr.left) && isNumeric(rightType)) {
          leftType = rightType;
        } else if (isFloatLiteral(expr.right) && isNumeric(leftType)) {
          rightType = leftType;
        }
      }
      if (
        !isNumeric(leftType) ||
        !isNumeric(rightType) ||
        !typesEqual(leftType, rightType)
      ) {
        this.fail(
          `operator '${expr.op}' requires numeric operands of the same type, got '${displayType(leftType)}' and '${displayType(rightType)}'`,
          expr.span,
          "operator",
        );
      }
      return BOOL;
    }

    const left = this.valueType(this.checkExpr(
      expr.left,
      expected && isNumeric(expected) ? expected : undefined,
      context,
    ));
    let right = this.valueType(this.checkExpr(
      expr.right,
      isNumeric(left) ? left : undefined,
      context,
    ));
    let leftType = left;
    if (!typesEqual(leftType, right)) {
      if (isIntLiteral(expr.left) && isNumeric(right)) {
        leftType = right;
      } else if (isIntLiteral(expr.right) && isNumeric(leftType)) {
        right = leftType;
      } else if (isFloatLiteral(expr.left) && isNumeric(right)) {
        leftType = right;
      } else if (isFloatLiteral(expr.right) && isNumeric(leftType)) {
        right = leftType;
      }
    }
    if (!typesEqual(leftType, right)) {
      this.fail(
        `operator '${expr.op}' requires operands of the same type, got '${displayType(leftType)}' and '${displayType(right)}'`,
        expr.span,
        "operator",
      );
    }
    if (expr.op === "&" || expr.op === "|" || expr.op === "^") {
      if (!isInteger(leftType)) {
        this.fail(
          `operator '${expr.op}' requires integer operands`,
          expr.span,
          "operator",
        );
      }
      return leftType;
    }
    if (!isNumeric(leftType)) {
      this.fail(
        `operator '${expr.op}' requires numeric operands`,
        expr.span,
        "operator",
      );
    }
    if (expr.op === "%" && !isInteger(leftType)) {
      this.fail("operator '%' requires integer operands", expr.span, "operator");
    }
    return leftType;
  }

  private areComparable(left: SemType, right: SemType): boolean {
    if (typesEqual(left, right)) {
      return true;
    }
    if (left.kind === "null" && right.kind === "nullable") {
      return true;
    }
    if (right.kind === "null" && left.kind === "nullable") {
      return true;
    }
    if (left.kind === "nullable" && right.kind === "nullable") {
      return this.areComparable(left.inner, right.inner);
    }
    if (left.kind === "nullable" && right.kind !== "null") {
      return this.areComparable(left.inner, right);
    }
    if (right.kind === "nullable" && left.kind !== "null") {
      return this.areComparable(left, right.inner);
    }
    if (left.kind === "class" && right.kind === "class") {
      return (
        this.isSubtype(left, right) ||
        this.isSubtype(right, left)
      );
    }
    return false;
  }

  private checkArrayLiteral(
    expr: ast.ArrayLiteralExpr,
    expected: SemType | undefined,
    context: FunctionContext,
  ): SemType {
    const expectedElement =
      expected?.kind === "array" ? expected.element : undefined;
    let elementType = expectedElement;
    let sawValue = false;

    for (const item of expr.elements) {
      if (item.kind === "SpreadExpr") {
        if (isIntLiteral(item.expression) && item.expression.value === 0n) {
          continue;
        }
        const spreadType = this.checkExpr(
          item.expression,
          elementType ? arrayType(elementType) : undefined,
          context,
        );
        if (spreadType.kind !== "array") {
          this.fail(
            `spread operand must be an array, got '${displayType(spreadType)}'`,
            item.expression.span,
            "spread",
          );
        }
        if (elementType && !typesEqual(elementType, spreadType.element)) {
          this.fail(
            `spread element type '${displayType(spreadType.element)}' does not match '${displayType(elementType)}'`,
            item.expression.span,
            "spread",
          );
        }
        elementType ??= spreadType.element;
        continue;
      }

      const itemType = this.checkExpr(item, elementType, context);
      if (
        elementType &&
        elementType.kind !== "array" &&
        itemType.kind === "array" &&
        typesEqual(itemType.element, elementType)
      ) {
        continue;
      }
      if (!elementType) {
        elementType = itemType;
      } else {
        this.requireAssignable(itemType, elementType, item.span, "array element");
      }
      sawValue = true;
    }

    if (!elementType) {
      this.fail(
        "cannot infer the element type of an empty array literal",
        expr.span,
        "array-literal",
      );
    }
    if (!sawValue && expr.elements.length === 0) {
      this.fail("empty array literal requires an expected type", expr.span, "array-literal");
    }
    return arrayType(elementType);
  }

  private lookupVar(name: string, context: FunctionContext): VarInfo | undefined {
    for (let index = context.scopes.length - 1; index >= 0; index -= 1) {
      const variable = context.scopes[index]!.vars.get(name);
      if (variable) {
        return variable;
      }
    }
    return undefined;
  }
}

export function analyzeUnits(files: readonly SourceUnitFile[]): SemanticModel {
  return new SemanticChecker(files).analyze();
}

export function analyzeProject(project: ResolvedProject): SemanticModel {
  return analyzeUnits(project.files);
}
