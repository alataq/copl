import type { Span } from "./source";

export interface Node {
  readonly span: Span;
}

export type PrimitiveName =
  | "int"
  | "uint"
  | "i32"
  | "u32"
  | "byte"
  | "char"
  | "float"
  | "bool"
  | "void";

export type Visibility = "public" | "protected" | "internal" | "private";

export interface TypeParam extends Node {
  readonly name: string;
}

export interface PrimitiveType extends Node {
  readonly kind: "PrimitiveType";
  readonly name: PrimitiveName;
}

export interface NamedType extends Node {
  readonly kind: "NamedType";
  readonly name: readonly string[];
  readonly typeArgs: readonly TypeRef[];
}

export interface PointerType extends Node {
  readonly kind: "PointerType";
  readonly target?: TypeRef;
}

export interface ArrayType extends Node {
  readonly kind: "ArrayType";
  readonly element: TypeRef;
  readonly size?: Expr;
}

export interface NullableType extends Node {
  readonly kind: "NullableType";
  readonly inner: TypeRef;
}

export type TypeRef =
  | PrimitiveType
  | NamedType
  | PointerType
  | ArrayType
  | NullableType;

export type UnaryOp = "!" | "-" | "+" | "~";

export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "&&"
  | "||"
  | "&"
  | "|"
  | "^";

export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=";

export interface IntLiteralExpr extends Node {
  readonly kind: "IntLiteralExpr";
  readonly value: bigint;
  readonly raw: string;
}

export interface FloatLiteralExpr extends Node {
  readonly kind: "FloatLiteralExpr";
  readonly value: number;
  readonly raw: string;
}

export interface StringLiteralExpr extends Node {
  readonly kind: "StringLiteralExpr";
  readonly value: string;
}

export interface CharLiteralExpr extends Node {
  readonly kind: "CharLiteralExpr";
  readonly value: string;
}

export interface BoolLiteralExpr extends Node {
  readonly kind: "BoolLiteralExpr";
  readonly value: boolean;
}

export interface NullLiteralExpr extends Node {
  readonly kind: "NullLiteralExpr";
}

export interface IdentifierExpr extends Node {
  readonly kind: "IdentifierExpr";
  readonly name: string;
}

export interface SelfExpr extends Node {
  readonly kind: "SelfExpr";
}

export interface SuperExpr extends Node {
  readonly kind: "SuperExpr";
}

export interface MemberExpr extends Node {
  readonly kind: "MemberExpr";
  readonly object: Expr;
  readonly member: string;
}

export interface IndexExpr extends Node {
  readonly kind: "IndexExpr";
  readonly object: Expr;
  readonly index: Expr;
}

export interface CallExpr extends Node {
  readonly kind: "CallExpr";
  readonly callee: Expr;
  readonly args: readonly Expr[];
}

export interface NewObjectExpr extends Node {
  readonly kind: "NewObjectExpr";
  readonly type: TypeRef;
  readonly args: readonly Expr[];
}

export interface NewArrayExpr extends Node {
  readonly kind: "NewArrayExpr";
  readonly elementType: TypeRef;
  readonly size: Expr;
}

export interface CastExpr extends Node {
  readonly kind: "CastExpr";
  readonly target: TypeRef;
  readonly value: Expr;
}

export interface UnaryExpr extends Node {
  readonly kind: "UnaryExpr";
  readonly op: UnaryOp;
  readonly operand: Expr;
}

export interface UpdateExpr extends Node {
  readonly kind: "UpdateExpr";
  readonly op: "++" | "--";
  readonly operand: Expr;
  readonly prefix: boolean;
}

export interface BinaryExpr extends Node {
  readonly kind: "BinaryExpr";
  readonly op: BinaryOp;
  readonly left: Expr;
  readonly right: Expr;
}

export interface TernaryExpr extends Node {
  readonly kind: "TernaryExpr";
  readonly condition: Expr;
  readonly thenExpr: Expr;
  readonly elseExpr: Expr;
}

export interface SpreadExpr extends Node {
  readonly kind: "SpreadExpr";
  readonly expression: Expr;
}

export interface ArrayLiteralExpr extends Node {
  readonly kind: "ArrayLiteralExpr";
  readonly elements: readonly Expr[];
}

export interface WorkerCallExpr extends Node {
  readonly kind: "WorkerCallExpr";
  readonly workers?: number;
  readonly method: string;
  readonly args: readonly Expr[];
}

export interface TaskProbeExpr extends Node {
  readonly kind: "TaskProbeExpr";
  readonly expression: Expr;
}

export type Expr =
  | IntLiteralExpr
  | FloatLiteralExpr
  | StringLiteralExpr
  | CharLiteralExpr
  | BoolLiteralExpr
  | NullLiteralExpr
  | IdentifierExpr
  | SelfExpr
  | SuperExpr
  | MemberExpr
  | IndexExpr
  | CallExpr
  | NewObjectExpr
  | NewArrayExpr
  | CastExpr
  | UnaryExpr
  | UpdateExpr
  | BinaryExpr
  | TernaryExpr
  | SpreadExpr
  | ArrayLiteralExpr
  | WorkerCallExpr
  | TaskProbeExpr;

export interface BlockStmt extends Node {
  readonly kind: "BlockStmt";
  readonly statements: readonly Stmt[];
}

export interface VarDeclStmt extends Node {
  readonly kind: "VarDeclStmt";
  readonly isFinal: boolean;
  readonly type: TypeRef;
  readonly name: string;
  readonly initializer?: Expr;
}

export interface ExprStmt extends Node {
  readonly kind: "ExprStmt";
  readonly expression: Expr;
}

export interface AssignStmt extends Node {
  readonly kind: "AssignStmt";
  readonly target: Expr;
  readonly op: AssignOp;
  readonly value: Expr;
}

export interface IfStmt extends Node {
  readonly kind: "IfStmt";
  readonly condition: Expr;
  readonly thenBranch: Stmt;
  readonly elseBranch?: Stmt;
}

export interface WhileStmt extends Node {
  readonly kind: "WhileStmt";
  readonly condition: Expr;
  readonly body: Stmt;
}

export interface ForStmt extends Node {
  readonly kind: "ForStmt";
  readonly initializer?: VarDeclStmt | ExprStmt | AssignStmt;
  readonly condition?: Expr;
  readonly update?: ExprStmt | AssignStmt;
  readonly body: Stmt;
}

export interface SwitchCase extends Node {
  readonly kind: "SwitchCase";
  readonly value?: Expr;
  readonly statements: readonly Stmt[];
}

export interface SwitchStmt extends Node {
  readonly kind: "SwitchStmt";
  readonly discriminant: Expr;
  readonly cases: readonly SwitchCase[];
}

export interface ReturnStmt extends Node {
  readonly kind: "ReturnStmt";
  readonly value?: Expr;
}

export interface BreakStmt extends Node {
  readonly kind: "BreakStmt";
}

export interface ContinueStmt extends Node {
  readonly kind: "ContinueStmt";
}

export interface EnvDefaultStmt extends Node {
  readonly kind: "EnvDefaultStmt";
  readonly name: string;
  readonly value: Expr;
}

export type Stmt =
  | BlockStmt
  | VarDeclStmt
  | ExprStmt
  | AssignStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | SwitchStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | EnvDefaultStmt;

export interface Param extends Node {
  readonly name: string;
  readonly type: TypeRef;
}

export interface AttributeDecl extends Node {
  readonly kind: "AttributeDecl";
  readonly visibility: Visibility;
  readonly isFinal: boolean;
  readonly isStatic: boolean;
  readonly type: TypeRef;
  readonly name: string;
  readonly initializer?: Expr;
}

export interface ConstructorDecl extends Node {
  readonly kind: "ConstructorDecl";
  readonly visibility: Visibility;
  readonly name: string;
  readonly params: readonly Param[];
  readonly isVariadic: boolean;
  readonly body: BlockStmt;
}

export interface MethodDecl extends Node {
  readonly kind: "MethodDecl";
  readonly visibility: Visibility;
  readonly isFinal: boolean;
  readonly isStatic: boolean;
  readonly isExtern: boolean;
  readonly returnType: TypeRef;
  readonly name: string;
  readonly params: readonly Param[];
  readonly isVariadic: boolean;
  readonly body?: BlockStmt;
}

export type ClassMember = AttributeDecl | ConstructorDecl | MethodDecl;

export interface ClassDecl extends Node {
  readonly kind: "ClassDecl";
  readonly name: string;
  readonly visibility: Visibility;
  readonly isFinal: boolean;
  readonly isExtern: boolean;
  readonly typeParams: readonly TypeParam[];
  readonly extends?: TypeRef;
  readonly implements: readonly TypeRef[];
  readonly members: readonly ClassMember[];
}

export interface InterfaceDecl extends Node {
  readonly kind: "InterfaceDecl";
  readonly name: string;
  readonly visibility: Visibility;
  readonly typeParams: readonly TypeParam[];
  readonly extends: readonly TypeRef[];
  readonly methods: readonly MethodDecl[];
}

export interface EnumMember extends Node {
  readonly name: string;
  readonly value?: bigint;
}

export interface EnumDecl extends Node {
  readonly kind: "EnumDecl";
  readonly name: string;
  readonly visibility: Visibility;
  readonly members: readonly EnumMember[];
}

export type TypeDecl = ClassDecl | InterfaceDecl | EnumDecl;

export interface ImportDecl extends Node {
  readonly kind: "ImportDecl";
  readonly segments: readonly string[];
  readonly isLocal: boolean;
}

export interface CIncludeDecl extends Node {
  readonly kind: "CIncludeDecl";
  readonly header: string;
}

export interface CLinkDecl extends Node {
  readonly kind: "CLinkDecl";
  readonly flag: string;
}

export interface CInlineDecl extends Node {
  readonly kind: "CInlineDecl";
  readonly code: string;
}

export interface NamespaceDecl extends Node {
  readonly kind: "NamespaceDecl";
  readonly name: readonly string[];
  readonly members: readonly TypeDecl[];
}

export interface SourceUnit extends Node {
  readonly kind: "SourceUnit";
  readonly file: string;
  readonly imports: readonly ImportDecl[];
  readonly cIncludes: readonly CIncludeDecl[];
  readonly cLinks: readonly CLinkDecl[];
  readonly cInlines: readonly CInlineDecl[];
  readonly namespaces: readonly NamespaceDecl[];
}
