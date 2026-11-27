import type * as ast from "../ast";
import type { Span } from "../source";
import type { ClassSemType, SemType } from "./types";

export interface TypeParamSymbol {
  readonly name: string;
  readonly span: Span;
}

export interface ParamSymbol {
  readonly name: string;
  readonly type: SemType;
  readonly span: Span;
}

export interface FieldSymbol {
  readonly kind: "field";
  readonly name: string;
  readonly owner: TypeSymbol;
  readonly visibility: ast.Visibility;
  readonly isFinal: boolean;
  readonly isStatic: boolean;
  readonly type: SemType;
  readonly decl: ast.AttributeDecl;
}

export interface MethodSymbol {
  readonly kind: "method";
  readonly name: string;
  readonly owner: TypeSymbol;
  readonly visibility: ast.Visibility;
  readonly isFinal: boolean;
  readonly isStatic: boolean;
  readonly isExtern: boolean;
  readonly isVariadic: boolean;
  readonly returnType: SemType;
  readonly params: readonly ParamSymbol[];
  readonly decl: ast.MethodDecl;
}

export interface ConstructorSymbol {
  readonly kind: "constructor";
  readonly owner: TypeSymbol;
  readonly visibility: ast.Visibility;
  readonly params: readonly ParamSymbol[];
  readonly decl?: ast.ConstructorDecl;
  readonly isImplicit: boolean;
}

export interface EnumMemberSymbol {
  readonly name: string;
  readonly value: bigint;
  readonly span: Span;
}

export interface TypeSymbol {
  readonly kind: "class" | "interface" | "enum";
  readonly name: string;
  readonly namespace: readonly string[];
  readonly qualifiedName: string;
  readonly decl: ast.ClassDecl | ast.InterfaceDecl | ast.EnumDecl;
  readonly typeParams: readonly TypeParamSymbol[];
  readonly enumMembers: Map<string, EnumMemberSymbol>;
  readonly fields: Map<string, FieldSymbol>;
  readonly methods: Map<string, MethodSymbol[]>;
  constructors: ConstructorSymbol[];
  readonly interfaces: ClassSemType[];
  superClass?: ClassSemType;
  readonly isExtern: boolean;
  readonly isFinal: boolean;
  readonly file: string;
}

export interface MethodResolution {
  readonly method: MethodSymbol;
  readonly params: readonly ParamSymbol[];
  readonly returnType: SemType;
}

export interface ConstructorResolution {
  readonly constructor: ConstructorSymbol;
  readonly type: ClassSemType;
}

export interface SemanticModel {
  readonly symbols: ReadonlyMap<string, TypeSymbol>;
  readonly files: readonly string[];
  readonly expressionTypes: ReadonlyMap<ast.Expr, SemType>;
  readonly typeRefs: ReadonlyMap<ast.TypeRef, SemType>;
  readonly methodCalls: ReadonlyMap<ast.CallExpr, MethodResolution>;
  readonly constructorCalls: ReadonlyMap<ast.NewObjectExpr, ConstructorResolution>;
  readonly superConstructorCalls: ReadonlyMap<ast.CallExpr, ConstructorSymbol>;
  readonly workerCalls: ReadonlyMap<ast.WorkerCallExpr, MethodResolution>;
}
