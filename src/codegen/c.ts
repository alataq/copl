import type * as ast from "../ast";
import { CoplError } from "../diagnostics";
import type { ResolvedProject } from "../resolver";
import type {
  ConstructorResolution,
  ConstructorSymbol,
  FieldSymbol,
  MethodResolution,
  MethodSymbol,
  ParamSymbol,
  SemanticModel,
  TypeSymbol,
} from "../sema/symbols";
import type { ClassSemType, SemType } from "../sema/types";
import {
  arrayType,
  classType,
  displayType,
  isVoid,
  typeKey,
  typesEqual,
} from "../sema/types";
import { COPL_RUNTIME_C } from "./runtime";

export interface GeneratedC {
  readonly code: string;
  readonly linkFlags: readonly string[];
}

interface Instance {
  readonly symbol: TypeSymbol;
  readonly args: readonly SemType[];
  readonly key: string;
  readonly cName: string;
  readonly map: ReadonlyMap<string, SemType>;
  readonly typeId: number;
}

interface EntryPoint {
  readonly instance: Instance;
  readonly method?: MethodSymbol;
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_");
}

function substitute(
  type: SemType,
  map: ReadonlyMap<string, SemType>,
): SemType {
  switch (type.kind) {
    case "typeParam":
      return map.get(`${type.owner}::${type.name}`) ?? type;
    case "class":
      return classType(
        type.symbol,
        type.args.map((arg) => substitute(arg, map)),
      );
    case "array":
      return arrayType(substitute(type.element, map));
    case "pointer":
      return type.target
        ? { kind: "pointer", target: substitute(type.target, map) }
        : type;
    case "nullable":
      return { kind: "nullable", inner: substitute(type.inner, map) };
    default:
      return type;
  }
}

function cString(value: string): string {
  let result = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\":
        result += "\\\\";
        break;
      case '"':
        result += '\\"';
        break;
      case "\n":
        result += "\\n";
        break;
      case "\r":
        result += "\\r";
        break;
      case "\t":
        result += "\\t";
        break;
      case "\0":
        result += "\\0";
        break;
      default: {
        const code = ch.codePointAt(0)!;
        if (code >= 32 && code <= 126) {
          result += ch;
        } else if (code <= 255) {
          result += `\\x${code.toString(16).padStart(2, "0")}`;
        } else {
          result += "?";
        }
      }
    }
  }
  return result + '"';
}

function charLiteral(value: string): string {
  const code = value.codePointAt(0) ?? 0;
  if (code === 0) {
    return "'\\0'";
  }
  if (code >= 32 && code <= 126 && value !== "'" && value !== "\\") {
    return `'${value}'`;
  }
  if (code === 39) {
    return "'\\''";
  }
  if (code === 92) {
    return "'\\\\'";
  }
  if (code === 10) {
    return "'\\n'";
  }
  if (code === 13) {
    return "'\\r'";
  }
  if (code === 9) {
    return "'\\t'";
  }
  if (code <= 255) {
    return `'\\x${code.toString(16).padStart(2, "0")}'`;
  }
  return "0";
}

export function generateC(
  project: ResolvedProject,
  model: SemanticModel,
): GeneratedC {
  return new CGenerator(project, model).generate();
}

export class CGenerator {
  private readonly instances = new Map<string, Instance>();
  private readonly queue: Instance[] = [];
  private readonly forward: string[] = [];
  private readonly enumDefs: string[] = [];
  private readonly structs: string[] = [];
  private readonly prototypes: string[] = [];
  private readonly globals: string[] = [];
  private readonly functions: string[] = [];
  private readonly includes = new Set<string>();
  private readonly inlines: string[] = [];
  private readonly linkFlags = new Set<string>();
  private readonly emittedStructs = new Set<string>();
  private readonly emittedPrototypes = new Set<string>();
  private readonly emittedFunctions = new Set<string>();
  private readonly emittedGlobals = new Set<string>();
  private readonly staticInitCalls: string[] = [];
  private readonly gcDescriptors: string[] = [];
  private readonly classDescriptors = new Map<string, string>();
  private readonly arrayDescriptors = new Map<string, string>();
  private current?: Instance;
  private currentReturnType?: SemType;
  private currentFrameName?: string;
  private currentVariadicName?: string;
  private controlStack: { breakMarker: string; continueMarker?: string }[] = [];
  private body: string[] = [];
  private indent = 0;
  private tempId = 0;
  private nextTypeId = 1;
  private readonly interfaceDispatchers = new Map<string, string>();
  private readonly arrayCopyHelpers = new Map<string, string>();
  private scopes: Map<string, string>[] = [];
  private entry?: EntryPoint;
  private entryInstance?: Instance;

  constructor(
    private readonly project: ResolvedProject,
    private readonly model: SemanticModel,
  ) {}

  generate(): GeneratedC {
    this.collectInterop();
    for (const symbol of this.model.symbols.values()) {
      if (
        symbol.kind === "class" &&
        !symbol.isExtern &&
        symbol.typeParams.length === 0
      ) {
        this.ensureInstance(classType(symbol));
      }
    }
    this.entry = this.findEntry();
    this.entryInstance = this.entry?.instance;

    let discoverIndex = 0;
    while (discoverIndex < this.queue.length) {
      const instance = this.queue[discoverIndex]!;
      discoverIndex += 1;
      this.discoverDecl(instance);
    }

    for (const symbol of this.model.symbols.values()) {
      if (symbol.kind !== "enum") {
        continue;
      }
      const members = [...symbol.enumMembers.values()].map(
        (member) => `    ${this.enumMemberCName(symbol, member.name)} = ${member.value.toString()}`,
      );
      this.enumDefs.push(
        `typedef enum {\n${members.join(",\n")}\n} ${this.enumCName(symbol)};`,
      );
    }

    let structIndex = 0;
    while (structIndex < this.queue.length) {
      const instance = this.queue[structIndex]!;
      structIndex += 1;
      this.emitStruct(instance);
    }

    for (const instance of this.queue) {
      this.emitPrototypes(instance);
    }

    for (const instance of this.queue) {
      this.emitStaticGlobals(instance);
    }

    let functionIndex = 0;
    while (functionIndex < this.queue.length) {
      const instance = this.queue[functionIndex]!;
      functionIndex += 1;
      this.emitFunctions(instance);
    }

    const main = this.emitMain();

    const standard = [
      "#include <stdint.h>",
      "#include <stddef.h>",
      "#include <stdbool.h>",
      "#include <stdarg.h>",
      "#include <stdlib.h>",
      "#include <string.h>",
      "#include <stdio.h>",
      "#include <unistd.h>",
      "#include <pthread.h>",
    ];
    const userIncludes = [...this.includes].map((header) => `#include <${header}>`);
    const workerDefines = [
      `#define COPL_DEFAULT_WORKERS ${this.project.manifest.defaultWorkers}`,
      ...(this.project.manifest.workersEnvVar
        ? [`#define COPL_WORKERS_ENV ${cString(this.project.manifest.workersEnvVar)}`]
        : []),
    ];
    const code = [
      "#define _GNU_SOURCE 1",
      "#define _POSIX_C_SOURCE 200809L",
      ...workerDefines,
      ...standard,
      ...userIncludes,
      "",
      COPL_RUNTIME_C.trim(),
      "",
      ...this.inlines,
      ...this.forward,
      "",
      ...this.enumDefs,
      "",
      ...this.structs,
      "",
      ...this.gcDescriptors,
      "",
      ...this.globals,
      "",
      ...this.prototypes,
      "",
      ...this.functions,
      main,
      "",
    ].join("\n");

    return {
      code,
      linkFlags: [...this.linkFlags],
    };
  }

  private fail(message: string, span?: ast.Node["span"]): never {
    throw new CoplError(`codegen: ${message}`, span, "codegen");
  }

  private collectInterop(): void {
    for (const file of this.project.files) {
      for (const include of file.unit.cIncludes) {
        this.includes.add(include.header);
      }
      for (const link of file.unit.cLinks) {
        this.linkFlags.add(link.flag);
      }
      for (const inline of file.unit.cInlines) {
        this.inlines.push(inline.code);
      }
    }
  }

  private ensureInstance(type: ClassSemType): Instance {
    if (type.symbol.kind !== "class" || type.symbol.isExtern) {
      this.fail(
        `cannot generate an instance of '${type.symbol.qualifiedName}'`,
      );
    }
    const key = typeKey(type);
    const existing = this.instances.get(key);
    if (existing) {
      return existing;
    }
    const args = type.args;
    const suffix = args.length > 0
      ? `_${args.map((arg) => sanitize(typeKey(arg))).join("_")}`
      : "";
    const cName = `copl_${sanitize(type.symbol.qualifiedName)}${suffix}`;
    const map = new Map<string, SemType>();
    type.symbol.typeParams.forEach((param, index) => {
      map.set(
        `${type.symbol.qualifiedName}::${param.name}`,
        args[index] ?? {
          kind: "typeParam",
          owner: type.symbol.qualifiedName,
          name: param.name,
        },
      );
    });
    const instance: Instance = {
      symbol: type.symbol,
      args,
      key,
      cName,
      map,
      typeId: this.nextTypeId,
    };
    this.nextTypeId += 1;
    this.instances.set(key, instance);
    this.queue.push(instance);
    this.forward.push(`typedef struct ${cName} ${cName};`);
    return instance;
  }

  private substituteFor(type: SemType, instance: Instance): SemType {
    return substitute(type, instance.map);
  }

  private realizeType(type: SemType): SemType {
    return this.current ? substitute(type, this.current.map) : type;
  }

  private cType(type: SemType, instance?: Instance): string {
    const resolved = instance ? substitute(type, instance.map) : this.realizeType(type);
    switch (resolved.kind) {
      case "primitive":
        switch (resolved.name) {
          case "int":
            return "int64_t";
          case "i32":
            return "int32_t";
          case "uint":
            return "uint64_t";
          case "u32":
            return "uint32_t";
          case "byte":
            return "uint8_t";
          case "char":
            return "char";
          case "float":
            return "double";
          case "bool":
            return "bool";
          case "void":
            return "void";
        }
        break;
      case "class":
        if (
          resolved.symbol.kind === "interface" ||
          resolved.symbol.isExtern
        ) {
          return "void*";
        }
        return `${this.ensureInstance(resolved).cName}*`;
      case "array":
        return "copl_array";
      case "pointer":
        if (!resolved.target || isVoid(resolved.target)) {
          return "void*";
        }
        return `${this.cType(resolved.target, instance)}*`;
      case "nullable":
        if (
          resolved.inner.kind === "class" ||
          resolved.inner.kind === "array" ||
          resolved.inner.kind === "pointer"
        ) {
          return this.cType(resolved.inner, instance);
        }
        this.fail(
          `nullable type '${displayType(resolved)}' is not supported by the C11 backend`,
        );
        break;
      case "null":
        return "void*";
      case "typeParam":
        this.fail(
          `unresolved type parameter '${resolved.owner}::${resolved.name}'`,
        );
        break;
      case "meta":
        return "void*";
      case "task":
        return "copl_task*";
      case "enum":
        return this.enumCName(resolved.symbol);
    }
    this.fail(`unsupported type '${displayType(resolved)}'`);
  }

  private typeOf(expr: ast.Expr): SemType {
    const type = this.model.expressionTypes.get(expr);
    if (!type) {
      this.fail("missing semantic type for expression", expr.span);
    }
    return this.realizeType(type);
  }

  private valueTypeOf(expr: ast.Expr): SemType {
    const type = this.typeOf(expr);
    return type.kind === "task" ? type.result : type;
  }

  private emitArgument(
    expr: ast.Expr,
    expected: SemType | undefined,
  ): string {
    return expected?.kind === "task"
      ? this.emitTaskHandle(expr)
      : this.emitExpr(expr);
  }

  private typeOfRef(ref: ast.TypeRef): SemType {
    const type = this.model.typeRefs.get(ref);
    if (!type) {
      this.fail("missing semantic type for type reference", ref.span);
    }
    return this.realizeType(type);
  }

  private discoverDecl(instance: Instance): void {
    this.discoverNode(instance.symbol.decl, instance);
  }

  private discoverNode(node: unknown, instance: Instance): void {
    if (node === null || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      for (const value of node) {
        this.discoverNode(value, instance);
      }
      return;
    }
    const type = this.model.typeRefs.get(node as ast.TypeRef);
    if (type) {
      this.discoverType(substitute(type, instance.map));
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "span") {
        continue;
      }
      this.discoverNode(value, instance);
    }
  }

  private discoverType(type: SemType): void {
    switch (type.kind) {
      case "class":
        if (type.symbol.kind === "class" && !type.symbol.isExtern) {
          this.ensureInstance(type);
        }
        for (const arg of type.args) {
          this.discoverType(arg);
        }
        return;
      case "array":
        this.discoverType(type.element);
        return;
      case "pointer":
        if (type.target) {
          this.discoverType(type.target);
        }
        return;
      case "nullable":
        this.discoverType(type.inner);
        return;
      default:
        return;
    }
  }

  private fieldCName(field: FieldSymbol): string {
    return `copl_field_${sanitize(field.name)}`;
  }

  private enumCName(symbol: TypeSymbol): string {
    return `copl_enum_${sanitize(symbol.qualifiedName)}`;
  }

  private enumMemberCName(symbol: TypeSymbol, member: string): string {
    return `${this.enumCName(symbol)}_${sanitize(member)}`;
  }

  private localCName(name: string): string {
    return `copl_var_${sanitize(name)}`;
  }

  private methodName(instance: Instance, method: MethodSymbol): string {
    const params = method.params.length === 0
      ? "void"
      : method.params
        .map((param) => sanitize(typeKey(substitute(param.type, instance.map))))
        .join("_");
    const signature = method.isVariadic ? `${params}__V` : params;
    return `${instance.cName}__${sanitize(method.name)}__${signature}`;
  }

  private constructorIndex(instance: Instance, constructor: ConstructorSymbol): number {
    const index = instance.symbol.constructors.findIndex(
      (candidate) =>
        candidate === constructor ||
        (candidate.decl !== undefined && candidate.decl === constructor.decl) ||
        (candidate.isImplicit && constructor.isImplicit),
    );
    return index < 0 ? 0 : index;
  }

  private constructorName(instance: Instance, constructor: ConstructorSymbol): string {
    const index = this.constructorIndex(instance, constructor);
    return `${instance.cName}__ctor${index === 0 ? "" : `_${index}`}`;
  }

  private newName(instance: Instance, constructor: ConstructorSymbol): string {
    const index = this.constructorIndex(instance, constructor);
    return `${instance.cName}__new${index === 0 ? "" : `_${index}`}`;
  }

  private copyIntoName(instance: Instance): string {
    return `${instance.cName}__copy_into`;
  }

  private copyName(instance: Instance): string {
    return `${instance.cName}__copy`;
  }

  private staticFieldName(instance: Instance, field: FieldSymbol): string {
    return `${instance.cName}__static_${sanitize(field.name)}`;
  }

  private staticInitName(instance: Instance): string {
    return `${instance.cName}__init_statics`;
  }

  private baseInstance(instance: Instance): Instance | undefined {
    if (!instance.symbol.superClass) {
      return undefined;
    }
    const base = substitute(instance.symbol.superClass, instance.map);
    if (base.kind !== "class") {
      return undefined;
    }
    return this.ensureInstance(base);
  }

  private ownerInstance(instance: Instance, owner: TypeSymbol): Instance {
    let current: Instance | undefined = instance;
    while (current) {
      if (current.symbol === owner) {
        return current;
      }
      current = this.baseInstance(current);
    }
    this.fail(
      `'${instance.symbol.qualifiedName}' is not related to '${owner.qualifiedName}'`,
    );
  }

  private basePointer(expression: string, instance: Instance, owner: TypeSymbol): string {
    let current: Instance = instance;
    let pointer = expression;
    while (current.symbol !== owner) {
      if (!current.symbol.superClass) {
        this.fail(
          `'${instance.symbol.qualifiedName}' does not inherit from '${owner.qualifiedName}'`,
        );
      }
      pointer = `(&(${pointer})->copl_base)`;
      const base = this.baseInstance(current);
      if (!base) {
        this.fail("missing base instance");
      }
      current = base;
    }
    return pointer;
  }

  private instanceForSymbol(symbol: TypeSymbol): Instance {
    if (symbol.typeParams.length === 0) {
      return this.ensureInstance(classType(symbol));
    }
    const matches = this.queue.filter((instance) => instance.symbol === symbol);
    if (matches.length === 1) {
      return matches[0]!;
    }
    this.fail(
      `generic type '${symbol.qualifiedName}' has no unique codegen instance`,
    );
  }

  private findField(symbol: TypeSymbol, name: string): FieldSymbol | undefined {
    let current: TypeSymbol | undefined = symbol;
    while (current) {
      const field = current.fields.get(name);
      if (field) {
        return field;
      }
      current = current.superClass?.symbol;
    }
    return undefined;
  }

  private fieldInstance(instance: Instance, field: FieldSymbol): Instance {
    return this.ownerInstance(instance, field.owner);
  }

  private typeNeedsGcTrace(type: SemType): boolean {
    switch (type.kind) {
      case "class":
        return !(type.symbol.kind === "class" && type.symbol.isExtern);
      case "array":
        return true;
      case "nullable":
        return this.typeNeedsGcTrace(type.inner);
      default:
        return false;
    }
  }

  private gcFieldMark(type: SemType, expression: string): string | undefined {
    if (type.kind === "class") {
      if (type.symbol.kind === "class" && type.symbol.isExtern) {
        return undefined;
      }
      return `copl_gc_mark_object((void*)(${expression}));`;
    }
    if (type.kind === "array") {
      return `copl_gc_mark_array(${expression});`;
    }
    if (type.kind === "nullable") {
      return this.gcFieldMark(type.inner, expression);
    }
    return undefined;
  }

  private classDescriptor(instance: Instance): string {
    const name = `copl_desc_${instance.cName}`;
    const cached = this.classDescriptors.get(name);
    if (cached) {
      return cached;
    }
    this.classDescriptors.set(name, name);
    const base = this.baseInstance(instance);
    if (base) {
      this.classDescriptor(base);
    }
    const traceName = `copl_trace_${instance.cName}`;
    const lines: string[] = [
      `static void ${traceName}(void* object, size_t size) {`,
      "    (void)size;",
      `    ${instance.cName}* self = (${instance.cName}*)object;`,
    ];
    if (base) {
      lines.push(
        `    copl_trace_${base.cName}(&self->copl_base, sizeof(self->copl_base));`,
      );
    }
    for (const field of instance.symbol.fields.values()) {
      if (field.isStatic) {
        continue;
      }
      const type = substitute(field.type, instance.map);
      const mark = this.gcFieldMark(type, `self->${this.fieldCName(field)}`);
      if (mark) {
        lines.push(`    ${mark}`);
      }
    }
    lines.push("}");
    const cleanup = instance.symbol.methods
      .get("__cleanup")
      ?.find(
        (method) =>
          method.params.length === 0 &&
          !method.isVariadic &&
          isVoid(method.returnType),
      );
    let cleanupName = "NULL";
    if (cleanup) {
      cleanupName = `copl_finalize_${instance.cName}`;
      lines.push(
        `void ${this.methodName(instance, cleanup)}(${instance.cName}* self);`,
      );
      lines.push(
        `static void ${cleanupName}(void* object) { ${this.methodName(instance, cleanup)}((${instance.cName}*)object); }`,
      );
    }
    lines.push(
      `static const copl_type_descriptor ${name} = { COPL_TYPE_CLASS, sizeof(${instance.cName}), 0, ${traceName}, ${cleanupName} };`,
    );
    this.gcDescriptors.push(lines.join("\n"));
    return name;
  }

  private arrayDescriptor(type: SemType): string {
    if (type.kind !== "array" || !this.typeNeedsGcTrace(type.element)) {
      return "NULL";
    }
    const name = `copl_desc_array_${sanitize(typeKey(type))}`;
    const cached = this.arrayDescriptors.get(name);
    if (cached) {
      return `&${name}`;
    }
    this.arrayDescriptors.set(name, name);
    const element = type.element;
    const elementC = this.cType(element);
    const traceName = `copl_trace_array_${sanitize(typeKey(type))}`;
    const mark = this.gcFieldMark(element, "elements[index]");
    const lines: string[] = [
      `static void ${traceName}(void* object, size_t size) {`,
      `    ${elementC}* elements = (${elementC}*)object;`,
      `    size_t count = size / sizeof(${elementC});`,
      "    for (size_t index = 0; index < count; index += 1) {",
    ];
    if (mark) {
      lines.push(`        ${mark}`);
    }
    lines.push("    }", "}");
    lines.push(
      `static const copl_type_descriptor ${name} = { COPL_TYPE_ARRAY, 0, sizeof(${elementC}), ${traceName}, NULL };`,
    );
    this.gcDescriptors.push(lines.join("\n"));
    return `&${name}`;
  }

  private rootKind(type: SemType, instance?: Instance): "object" | "array" | undefined {
    const resolved = instance ? substitute(type, instance.map) : this.realizeType(type);
    if (resolved.kind === "array") {
      return "array";
    }
    if (resolved.kind === "class") {
      if (resolved.symbol.kind === "class" && resolved.symbol.isExtern) {
        return undefined;
      }
      return "object";
    }
    if (resolved.kind === "nullable") {
      return this.rootKind(resolved.inner, instance);
    }
    return undefined;
  }

  private emitRootRegistration(
    slot: string,
    type: SemType,
    instance?: Instance,
  ): void {
    const kind = this.rootKind(type, instance);
    if (kind) {
      this.emitLine(
        `copl_gc_push_root((void*)&${slot}, ${kind === "array" ? "true" : "false"});`,
      );
    }
  }

  private emitStruct(instance: Instance): void {
    if (this.emittedStructs.has(instance.cName)) {
      return;
    }
    this.emittedStructs.add(instance.cName);
    const base = this.baseInstance(instance);
    if (base) {
      this.emitStruct(base);
    }
    const lines: string[] = [`typedef struct ${instance.cName} {`];
    if (base) {
      lines.push(`    ${base.cName} copl_base;`);
    } else {
      lines.push("    int32_t copl_type_id;");
    }
    for (const field of instance.symbol.fields.values()) {
      if (field.isStatic) {
        continue;
      }
      lines.push(
        `    ${this.cType(field.type, instance)} ${this.fieldCName(field)};`,
      );
    }
    if (lines.length === 1) {
      lines.push("    uint8_t copl_padding;");
    }
    lines.push(`} ${instance.cName};`);
    this.structs.push(lines.join("\n"));
  }

  private emitPrototypes(instance: Instance): void {
    if (this.emittedPrototypes.has(instance.cName)) {
      return;
    }
    this.emittedPrototypes.add(instance.cName);
    for (const constructor of instance.symbol.constructors) {
      const params = constructor.params
        .map((param) => `${this.cType(param.type, instance)} ${this.localCName(param.name)}`)
        .join(", ");
      const suffix = params.length > 0 ? `, ${params}` : "";
      this.prototypes.push(
        `void ${this.constructorName(instance, constructor)}(${instance.cName}* self${suffix});`,
      );
      this.prototypes.push(
        `${instance.cName}* ${this.newName(instance, constructor)}(${params});`,
      );
    }
    for (const overloads of instance.symbol.methods.values()) {
      for (const method of overloads) {
        if (method.isExtern) {
          continue;
        }
        const params = method.params
          .map((param) => `${this.cType(param.type, instance)} ${this.localCName(param.name)}`);
        const variadic = method.isVariadic ? `, ...` : "";
        const signature = method.isStatic
          ? `${this.cType(method.returnType, instance)} ${this.methodName(instance, method)}(${params.join(", ")}${variadic})`
          : `${this.cType(method.returnType, instance)} ${this.methodName(instance, method)}(${instance.cName}* self${params.length > 0 ? `, ${params.join(", ")}` : ""}${variadic})`;
        this.prototypes.push(`${signature};`);
      }
    }
    this.prototypes.push(
      `void ${this.copyIntoName(instance)}(${instance.cName}* dst, ${instance.cName}* src);`,
    );
    this.prototypes.push(
      `${instance.cName}* ${this.copyName(instance)}(${instance.cName}* src);`,
    );
    if (this.hasStaticInit(instance)) {
      this.prototypes.push(`void ${this.staticInitName(instance)}(void);`);
    }
  }

  private hasStaticInit(instance: Instance): boolean {
    for (const field of instance.symbol.fields.values()) {
      if (field.isStatic && field.decl.initializer) {
        return true;
      }
    }
    return false;
  }

  private emitStaticGlobals(instance: Instance): void {
    for (const field of instance.symbol.fields.values()) {
      if (!field.isStatic) {
        continue;
      }
      const name = this.staticFieldName(instance, field);
      if (this.emittedGlobals.has(name)) {
        continue;
      }
      this.emittedGlobals.add(name);
      this.globals.push(
        `${this.cType(field.type, instance)} ${name};`,
      );
    }
  }

  private emitFunctions(instance: Instance): void {
    if (this.emittedFunctions.has(instance.cName)) {
      return;
    }
    this.emittedFunctions.add(instance.cName);
    this.current = instance;
    for (const constructor of instance.symbol.constructors) {
      this.functions.push(this.buildConstructor(instance, constructor));
      this.functions.push(this.buildNew(instance, constructor));
    }
    for (const overloads of instance.symbol.methods.values()) {
      for (const method of overloads) {
        if (method.isExtern) {
          continue;
        }
        this.functions.push(this.buildMethod(instance, method));
      }
    }
    this.functions.push(this.buildCopyInto(instance));
    this.functions.push(this.buildCopy(instance));
    if (this.hasStaticInit(instance)) {
      this.functions.push(this.buildStaticInit(instance));
      this.staticInitCalls.push(`${this.staticInitName(instance)}();`);
    }
    this.current = undefined;
  }

  private buildFunction(signature: string, build: () => void): string {
    const oldBody = this.body;
    const oldIndent = this.indent;
    const oldScopes = this.scopes;
    const oldControl = this.controlStack;
    this.body = [];
    this.indent = 1;
    this.scopes = [];
    this.controlStack = [];
    build();
    const body = this.body.join("\n");
    this.body = oldBody;
    this.indent = oldIndent;
    this.scopes = oldScopes;
    this.controlStack = oldControl;
    return `${signature} {\n${body}\n}`;
  }

  private constructorParams(instance: Instance, constructor: ConstructorSymbol): string {
    return constructor.params
      .map((param) => `${this.cType(param.type, instance)} ${this.localCName(param.name)}`)
      .join(", ");
  }

  private pushParamScope(params: readonly ParamSymbol[]): void {
    const scope = new Map<string, string>();
    for (const param of params) {
      scope.set(param.name, this.localCName(param.name));
    }
    this.scopes.push(scope);
  }

  private buildConstructor(
    instance: Instance,
    constructor: ConstructorSymbol,
  ): string {
    const params = this.constructorParams(instance, constructor);
    const selfParam = params.length > 0 ? `self, ${params}` : "self";
    const signature = `void ${this.constructorName(instance, constructor)}(${instance.cName}* self${params.length > 0 ? `, ${params}` : ""})`;
    this.currentFrameName = "copl_frame";
    const text = this.buildFunction(signature, () => {
      this.pushParamScope(constructor.params);
      this.emitLine("copl_gc_frame copl_frame = copl_gc_frame_enter();");
      this.emitLine("copl_gc_push_root((void*)&self, false);");
      for (const param of constructor.params) {
        this.emitRootRegistration(this.localCName(param.name), param.type, instance);
      }
      this.emitLine(`memset(self, 0, sizeof(*self));`);
      let startIndex = 0;
      const body = constructor.decl?.body;
      const first = body?.statements[0];
      if (
        first &&
        first.kind === "ExprStmt" &&
        first.expression.kind === "CallExpr" &&
        first.expression.callee.kind === "SuperExpr"
      ) {
        this.emitSuperConstructorCall(instance, first.expression);
        startIndex = 1;
      } else if (instance.symbol.superClass) {
        this.emitDefaultSuperConstructor(instance);
      }
      this.emitLine(`*((int32_t*)self) = ${instance.typeId};`);
      for (const field of instance.symbol.fields.values()) {
        if (!field.isStatic && field.decl.initializer) {
          const hint = this.arrayHint(field.decl.type);
          const value = field.type.kind === "task"
            ? this.emitTaskHandle(field.decl.initializer, hint)
            : this.emitExpr(field.decl.initializer, hint);
          this.emitLine(
            `self->${this.fieldCName(field)} = ${value};`,
          );
        }
      }
      if (body) {
        for (let index = startIndex; index < body.statements.length; index += 1) {
          this.emitStmt(body.statements[index]!);
        }
      }
      this.emitLine("copl_gc_frame_leave(&copl_frame);");
      this.scopes.pop();
      void selfParam;
    });
    this.currentFrameName = undefined;
    const span = constructor.decl?.span ?? instance.symbol.decl.span;
    return `${this.lineDirective(span)}
${text}`;
  }

  private buildNew(
    instance: Instance,
    constructor: ConstructorSymbol,
  ): string {
    const params = constructor.params
      .map((param) => `${this.cType(param.type, instance)} ${this.localCName(param.name)}`)
      .join(", ");
    const args = constructor.params
      .map((param) => this.localCName(param.name))
      .join(", ");
    const descriptor = this.classDescriptor(instance);
    const signature = `${instance.cName}* ${this.newName(instance, constructor)}(${params})`;
    return this.buildFunction(signature, () => {
      const self = this.temp("new");
      this.emitLine(
        `${instance.cName}* ${self} = (${instance.cName}*)copl_gc_alloc_object(sizeof(${instance.cName}), &${descriptor});`,
      );
      this.emitLine("if (!" + self + ") { copl_panic(\"out of memory\"); }");
      this.emitLine(
        `${this.constructorName(instance, constructor)}(${self}${args.length > 0 ? `, ${args}` : ""});`,
      );
      this.emitLine(`return ${self};`);
    });
  }

  private emitSuperConstructorCall(instance: Instance, call: ast.CallExpr): void {
    const base = this.baseInstance(instance);
    if (!base) {
      this.fail("class has no superclass constructor", call.span);
    }
    const constructor = this.model.superConstructorCalls.get(call) ??
      base.symbol.constructors.find((candidate) => candidate.params.length === 0);
    if (!constructor) {
      this.fail("missing superclass constructor", call.span);
    }
    const args = call.args.map((arg) => this.emitExpr(arg));
    this.emitLine(
      `${this.constructorName(base, constructor)}(&(self)->copl_base${args.length > 0 ? `, ${args.join(", ")}` : ""});`,
    );
  }

  private emitDefaultSuperConstructor(instance: Instance): void {
    const base = this.baseInstance(instance);
    if (!base) {
      return;
    }
    const constructor = base.symbol.constructors.find(
      (candidate) => candidate.params.length === 0,
    );
    if (!constructor) {
      this.fail(
        `'${instance.symbol.qualifiedName}' requires a no-argument base constructor`,
      );
    }
    this.emitLine(
      `${this.constructorName(base, constructor)}(&(self)->copl_base);`,
    );
  }

  private buildMethod(instance: Instance, method: MethodSymbol): string {
    const params = method.params
      .map((param) => `${this.cType(param.type, instance)} ${this.localCName(param.name)}`)
      .join(", ");
    const variadic = method.isVariadic ? `, ...` : "";
    const signature = method.isStatic
      ? `${this.cType(method.returnType, instance)} ${this.methodName(instance, method)}(${params}${variadic})`
      : `${this.cType(method.returnType, instance)} ${this.methodName(instance, method)}(${instance.cName}* self${params.length > 0 ? `, ${params}` : ""}${variadic})`;
    const oldReturnType = this.currentReturnType;
    this.currentReturnType = method.returnType;
    this.currentFrameName = "copl_frame";
    this.currentVariadicName = method.isVariadic ? "copl_va" : undefined;
    const text = this.buildFunction(signature, () => {
      this.pushParamScope(method.params);
      this.emitLine("copl_gc_frame copl_frame = copl_gc_frame_enter();");
      if (!method.isStatic) {
        this.emitLine("copl_gc_push_root((void*)&self, false);");
      }
      for (const param of method.params) {
        this.emitRootRegistration(this.localCName(param.name), param.type, instance);
      }
      if (method.isVariadic) {
        const lastNamed = method.params.length > 0
          ? this.localCName(method.params[method.params.length - 1]!.name)
          : "self";
        this.emitLine("va_list copl_va;");
        this.emitLine(`va_start(copl_va, ${lastNamed});`);
      }
      if (method.decl.body) {
        this.emitStmt(method.decl.body);
      }
      if (method.isVariadic) {
        this.emitLine("va_end(copl_va);");
      }
      this.emitLine("copl_gc_frame_leave(&copl_frame);");
      this.scopes.pop();
    });
    this.currentFrameName = undefined;
    this.currentVariadicName = undefined;
    this.currentReturnType = oldReturnType;
    return `${this.lineDirective(method.decl.span)}
${text}`;
  }

  private buildCopyInto(instance: Instance): string {
    const signature =
      `void ${this.copyIntoName(instance)}(${instance.cName}* dst, ${instance.cName}* src)`;
    return this.buildFunction(signature, () => {
      this.emitLine("if (src == NULL) {");
      this.indent += 1;
      this.emitLine("memset(dst, 0, sizeof(*dst));");
      this.emitLine("return;");
      this.indent -= 1;
      this.emitLine("}");
      const base = this.baseInstance(instance);
      if (base) {
        this.emitLine(
          `${this.copyIntoName(base)}(&(dst)->copl_base, &(src)->copl_base);`,
        );
      }
      this.emitLine(`*((int32_t*)dst) = ${instance.typeId};`);
      for (const field of instance.symbol.fields.values()) {
        if (field.isStatic) {
          continue;
        }
        const fieldName = this.fieldCName(field);
        const source = `src->${fieldName}`;
        this.emitLine(
          `dst->${fieldName} = ${this.copyValue(source, field.type, instance)};`,
        );
      }
    });
  }

  private buildCopy(instance: Instance): string {
    const descriptor = this.classDescriptor(instance);
    const signature = `${instance.cName}* ${this.copyName(instance)}(${instance.cName}* src)`;
    return this.buildFunction(signature, () => {
      this.emitLine("if (src == NULL) {");
      this.indent += 1;
      this.emitLine("return NULL;");
      this.indent -= 1;
      this.emitLine("}");
      this.emitLine(
        `${instance.cName}* dst = (${instance.cName}*)copl_gc_alloc_object(sizeof(${instance.cName}), &${descriptor});`,
      );
      this.emitLine("if (dst == NULL) { copl_panic(\"out of memory\"); }");
      this.emitLine(`${this.copyIntoName(instance)}(dst, src);`);
      this.emitLine("return dst;");
    });
  }

  private buildStaticInit(instance: Instance): string {
    const signature = `void ${this.staticInitName(instance)}(void)`;
    return this.buildFunction(signature, () => {
      for (const field of instance.symbol.fields.values()) {
        if (!field.isStatic || !field.decl.initializer) {
          continue;
        }
        const value = field.type.kind === "task"
          ? this.emitTaskHandle(field.decl.initializer)
          : this.emitExpr(field.decl.initializer);
        this.emitLine(
          `${this.staticFieldName(instance, field)} = ${value};`,
        );
      }
    });
  }

  private emitMain(): string {
    const lines: string[] = ["int main(int argc, char** argv) {"];
    this.body = [];
    this.indent = 1;
    this.scopes = [];
    this.current = undefined;
    for (const instance of this.queue) {
      for (const field of instance.symbol.fields.values()) {
        if (!field.isStatic) {
          continue;
        }
        const kind = this.rootKind(field.type, instance);
        if (kind) {
          this.emitLine(
            `copl_gc_push_root((void*)&${this.staticFieldName(instance, field)}, ${kind === "array" ? "true" : "false"});`,
          );
        }
      }
    }
    for (const call of this.staticInitCalls) {
      this.emitLine(call);
    }
    if (this.entry?.method && this.entryInstance) {
      const method = this.entry.method;
      const instance = this.entryInstance;
      const constructor = instance.symbol.constructors.find(
        (candidate) => candidate.params.length === 0,
      );
      let selfName: string | undefined;
      if (!method.isStatic) {
        if (!constructor) {
          this.fail(
            `entry class '${instance.symbol.qualifiedName}' needs a no-argument constructor`,
          );
        }
        selfName = this.temp("entry");
        this.emitLine(
          `${instance.cName}* ${selfName} = ${this.newName(instance, constructor)}();`,
        );
        this.emitLine(`copl_gc_push_root((void*)&${selfName}, false);`);
      }
      let args = "";
      if (method.params.length > 0) {
        if (method.params.length === 1 && method.params[0]!.type.kind === "array") {
          args = "copl_args_from_main(argc, argv)";
        } else {
          this.fail(
            `entry method '${method.name}' has unsupported parameters`,
          );
        }
      }
      const callArgs = method.isStatic
        ? args
        : `${selfName}${args.length > 0 ? `, ${args}` : ""}`;
      const call = `${this.methodName(instance, method)}(${callArgs})`;
      if (isVoid(method.returnType)) {
        this.emitLine(`${call};`);
        this.emitLine("return 0;");
      } else {
        this.emitLine(`return (int)(${call});`);
      }
    } else {
      this.emitLine("(void)argc;");
      this.emitLine("(void)argv;");
      this.emitLine("return 0;");
    }
    this.indent = 0;
    const body = this.body.join("\n");
    this.body = [];
    lines.push(body);
    lines.push("}");
    return lines.join("\n");
  }

  private findEntry(): EntryPoint | undefined {
    const unit = this.project.units.get(this.project.entryPath);
    if (!unit) {
      return undefined;
    }
    const classes: TypeSymbol[] = [];
    for (const namespace of unit.namespaces) {
      const prefix = namespace.name.join("::");
      for (const member of namespace.members) {
        if (member.kind !== "ClassDecl") {
          continue;
        }
        const key = prefix.length > 0 ? `${prefix}::${member.name}` : member.name;
        const symbol = this.model.symbols.get(key);
        if (symbol) {
          classes.push(symbol);
        }
      }
    }
    const chosen =
      classes.find((symbol) => (symbol.methods.get("main")?.length ?? 0) > 0) ??
      classes.find(
        (symbol) =>
          symbol.name === "App" &&
          (symbol.methods.get("run")?.length ?? 0) > 0,
      ) ??
      classes.find((symbol) => (symbol.methods.get("run")?.length ?? 0) > 0) ??
      classes[0];
    if (!chosen) {
      return undefined;
    }
    const method =
      chosen.methods.get("main")?.[0] ??
      chosen.methods.get("run")?.[0];
    if (chosen.typeParams.length > 0) {
      this.fail(
        `entry class '${chosen.qualifiedName}' cannot be generic`,
      );
    }
    const instance = this.ensureInstance(classType(chosen));
    return { instance, method };
  }

  private temp(prefix: string): string {
    const id = this.tempId;
    this.tempId += 1;
    return `copl_tmp_${sanitize(prefix)}_${id}`;
  }

  private emitLine(text: string): void {
    this.body.push(`${"    ".repeat(this.indent)}${text}`);
  }

  private lineDirective(span: ast.Node["span"]): string {
    return `#line ${span.start.line} ${cString(span.file)}`;
  }

  private pushScope(): void {
    this.scopes.push(new Map());
  }

  private popScope(): void {
    this.scopes.pop();
  }

  private declareLocal(name: string): string {
    const cName = this.localCName(name);
    const scope = this.scopes[this.scopes.length - 1];
    if (!scope) {
      this.fail(`internal codegen scope error for '${name}'`);
    }
    scope.set(name, cName);
    return cName;
  }

  private lookupLocal(name: string): string | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const found = this.scopes[index]!.get(name);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  private arrayHint(ref: ast.TypeRef | undefined): string | undefined {
    if (ref?.kind !== "ArrayType" || !ref.size) {
      return undefined;
    }
    return this.emitExpr(ref.size);
  }

  private emitStmt(stmt: ast.Stmt): void {
    switch (stmt.kind) {
      case "BlockStmt": {
        const marker = this.temp("roots");
        this.emitLine("{");
        this.indent += 1;
        this.pushScope();
        this.emitLine(`size_t ${marker} = copl_gc_root_count();`);
        for (const child of stmt.statements) {
          this.emitStmt(child);
          this.emitLine("copl_gc_safepoint();");
        }
        this.emitLine(`copl_gc_pop_roots_to(${marker});`);
        this.popScope();
        this.indent -= 1;
        this.emitLine("}");
        return;
      }
      case "VarDeclStmt":
        this.emitVarDecl(stmt);
        return;
      case "ExprStmt": {
        if (stmt.expression.kind === "WorkerCallExpr") {
          const task = this.emitTaskHandle(stmt.expression);
          this.emitLine(`copl_task_detach(${task});`);
          return;
        }
        const value = this.emitExpr(stmt.expression);
        this.emitLine(`${value};`);
        return;
      }
      case "AssignStmt":
        this.emitAssign(stmt);
        return;
      case "IfStmt":
        this.emitIf(stmt);
        return;
      case "WhileStmt":
        this.emitWhile(stmt);
        return;
      case "ForStmt":
        this.emitFor(stmt);
        return;
      case "SwitchStmt":
        this.emitSwitch(stmt);
        return;
      case "ReturnStmt": {
        let line = "return;";
        if (stmt.value) {
          const value = this.currentReturnType?.kind === "task"
            ? this.emitTaskHandle(stmt.value)
            : this.emitExpr(stmt.value);
          line = `return ${value};`;
        }
        if (this.currentVariadicName) {
          this.emitLine(`va_end(${this.currentVariadicName});`);
        }
        if (this.currentFrameName) {
          this.emitLine(`copl_gc_frame_leave(&${this.currentFrameName});`);
        }
        this.emitLine(line);
        return;
      }
      case "BreakStmt": {
        const control = [...this.controlStack]
          .reverse()
          .find((entry) => entry.breakMarker);
        if (!control) {
          this.fail("break outside a loop or switch", stmt.span);
        }
        this.emitLine(`copl_gc_pop_roots_to(${control.breakMarker});`);
        this.emitLine("break;");
        return;
      }
      case "ContinueStmt": {
        const control = [...this.controlStack]
          .reverse()
          .find((entry) => entry.continueMarker);
        if (!control?.continueMarker) {
          this.fail("continue outside a loop", stmt.span);
        }
        this.emitLine(`copl_gc_pop_roots_to(${control.continueMarker});`);
        this.emitLine("continue;");
        return;
      }
      case "EnvDefaultStmt":
        this.emitLine(
          `copl_env_default(copl_string_lit(${cString(stmt.name)}, ${Buffer.byteLength(stmt.name, "utf8")}), ${this.emitExpr(stmt.value)});`,
        );
        return;
    }
  }

  private emitScopedStmt(stmt: ast.Stmt): void {
    this.emitLine("{");
    this.indent += 1;
    this.pushScope();
    this.emitStmt(stmt);
    this.popScope();
    this.indent -= 1;
    this.emitLine("}");
  }

  private emitVarDecl(stmt: ast.VarDeclStmt): void {
    const type = this.typeOfRef(stmt.type);
    const cType = this.cType(type);
    const name = this.declareLocal(stmt.name);
    const hint = this.arrayHint(stmt.type);
    if (stmt.initializer) {
      const value = type.kind === "task"
        ? this.emitTaskHandle(stmt.initializer, hint)
        : this.emitExpr(stmt.initializer, hint);
      this.emitLine(`${cType} ${name} = ${value};`);
      this.emitRootRegistration(name, type);
      return;
    }
    if (type.kind === "array") {
      const elem = this.cType(type.element);
      const size = hint ?? "0";
      const descriptor = this.arrayDescriptor(type);
      this.emitLine(
        `${cType} ${name} = copl_array_alloc_with((size_t)(${size}), sizeof(${elem}), ${descriptor});`,
      );
      this.emitRootRegistration(name, type);
      return;
    }
    if (type.kind === "nullable" && type.inner.kind === "array") {
      const elem = this.cType(type.inner.element);
      const size = hint ?? "0";
      const descriptor = this.arrayDescriptor(type.inner);
      this.emitLine(
        `${cType} ${name} = copl_array_alloc_with((size_t)(${size}), sizeof(${elem}), ${descriptor});`,
      );
      this.emitRootRegistration(name, type);
      return;
    }
    if (
      type.kind === "class" ||
      type.kind === "nullable" ||
      type.kind === "task" ||
      type.kind === "pointer" ||
      type.kind === "meta"
    ) {
      this.emitLine(`${cType} ${name} = NULL;`);
      this.emitRootRegistration(name, type);
      return;
    }
    this.emitLine(`${cType} ${name};`);
  }

  private emitAssign(stmt: ast.AssignStmt): void {
    if (stmt.target.kind === "SelfExpr") {
      if (!this.current) {
        this.fail("self assignment outside codegen class", stmt.span);
      }
      if (
        stmt.value.kind === "CallExpr" &&
        stmt.value.callee.kind === "IdentifierExpr" &&
        stmt.value.callee.name === "copy" &&
        stmt.value.args.length === 1
      ) {
        const source = this.emitExpr(stmt.value.args[0]!);
        this.emitLine(
          `${this.copyIntoName(this.current)}(self, ${source});`,
        );
        return;
      }
      const value = this.emitExpr(stmt.value);
      this.emitLine(
        `${this.copyIntoName(this.current)}(self, ${value});`,
      );
      return;
    }
    const target = this.emitLValue(stmt.target);
    const targetType = this.typeOf(stmt.target);
    const value = targetType.kind === "task"
      ? this.emitTaskHandle(stmt.value)
      : this.emitExpr(stmt.value);
    this.emitLine(`${target} ${stmt.op} ${value};`);
  }

  private emitIf(stmt: ast.IfStmt): void {
    const condition = this.emitExpr(stmt.condition);
    this.emitLine(`if (${condition}) {`);
    this.indent += 1;
    this.pushScope();
    const thenMarker = this.temp("roots");
    this.emitLine(`size_t ${thenMarker} = copl_gc_root_count();`);
    this.emitStmt(stmt.thenBranch);
    this.emitLine("copl_gc_safepoint();");
    this.emitLine(`copl_gc_pop_roots_to(${thenMarker});`);
    this.popScope();
    this.indent -= 1;
    if (stmt.elseBranch) {
      this.emitLine("} else {");
      this.indent += 1;
      this.pushScope();
      const elseMarker = this.temp("roots");
      this.emitLine(`size_t ${elseMarker} = copl_gc_root_count();`);
      this.emitStmt(stmt.elseBranch);
      this.emitLine("copl_gc_safepoint();");
      this.emitLine(`copl_gc_pop_roots_to(${elseMarker});`);
      this.popScope();
      this.indent -= 1;
    }
    this.emitLine("}");
  }

  private emitWhile(stmt: ast.WhileStmt): void {
    const condition = this.emitExpr(stmt.condition);
    const breakMarker = this.temp("break_roots");
    this.emitLine(`size_t ${breakMarker} = copl_gc_root_count();`);
    this.emitLine(`while (${condition}) {`);
    this.indent += 1;
    this.pushScope();
    const marker = this.temp("roots");
    this.emitLine(`size_t ${marker} = copl_gc_root_count();`);
    this.controlStack.push({ breakMarker, continueMarker: marker });
    this.emitStmt(stmt.body);
    this.controlStack.pop();
    this.emitLine("copl_gc_safepoint();");
    this.emitLine(`copl_gc_pop_roots_to(${marker});`);
    this.popScope();
    this.indent -= 1;
    this.emitLine("}");
  }

  private emitFor(stmt: ast.ForStmt): void {
    this.pushScope();
    let initializer = "";
    let initRoot: { name: string; type: SemType } | undefined;
    if (stmt.initializer) {
      if (stmt.initializer.kind === "VarDeclStmt") {
        const type = this.typeOfRef(stmt.initializer.type);
        const cType = this.cType(type);
        const name = this.declareLocal(stmt.initializer.name);
        initRoot = { name, type };
        const hint = this.arrayHint(stmt.initializer.type);
        if (stmt.initializer.initializer) {
          const value = type.kind === "task"
            ? this.emitTaskHandle(stmt.initializer.initializer, hint)
            : this.emitExpr(stmt.initializer.initializer, hint);
          initializer = `${cType} ${name} = ${value}`;
        } else {
          initializer = `${cType} ${name}`;
        }
      } else if (stmt.initializer.kind === "AssignStmt") {
        initializer = this.emitAssignExpression(stmt.initializer);
      } else {
        initializer = this.emitExpr(stmt.initializer.expression);
      }
    }
    const condition = stmt.condition ? this.emitExpr(stmt.condition) : "";
    let update = "";
    if (stmt.update) {
      update = stmt.update.kind === "AssignStmt"
        ? this.emitAssignExpression(stmt.update)
        : this.emitExpr(stmt.update.expression);
    }
    const breakMarker = this.temp("break_roots");
    this.emitLine(`size_t ${breakMarker} = copl_gc_root_count();`);
    this.emitLine(`for (${initializer}; ${condition}; ${update}) {`);
    this.indent += 1;
    this.pushScope();
    const marker = this.temp("roots");
    this.emitLine(`size_t ${marker} = copl_gc_root_count();`);
    if (initRoot) {
      this.emitRootRegistration(initRoot.name, initRoot.type);
    }
    this.controlStack.push({ breakMarker, continueMarker: marker });
    this.emitStmt(stmt.body);
    this.controlStack.pop();
    this.emitLine("copl_gc_safepoint();");
    this.emitLine(`copl_gc_pop_roots_to(${marker});`);
    this.popScope();
    this.indent -= 1;
    this.emitLine("}");
    this.popScope();
  }

  private emitAssignExpression(stmt: ast.AssignStmt): string {
    if (stmt.target.kind === "SelfExpr") {
      this.fail("self assignment is only supported as a constructor statement", stmt.span);
    }
    const targetType = this.typeOf(stmt.target);
    const value = targetType.kind === "task"
      ? this.emitTaskHandle(stmt.value)
      : this.emitExpr(stmt.value);
    return `${this.emitLValue(stmt.target)} ${stmt.op} ${value}`;
  }

  private emitSwitch(stmt: ast.SwitchStmt): void {
    const discriminant = this.emitExpr(stmt.discriminant);
    const breakMarker = this.temp("break_roots");
    this.emitLine(`size_t ${breakMarker} = copl_gc_root_count();`);
    this.emitLine(`switch (${discriminant}) {`);
    this.indent += 1;
    for (const switchCase of stmt.cases) {
      if (switchCase.value) {
        this.emitLine(`case ${this.emitExpr(switchCase.value)}:`);
      } else {
        this.emitLine("default:");
      }
      this.indent += 1;
      this.pushScope();
      this.emitLine("{");
      this.indent += 1;
      const marker = this.temp("roots");
      this.emitLine(`size_t ${marker} = copl_gc_root_count();`);
      this.controlStack.push({ breakMarker });
      for (const child of switchCase.statements) {
        this.emitStmt(child);
        this.emitLine("copl_gc_safepoint();");
      }
      this.controlStack.pop();
      this.emitLine(`copl_gc_pop_roots_to(${marker});`);
      this.indent -= 1;
      this.emitLine("}");
      this.popScope();
      this.indent -= 1;
    }
    this.indent -= 1;
    this.emitLine("}");
  }

  private emitExpr(expr: ast.Expr, hint?: string): string {
    const value = this.emitExprRaw(expr, hint);
    const type = this.typeOf(expr);
    if (type.kind === "task") {
      return this.joinTaskValue(value, type.result);
    }
    return value;
  }

  private emitTaskHandle(expr: ast.Expr, hint?: string): string {
    return this.emitExprRaw(expr, hint);
  }

  private joinTaskValue(handle: string, result: SemType): string {
    if (isVoid(result)) {
      return `((void)copl_task_join(${handle}))`;
    }
    return `(*(( ${this.cType(result)}*)copl_task_join(${handle})))`;
  }

  private emitExprRaw(expr: ast.Expr, hint?: string): string {
    switch (expr.kind) {
      case "IntLiteralExpr":
        return expr.value.toString();
      case "FloatLiteralExpr":
        return expr.raw;
      case "StringLiteralExpr":
        return `copl_string_lit(${cString(expr.value)}, ${Buffer.byteLength(expr.value, "utf8")})`;
      case "CharLiteralExpr":
        return charLiteral(expr.value);
      case "BoolLiteralExpr":
        return expr.value ? "true" : "false";
      case "NullLiteralExpr":
        return "NULL";
      case "IdentifierExpr":
        return this.emitIdentifier(expr);
      case "SelfExpr":
        return "self";
      case "SuperExpr":
        return this.emitSuperPointer();
      case "MemberExpr":
        return this.emitMember(expr);
      case "IndexExpr":
        return this.emitIndex(expr);
      case "CallExpr":
        return this.emitCall(expr);
      case "NewObjectExpr":
        return this.emitNewObject(expr);
      case "NewArrayExpr": {
        const element = this.typeOfRef(expr.elementType);
        const size = this.emitExpr(expr.size);
        const descriptor = this.arrayDescriptor(arrayType(element));
        return `copl_array_alloc_with((size_t)(${size}), sizeof(${this.cType(element)}), ${descriptor})`;
      }
      case "CastExpr": {
        const target = this.typeOfRef(expr.target);
        return `((${this.cType(target)})(${this.emitExpr(expr.value)}))`;
      }
      case "UnaryExpr":
        return `(${expr.op}${this.emitExpr(expr.operand)})`;
      case "UpdateExpr": {
        const target = this.emitLValue(expr.operand);
        return expr.prefix ? `(${expr.op}${target})` : `(${target}${expr.op})`;
      }
      case "BinaryExpr":
        return this.emitBinary(expr);
      case "TernaryExpr":
        return `(${this.emitExpr(expr.condition)} ? ${this.emitExpr(expr.thenExpr)} : ${this.emitExpr(expr.elseExpr)})`;
      case "SpreadExpr":
        this.fail("spread expression outside an array literal", expr.span);
        break;
      case "ArrayLiteralExpr":
        return this.emitArrayLiteral(expr, hint);
      case "WorkerCallExpr":
        return this.emitWorkerCall(expr);
      case "TaskProbeExpr": {
        const handle = this.emitTaskHandle(expr.expression);
        return `copl_task_is_done(${handle})`;
      }
    }
  }

  private emitIdentifier(expr: ast.IdentifierExpr): string {
    const local = this.lookupLocal(expr.name);
    if (local) {
      return local;
    }
    if (!this.current) {
      this.fail(`unknown identifier '${expr.name}'`, expr.span);
    }
    const field = this.findField(this.current.symbol, expr.name);
    if (field?.isStatic) {
      const owner = this.fieldInstance(this.current, field);
      return this.staticFieldName(owner, field);
    }
    const type = this.model.expressionTypes.get(expr);
    if (type?.kind === "meta") {
      this.fail(`type '${expr.name}' is not a value`, expr.span);
    }
    this.fail(`unknown identifier '${expr.name}'`, expr.span);
  }

  private emitSuperPointer(): string {
    if (!this.current) {
      this.fail("super outside codegen class");
    }
    const base = this.baseInstance(this.current);
    if (!base) {
      this.fail("class has no superclass");
    }
    return `(&(self)->copl_base)`;
  }

  private emitMember(expr: ast.MemberExpr): string {
    const objectType = this.valueTypeOf(expr.object);
    if (objectType.kind === "meta") {
      if (objectType.symbol.kind === "enum") {
        if (!objectType.symbol.enumMembers.has(expr.member)) {
          this.fail(`unknown enum member '${expr.member}'`, expr.span);
        }
        return this.enumMemberCName(objectType.symbol, expr.member);
      }
      const field = this.findField(objectType.symbol, expr.member);
      if (!field || !field.isStatic) {
        this.fail(`unknown static attribute '${expr.member}'`, expr.span);
      }
      const owner = this.instanceForSymbol(field.owner);
      return this.staticFieldName(owner, field);
    }
    if (objectType.kind === "array") {
      if (expr.member === "len") {
        return `((int64_t)((${this.emitExpr(expr.object)}).len))`;
      }
      this.fail(`arrays have no member '${expr.member}'`, expr.span);
    }
    if (objectType.kind !== "class") {
      this.fail(`cannot access member '${expr.member}'`, expr.span);
    }
    const field = this.findField(objectType.symbol, expr.member);
    if (!field) {
      this.fail(`unknown member '${expr.member}'`, expr.span);
    }
    const receiver = this.emitExpr(expr.object);
    const receiverInstance = this.ensureInstance(objectType);
    const owner = this.fieldInstance(receiverInstance, field);
    const pointer = this.basePointer(receiver, receiverInstance, field.owner);
    void owner;
    return `(${pointer})->${this.fieldCName(field)}`;
  }

  private emitIndex(expr: ast.IndexExpr): string {
    const objectType = this.valueTypeOf(expr.object);
    const object = this.emitExpr(expr.object);
    const index = this.emitExpr(expr.index);
    if (objectType.kind === "array") {
      return `(*(${this.cType(objectType.element)}*)copl_array_at(${object}, (int64_t)(${index})))`;
    }
    if (objectType.kind === "pointer" && objectType.target) {
      return `((${this.cType(objectType.target)}*)(${object}))[${index}]`;
    }
    this.fail("cannot index expression", expr.span);
  }

  private emitLValue(expr: ast.Expr): string {
    switch (expr.kind) {
      case "IdentifierExpr": {
        const local = this.lookupLocal(expr.name);
        if (local) {
          return local;
        }
        if (!this.current) {
          this.fail(`unknown variable '${expr.name}'`, expr.span);
        }
        const field = this.findField(this.current.symbol, expr.name);
        if (field?.isStatic) {
          const owner = this.fieldInstance(this.current, field);
          return this.staticFieldName(owner, field);
        }
        this.fail(`unknown variable '${expr.name}'`, expr.span);
        break;
      }
      case "MemberExpr":
        return this.emitMember(expr);
      case "IndexExpr":
        return this.emitIndex(expr);
      default:
        this.fail("invalid assignment target", expr.span);
    }
  }

  private typeParamMap(type: ClassSemType): Map<string, SemType> {
    const map = new Map<string, SemType>();
    type.symbol.typeParams.forEach((param, index) => {
      map.set(
        `${type.symbol.qualifiedName}::${param.name}`,
        type.args[index] ?? {
          kind: "typeParam",
          owner: type.symbol.qualifiedName,
          name: param.name,
        },
      );
    });
    return map;
  }

  private interfaceSatisfies(
    iface: ClassSemType,
    target: ClassSemType,
  ): boolean {
    if (
      iface.symbol === target.symbol &&
      iface.args.length === target.args.length &&
      iface.args.every((arg, index) => typesEqual(arg, target.args[index]!))
    ) {
      return true;
    }
    const map = this.typeParamMap(iface);
    for (const extended of iface.symbol.interfaces) {
      const resolved = substitute(extended, map);
      if (
        resolved.kind === "class" &&
        this.interfaceSatisfies(resolved, target)
      ) {
        return true;
      }
    }
    return false;
  }

  private symbolImplements(
    symbol: TypeSymbol,
    map: ReadonlyMap<string, SemType>,
    target: ClassSemType,
  ): boolean {
    for (const declared of symbol.interfaces) {
      const resolved = substitute(declared, map);
      if (
        resolved.kind === "class" &&
        this.interfaceSatisfies(resolved, target)
      ) {
        return true;
      }
    }
    if (symbol.superClass) {
      const superType = substitute(symbol.superClass, map);
      if (superType.kind === "class") {
        return this.symbolImplements(
          superType.symbol,
          this.typeParamMap(superType),
          target,
        );
      }
    }
    return false;
  }

  private implementsInterface(instance: Instance, target: ClassSemType): boolean {
    return this.symbolImplements(instance.symbol, instance.map, target);
  }

  private findMethodSymbol(
    symbol: TypeSymbol,
    name: string,
    params?: readonly SemType[],
    instance?: Instance,
  ): MethodSymbol | undefined {
    let current: TypeSymbol | undefined = symbol;
    while (current) {
      const overloads = current.methods.get(name) ?? [];
      for (const method of overloads) {
        if (!params) {
          return method;
        }
        if (
          method.params.length === params.length &&
          method.params.every((param, index) =>
            typesEqual(
              instance ? substitute(param.type, instance.map) : param.type,
              params[index]!,
            ),
          )
        ) {
          return method;
        }
      }
      current = current.superClass?.symbol;
    }
    return undefined;
  }

  private zeroValue(type: SemType): string {
    switch (type.kind) {
      case "primitive":
        if (type.name === "bool") {
          return "false";
        }
        return "0";
      case "class":
      case "pointer":
      case "meta":
      case "null":
        return "NULL";
      case "array":
        return `copl_array_empty(sizeof(${this.cType(type.element)}))`;
      case "nullable":
        return this.zeroValue(type.inner);
      case "task":
        return "NULL";
      case "enum":
        return "0";
      case "typeParam":
        return "0";
    }
  }

  private ensureInterfaceDispatcher(
    interfaceType: ClassSemType,
    method: MethodSymbol,
  ): string {
    const signatureKey = method.params.length === 0
      ? "void"
      : method.params
        .map((param) => sanitize(typeKey(param.type)))
        .join("_");
    const name = `copl_iface_${sanitize(typeKey(interfaceType))}__${sanitize(method.name)}__${signatureKey}`;
    if (this.interfaceDispatchers.has(name)) {
      return name;
    }
    this.interfaceDispatchers.set(name, name);
    const map = this.typeParamMap(interfaceType);
    const returnType = substitute(method.returnType, map);
    const params = method.params.map((param) => ({
      ...param,
      type: substitute(param.type, map),
    }));
    const paramDecls = params
      .map((param) => `${this.cType(param.type)} ${this.localCName(param.name)}`)
      .join(", ");
    const argNames = params.map((param) => this.localCName(param.name));
    const signature = `${this.cType(returnType)} ${name}(void* object${paramDecls.length > 0 ? `, ${paramDecls}` : ""})`;
    this.prototypes.push(`${signature};`);
    const lines: string[] = [`${signature} {`, "    switch (*((int32_t*)object)) {"];
    for (const instance of this.queue) {
      if (!this.implementsInterface(instance, interfaceType)) {
        continue;
      }
      const implementation = this.findMethodSymbol(
        instance.symbol,
        method.name,
        params.map((param) => param.type),
        instance,
      );
      if (!implementation) {
        continue;
      }
      const owner = this.ownerInstance(instance, implementation.owner);
      const selfPointer = this.basePointer(
        `((${instance.cName}*)object)`,
        instance,
        implementation.owner,
      );
      const args = [selfPointer, ...argNames].join(", ");
      lines.push(`        case ${instance.typeId}:`);
      if (isVoid(returnType)) {
        lines.push(`            ${this.methodName(owner, implementation)}(${args});`);
        lines.push("            return;");
      } else {
        lines.push(
          `            return ${this.methodName(owner, implementation)}(${args});`,
        );
      }
    }
    lines.push('        default: copl_panic("invalid interface dispatch");');
    if (!isVoid(returnType)) {
      lines.push(`            return ${this.zeroValue(returnType)};`);
    } else {
      lines.push("            return;");
    }
    lines.push("    }", "}");
    this.functions.push(lines.join("\n"));
    return name;
  }

  private emitCall(expr: ast.CallExpr): string {
    if (expr.callee.kind === "SuperExpr") {
      this.fail("super constructor call is only supported at constructor start", expr.span);
    }
    if (expr.callee.kind === "IdentifierExpr") {
      switch (expr.callee.name) {
        case "copy": {
          const arg = expr.args[0]!;
          return this.copyValue(this.emitExpr(arg), this.typeOf(arg), this.current);
        }
        case "env": {
          if (expr.args.length === 0) {
            return "copl_env(copl_array_empty(1))";
          }
          return `copl_env(${this.emitExpr(expr.args[0]!)})`;
        }
        case "syscall": {
          const args = expr.args.map((arg) => `(long)(${this.emitExpr(arg)})`);
          return `syscall(${args.join(", ")})`;
        }
        case "va_int":
          return this.emitVaAccess("int64_t");
        case "va_i32":
          return `((int32_t)${this.emitVaAccess("int")})`;
        case "va_u32":
          return `((uint32_t)${this.emitVaAccess("unsigned int")})`;
        case "va_uint":
          return this.emitVaAccess("uint64_t");
        case "va_float":
          return this.emitVaAccess("double");
        case "va_bool":
          return `((bool)${this.emitVaAccess("int")})`;
        case "va_char":
          return `((char)${this.emitVaAccess("int")})`;
        case "va_ptr":
          return this.emitVaAccess("void*");
        case "va_char_array":
          return this.emitVaAccess("copl_array");
        default:
          this.fail(`unknown function '${expr.callee.name}'`, expr.span);
      }
    }
    if (expr.callee.kind !== "MemberExpr") {
      this.fail("expression is not callable", expr.span);
    }
    const resolution = this.model.methodCalls.get(expr);
    if (!resolution) {
      this.fail("missing method resolution", expr.span);
    }
    if (resolution.method.isExtern) {
      return this.emitExternCall(expr, resolution);
    }
    const member = expr.callee;
    const objectType = this.valueTypeOf(member.object);
    if (resolution.method.isStatic) {
      const owner = this.instanceForSymbol(resolution.method.owner);
      const args = expr.args.map((arg, index) =>
        this.emitArgument(arg, resolution.params[index]?.type),
      );
      return `${this.methodName(owner, resolution.method)}(${args.join(", ")})`;
    }
    if (objectType.kind !== "class") {
      this.fail(
        `method call on non-class type is not implemented for '${member.member}'`,
        member.span,
      );
    }
    if (objectType.symbol.kind === "interface") {
      const receiver = this.emitExpr(member.object);
      const dispatch = this.ensureInterfaceDispatcher(
        objectType,
        resolution.method,
      );
      const args = [
        receiver,
        ...expr.args.map((arg, index) =>
          this.emitArgument(arg, resolution.params[index]?.type),
        ),
      ];
      return `${dispatch}(${args.join(", ")})`;
    }
    const receiver = this.emitExpr(member.object);
    const receiverInstance = this.ensureInstance(objectType);
    const owner = this.ownerInstance(receiverInstance, resolution.method.owner);
    const selfPointer = this.basePointer(
      receiver,
      receiverInstance,
      resolution.method.owner,
    );
    const args = expr.args.map((arg, index) =>
      this.emitArgument(arg, resolution.params[index]?.type),
    );
    const allArgs = args.length > 0 ? `${selfPointer}, ${args.join(", ")}` : selfPointer;
    return `${this.methodName(owner, resolution.method)}(${allArgs})`;
  }

  private emitVaAccess(type: string): string {
    if (!this.currentVariadicName) {
      this.fail("variadic access outside a variadic method");
    }
    return `va_arg(${this.currentVariadicName}, ${type})`;
  }

  private emitExternCall(expr: ast.CallExpr, resolution: MethodResolution): string {
    if (!resolution.method.isStatic) {
      this.fail("extern instance methods are not implemented", expr.span);
    }
    const args = expr.args.map((arg, index) => {
      const param = resolution.params[index];
      const expression = this.emitArgument(arg, param?.type);
      if (param?.type.kind === "array") {
        return `((${expression}).data)`;
      }
      return expression;
    });
    return `${resolution.method.name}(${args.join(", ")})`;
  }

  private emitNewObject(expr: ast.NewObjectExpr): string {
    const resolution: ConstructorResolution | undefined =
      this.model.constructorCalls.get(expr);
    if (!resolution) {
      this.fail("missing constructor resolution", expr.span);
    }
    const type = this.realizeType(resolution.type);
    if (type.kind !== "class") {
      this.fail("constructor call is not a class", expr.span);
    }
    const instance = this.ensureInstance(type);
    const args = expr.args
      .map((arg, index) =>
        this.emitArgument(arg, resolution.constructor.params[index]?.type),
      )
      .join(", ");
    return `${this.newName(instance, resolution.constructor)}(${args})`;
  }

  private emitWorkerCall(expr: ast.WorkerCallExpr): string {
    const resolution = this.model.workerCalls.get(expr);
    if (!resolution) {
      this.fail("missing worker call resolution", expr.span);
    }
    let owner: Instance;
    let selfExpression: string | undefined;
    if (resolution.method.isStatic) {
      owner = this.instanceForSymbol(resolution.method.owner);
    } else {
      if (!this.current) {
        this.fail("worker call requires an instance context", expr.span);
      }
      owner = this.ownerInstance(this.current, resolution.method.owner);
      selfExpression = this.basePointer(
        "self",
        this.current,
        resolution.method.owner,
      );
    }
    const argsType = this.temp("task_args_type");
    const argsValue = this.temp("task_args");
    const thunk = this.temp("task_thunk");
    const task = this.temp("task");
    const fields: string[] = [];
    if (selfExpression !== undefined) {
      fields.push(`    ${owner.cName}* self;`);
    }
    resolution.params.forEach((param, index) => {
      fields.push(`    ${this.cType(param.type)} a${index};`);
    });
    if (fields.length === 0) {
      fields.push("    uint8_t padding;");
    }
    this.structs.push(
      `typedef struct ${argsType} {\n${fields.join("\n")}\n} ${argsType};`,
    );
    const selfArg = selfExpression !== undefined ? ["args->self"] : [];
    const args = [
      ...selfArg,
      ...resolution.params.map((_, index) => `args->a${index}`),
    ];
    const call = `${this.methodName(owner, resolution.method)}(${args.join(", ")})`;
    let thunkBody: string;
    if (isVoid(resolution.returnType)) {
      thunkBody = `    ${call};\n    free(args);\n    return NULL;`;
    } else {
      const resultC = this.cType(resolution.returnType);
      thunkBody = [
        `    ${resultC}* result = (${resultC}*)malloc(sizeof(${resultC}));`,
        '    if (result == NULL) { copl_panic("out of memory"); }',
        `    *result = ${call};`,
        "    free(args);",
        "    return result;",
      ].join("\n");
    }
    this.prototypes.push(`static void* ${thunk}(void* raw);`);
    this.functions.push(
      `static void* ${thunk}(void* raw) {\n    ${argsType}* args = (${argsType}*)raw;\n${thunkBody}\n}`,
    );
    this.emitLine(
      `${argsType}* ${argsValue} = (${argsType}*)malloc(sizeof(${argsType}));`,
    );
    this.emitLine(`if (${argsValue} == NULL) { copl_panic("out of memory"); }`);
    if (selfExpression !== undefined) {
      this.emitLine(`${argsValue}->self = ${selfExpression};`);
    }
    resolution.params.forEach((param, index) => {
      const value = this.emitArgument(expr.args[index]!, param.type);
      this.emitLine(`${argsValue}->a${index} = ${value};`);
    });
    this.emitLine(
      `copl_task* ${task} = copl_task_start(${thunk}, ${argsValue}, ${expr.workers ?? 0});`,
    );
    return task;
  }

  private emitBinary(expr: ast.BinaryExpr): string {
    const leftType = this.valueTypeOf(expr.left);
    const left = this.emitExpr(expr.left);
    const right = this.emitExpr(expr.right);
    if (
      (expr.op === "==" || expr.op === "!=") &&
      (leftType.kind === "array" ||
        (leftType.kind === "nullable" && leftType.inner.kind === "array"))
    ) {
      const equal = `copl_array_equal(${left}, ${right})`;
      return expr.op === "==" ? equal : `(!${equal})`;
    }
    return `(${left} ${expr.op} ${right})`;
  }

  private emitArrayLiteral(expr: ast.ArrayLiteralExpr, hint?: string): string {
    const type = this.typeOf(expr);
    if (type.kind !== "array") {
      this.fail("array literal does not have an array type", expr.span);
    }
    const elementType = type.element;
    const elementC = this.cType(elementType);
    const builder = this.temp("builder");
    const result = this.temp("array");
    let lengthVar: string | undefined;
    if (hint) {
      lengthVar = this.temp("len");
      this.emitLine(`size_t ${lengthVar} = (size_t)(${hint});`);
    }
    this.emitLine(
      `copl_array_builder ${builder}; copl_array_builder_init(&${builder}, sizeof(${elementC}), ${lengthVar ?? "0"});`,
    );
    for (const item of expr.elements) {
      if (item.kind === "SpreadExpr") {
        if (
          item.expression.kind === "IntLiteralExpr" &&
          item.expression.value === 0n
        ) {
          if (!lengthVar) {
            this.fail(
              "zero fill requires a sized-array context",
              item.expression.span,
            );
          }
          this.emitLine(
            `if (${builder}.len < ${lengthVar}) { copl_array_builder_zero(&${builder}, ${lengthVar} - ${builder}.len); }`,
          );
          continue;
        }
        const source = this.emitExpr(item.expression);
        this.emitLine(`copl_array_builder_append(&${builder}, ${source});`);
        continue;
      }
      const itemType = this.valueTypeOf(item);
      if (
        itemType.kind === "array" &&
        elementType.kind !== "array" &&
        typesEqual(itemType.element, elementType)
      ) {
        const source = this.emitExpr(item);
        this.emitLine(`copl_array_builder_append(&${builder}, ${source});`);
        continue;
      }
      const value = this.temp("element");
      this.emitLine(`${elementC} ${value} = ${this.emitArgument(item, elementType)};`);
      this.emitLine(`copl_array_builder_push(&${builder}, &${value});`);
    }
    if (lengthVar) {
      this.emitLine(
        `if (${builder}.len < ${lengthVar}) { copl_array_builder_zero(&${builder}, ${lengthVar} - ${builder}.len); }`,
      );
    }
    const descriptor = this.arrayDescriptor(type);
    this.emitLine(
      `copl_array ${result} = copl_array_builder_finish(&${builder}, ${descriptor});`,
    );
    return result;
  }

  private arrayNeedsDeepCopy(type: SemType): boolean {
    if (type.kind !== "array") {
      return false;
    }
    const inner =
      type.element.kind === "nullable" ? type.element.inner : type.element;
    if (inner.kind === "array") {
      return true;
    }
    return (
      inner.kind === "class" &&
      inner.symbol.kind === "class" &&
      !inner.symbol.isExtern
    );
  }

  private ensureArrayCopyHelper(type: SemType): string {
    if (type.kind !== "array") {
      this.fail("array copy helper requires an array type");
    }
    const name = `copl_copy_array_${sanitize(typeKey(type))}`;
    const cached = this.arrayCopyHelpers.get(name);
    if (cached) {
      return cached;
    }
    this.arrayCopyHelpers.set(name, name);
    const element = type.element;
    const elementC = this.cType(element);
    const signature = `static copl_array ${name}(copl_array source)`;
    this.prototypes.push(`${signature};`);
    const lines: string[] = [
      `${signature} {`,
      `    copl_array result = copl_array_alloc_with(source.len, sizeof(${elementC}), ${this.arrayDescriptor(type)});`,
      `    ${elementC}* src = (${elementC}*)source.data;`,
      `    ${elementC}* dst = (${elementC}*)result.data;`,
      "    for (size_t index = 0; index < source.len; index += 1) {",
      `        dst[index] = ${this.copyValue("src[index]", element, undefined)};`,
      "    }",
      "    return result;",
      "}",
    ];
    this.functions.push(lines.join("\n"));
    return name;
  }

  private copyArrayValue(
    expression: string,
    type: SemType,
    instance: Instance | undefined,
  ): string {
    if (!this.arrayNeedsDeepCopy(type)) {
      return `copl_array_copy(${expression})`;
    }
    void instance;
    return `${this.ensureArrayCopyHelper(type)}(${expression})`;
  }

  private copyValue(
    expression: string,
    type: SemType,
    instance: Instance | undefined,
  ): string {
    const resolved = instance ? substitute(type, instance.map) : this.realizeType(type);
    switch (resolved.kind) {
      case "array":
        return this.copyArrayValue(expression, resolved, instance);
      case "class":
        if (
          resolved.symbol.kind === "interface" ||
          resolved.symbol.isExtern
        ) {
          return expression;
        }
        return `${this.copyName(this.ensureInstance(resolved))}(${expression})`;
      case "nullable":
        return this.copyValue(expression, resolved.inner, instance);
      case "task":
        return expression;
      default:
        return expression;
    }
  }
}
