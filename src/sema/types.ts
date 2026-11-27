import type * as ast from "../ast";
import type { TypeSymbol } from "./symbols";

export interface PrimitiveSemType {
  readonly kind: "primitive";
  readonly name: ast.PrimitiveName;
}

export interface NullSemType {
  readonly kind: "null";
}

export interface TypeParamSemType {
  readonly kind: "typeParam";
  readonly name: string;
  readonly owner: string;
}

export interface ClassSemType {
  readonly kind: "class";
  readonly symbol: TypeSymbol;
  readonly args: readonly SemType[];
}

export interface ArraySemType {
  readonly kind: "array";
  readonly element: SemType;
}

export interface PointerSemType {
  readonly kind: "pointer";
  readonly target?: SemType;
}

export interface NullableSemType {
  readonly kind: "nullable";
  readonly inner: SemType;
}

export interface MetaSemType {
  readonly kind: "meta";
  readonly symbol: TypeSymbol;
}

export interface TaskSemType {
  readonly kind: "task";
  readonly result: SemType;
}

export interface EnumSemType {
  readonly kind: "enum";
  readonly symbol: TypeSymbol;
}

export type SemType =
  | PrimitiveSemType
  | NullSemType
  | TypeParamSemType
  | ClassSemType
  | ArraySemType
  | PointerSemType
  | NullableSemType
  | MetaSemType
  | TaskSemType
  | EnumSemType;

const PRIMITIVES = new Map<ast.PrimitiveName, PrimitiveSemType>();

export function primitiveType(name: ast.PrimitiveName): PrimitiveSemType {
  let type = PRIMITIVES.get(name);
  if (!type) {
    type = { kind: "primitive", name };
    PRIMITIVES.set(name, type);
  }
  return type;
}

export const VOID: PrimitiveSemType = primitiveType("void");
export const INT: PrimitiveSemType = primitiveType("int");
export const UINT: PrimitiveSemType = primitiveType("uint");
export const I32: PrimitiveSemType = primitiveType("i32");
export const U32: PrimitiveSemType = primitiveType("u32");
export const BYTE: PrimitiveSemType = primitiveType("byte");
export const CHAR: PrimitiveSemType = primitiveType("char");
export const FLOAT: PrimitiveSemType = primitiveType("float");
export const BOOL: PrimitiveSemType = primitiveType("bool");
export const NULL: NullSemType = { kind: "null" };

export function arrayType(element: SemType): ArraySemType {
  return { kind: "array", element };
}

export function pointerType(target?: SemType): PointerSemType {
  return target ? { kind: "pointer", target } : { kind: "pointer" };
}

export function nullableType(inner: SemType): NullableSemType {
  return { kind: "nullable", inner };
}

export function typeParamType(
  owner: string,
  name: string,
): TypeParamSemType {
  return { kind: "typeParam", owner, name };
}

export function classType(
  symbol: TypeSymbol,
  args: readonly SemType[] = [],
): ClassSemType {
  return { kind: "class", symbol, args };
}

export function metaType(symbol: TypeSymbol): MetaSemType {
  return { kind: "meta", symbol };
}

export function taskType(result: SemType): TaskSemType {
  return { kind: "task", result };
}

export function enumType(symbol: TypeSymbol): EnumSemType {
  return { kind: "enum", symbol };
}

export function isPrimitive(type: SemType): type is PrimitiveSemType {
  return type.kind === "primitive";
}

export function isInteger(type: SemType): boolean {
  return (
    type.kind === "primitive" &&
    (type.name === "int" ||
      type.name === "uint" ||
      type.name === "i32" ||
      type.name === "u32" ||
      type.name === "byte" ||
      type.name === "char")
  );
}

export function isNumeric(type: SemType): boolean {
  return (
    type.kind === "primitive" &&
    type.name !== "bool" &&
    type.name !== "void"
  );
}

export function isBool(type: SemType): boolean {
  return type.kind === "primitive" && type.name === "bool";
}

export function isVoid(type: SemType): boolean {
  return type.kind === "primitive" && type.name === "void";
}

export function typeKey(type: SemType): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "null":
      return "null";
    case "typeParam":
      return `${type.owner}::${type.name}`;
    case "class":
      return `${type.symbol.qualifiedName}<${type.args.map(typeKey).join(",")}>`;
    case "array":
      return `${typeKey(type.element)}[]`;
    case "pointer":
      return type.target ? `ptr<${typeKey(type.target)}>` : "ptr";
    case "nullable":
      return `${typeKey(type.inner)}?`;
    case "meta":
      return `meta:${type.symbol.qualifiedName}`;
    case "task":
      return `task<${typeKey(type.result)}>`;
    case "enum":
      return `enum:${type.symbol.qualifiedName}`;
  }
}

export function typesEqual(left: SemType, right: SemType): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "primitive":
      return right.kind === "primitive" && left.name === right.name;
    case "null":
      return true;
    case "typeParam":
      return (
        right.kind === "typeParam" &&
        left.name === right.name &&
        left.owner === right.owner
      );
    case "class":
      return (
        right.kind === "class" &&
        left.symbol === right.symbol &&
        left.args.length === right.args.length &&
        left.args.every((arg, index) => typesEqual(arg, right.args[index]!))
      );
    case "array":
      return (
        right.kind === "array" && typesEqual(left.element, right.element)
      );
    case "pointer":
      if (right.kind !== "pointer") {
        return false;
      }
      if (!left.target || !right.target) {
        return !left.target && !right.target;
      }
      return typesEqual(left.target, right.target);
    case "nullable":
      return (
        right.kind === "nullable" && typesEqual(left.inner, right.inner)
      );
    case "meta":
      return right.kind === "meta" && left.symbol === right.symbol;
    case "task":
      return right.kind === "task" && typesEqual(left.result, right.result);
    case "enum":
      return right.kind === "enum" && left.symbol === right.symbol;
  }
}

export function displayType(type: SemType): string {
  switch (type.kind) {
    case "primitive":
      return type.name;
    case "null":
      return "null";
    case "typeParam":
      return type.name;
    case "class": {
      const args = type.args.length > 0
        ? `<${type.args.map(displayType).join(", ")}>`
        : "";
      return `${type.symbol.qualifiedName}${args}`;
    }
    case "array":
      return `${displayType(type.element)}[]`;
    case "pointer":
      return type.target ? `ptr<${displayType(type.target)}>` : "ptr";
    case "nullable":
      return `${displayType(type.inner)}?`;
    case "meta":
      return type.symbol.qualifiedName;
    case "task":
      return `Task<${displayType(type.result)}>`;
    case "enum":
      return type.symbol.qualifiedName;
  }
}
