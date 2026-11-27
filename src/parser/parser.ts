import type * as ast from "../ast";
import { CoplError } from "../diagnostics";
import { makeSpan, mergeSpans, type SourceFile, type Span } from "../source";
import { tokenize } from "../lexer/lexer";
import {
  TokenKind,
  tokenKindName,
  type Token,
} from "../lexer/token";

const PRIMITIVE_KEYWORDS: ReadonlyMap<TokenKind, ast.PrimitiveName> = new Map([
  [TokenKind.KwInt, "int"],
  [TokenKind.KwUint, "uint"],
  [TokenKind.KwI32, "i32"],
  [TokenKind.KwU32, "u32"],
  [TokenKind.KwByte, "byte"],
  [TokenKind.KwChar, "char"],
  [TokenKind.KwFloat, "float"],
  [TokenKind.KwBool, "bool"],
  [TokenKind.KwVoid, "void"],
]);

const VISIBILITY_KEYWORDS: ReadonlyMap<TokenKind, ast.Visibility> = new Map([
  [TokenKind.KwPublic, "public"],
  [TokenKind.KwProtected, "protected"],
  [TokenKind.KwInternal, "internal"],
  [TokenKind.KwPrivate, "private"],
]);

const ASSIGN_OPERATORS: ReadonlyMap<TokenKind, ast.AssignOp> = new Map([
  [TokenKind.Assign, "="],
  [TokenKind.PlusAssign, "+="],
  [TokenKind.MinusAssign, "-="],
  [TokenKind.StarAssign, "*="],
  [TokenKind.SlashAssign, "/="],
  [TokenKind.PercentAssign, "%="],
]);

const BINARY_OPERATORS: ReadonlyMap<
  TokenKind,
  { readonly precedence: number; readonly op: ast.BinaryOp }
> = new Map([
  [TokenKind.OrOr, { precedence: 1, op: "||" }],
  [TokenKind.AndAnd, { precedence: 2, op: "&&" }],
  [TokenKind.Pipe, { precedence: 3, op: "|" }],
  [TokenKind.Caret, { precedence: 4, op: "^" }],
  [TokenKind.Amp, { precedence: 5, op: "&" }],
  [TokenKind.EqEq, { precedence: 6, op: "==" }],
  [TokenKind.BangEq, { precedence: 6, op: "!=" }],
  [TokenKind.Lt, { precedence: 7, op: "<" }],
  [TokenKind.Le, { precedence: 7, op: "<=" }],
  [TokenKind.Gt, { precedence: 7, op: ">" }],
  [TokenKind.Ge, { precedence: 7, op: ">=" }],
  [TokenKind.Plus, { precedence: 8, op: "+" }],
  [TokenKind.Minus, { precedence: 8, op: "-" }],
  [TokenKind.Star, { precedence: 9, op: "*" }],
  [TokenKind.Slash, { precedence: 9, op: "/" }],
  [TokenKind.Percent, { precedence: 9, op: "%" }],
]);

const UNARY_OPERATORS: ReadonlyMap<TokenKind, ast.UnaryOp> = new Map([
  [TokenKind.Bang, "!"],
  [TokenKind.Minus, "-"],
  [TokenKind.Plus, "+"],
  [TokenKind.Tilde, "~"],
]);

function isTypeStartToken(kind: TokenKind): boolean {
  return PRIMITIVE_KEYWORDS.has(kind) || kind === TokenKind.KwPtr;
}

function isTypeDeclStartToken(kind: TokenKind): boolean {
  return (
    kind === TokenKind.KwClass ||
    kind === TokenKind.KwInterface ||
    kind === TokenKind.KwEnum ||
    kind === TokenKind.KwPublic ||
    kind === TokenKind.KwProtected ||
    kind === TokenKind.KwInternal ||
    kind === TokenKind.KwPrivate ||
    kind === TokenKind.KwFinal ||
    kind === TokenKind.KwExtern
  );
}

export class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(
    private readonly file: SourceFile,
    tokens?: readonly Token[],
  ) {
    this.tokens = tokens ? [...tokens] : tokenize(file);
  }

  parseSourceUnit(): ast.SourceUnit {
    const start = this.current;
    const imports: ast.ImportDecl[] = [];
    const cIncludes: ast.CIncludeDecl[] = [];
    const cLinks: ast.CLinkDecl[] = [];
    const cInlines: ast.CInlineDecl[] = [];
    const namespaces: ast.NamespaceDecl[] = [];
    const topLevelMembers: ast.TypeDecl[] = [];

    while (!this.check(TokenKind.EOF)) {
      switch (this.current.kind) {
        case TokenKind.KwImport:
          imports.push(this.parseImport());
          break;
        case TokenKind.KwCInclude:
          cIncludes.push(this.parseCInclude());
          break;
        case TokenKind.KwCLink:
          cLinks.push(this.parseCLink());
          break;
        case TokenKind.CInlineBlock:
          cInlines.push(this.parseCInline());
          break;
        case TokenKind.KwNamespace:
          namespaces.push(this.parseNamespace());
          break;
        default:
          if (isTypeDeclStartToken(this.current.kind)) {
            topLevelMembers.push(this.parseTypeDecl());
            break;
          }
          throw this.error(
            this.current,
            "expected an import, C interop directive, namespace, class, or interface",
          );
      }
    }

    if (topLevelMembers.length > 0) {
      const first = topLevelMembers[0]!;
      const last = topLevelMembers[topLevelMembers.length - 1]!;
      namespaces.push({
        kind: "NamespaceDecl",
        name: [],
        members: topLevelMembers,
        span: mergeSpans(first.span, last.span),
      });
    }

    const end = this.previousOrCurrent();
    return {
      kind: "SourceUnit",
      file: this.file.path,
      imports,
      cIncludes,
      cLinks,
      cInlines,
      namespaces,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseImport(): ast.ImportDecl {
    const start = this.expect(TokenKind.KwImport, "'import'");
    const segments = [this.expectIdentifier("import path segment").text];
    while (this.match(TokenKind.Dot)) {
      segments.push(this.expectIdentifier("import path segment").text);
    }
    const end = this.expect(TokenKind.Semicolon, "';'");
    return {
      kind: "ImportDecl",
      segments,
      isLocal: segments[0] === "local",
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseCInclude(): ast.CIncludeDecl {
    const start = this.expect(TokenKind.KwCInclude, "'cinclude'");
    const header = this.expect(TokenKind.StringLiteral, "C header string");
    const end = this.expect(TokenKind.Semicolon, "';'");
    return {
      kind: "CIncludeDecl",
      header: String(header.value ?? ""),
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseCLink(): ast.CLinkDecl {
    const start = this.expect(TokenKind.KwCLink, "'clink'");
    const flag = this.expect(TokenKind.StringLiteral, "linker flag string");
    const end = this.expect(TokenKind.Semicolon, "';'");
    return {
      kind: "CLinkDecl",
      flag: String(flag.value ?? ""),
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseCInline(): ast.CInlineDecl {
    const token = this.expect(TokenKind.CInlineBlock, "'cinline' block");
    this.match(TokenKind.Semicolon);
    return {
      kind: "CInlineDecl",
      code: String(token.value ?? ""),
      span: token.span,
    };
  }

  private parseNamespace(): ast.NamespaceDecl {
    const start = this.expect(TokenKind.KwNamespace, "'namespace'");
    const name = this.parseQualifiedName("namespace name");
    this.expect(TokenKind.LBrace, "'{'");
    const members: ast.TypeDecl[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.EOF)) {
      members.push(this.parseTypeDecl());
    }
    const end = this.expect(TokenKind.RBrace, "'}'");
    return {
      kind: "NamespaceDecl",
      name,
      members,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseQualifiedName(what: string): string[] {
    const parts = [this.expectIdentifier(what).text];
    while (this.match(TokenKind.ColonColon)) {
      parts.push(this.expectIdentifier(what).text);
    }
    return parts;
  }

  private parseTypeDecl(): ast.TypeDecl {
    const start = this.current;
    let visibility: ast.Visibility = "public";
    const visibilityToken = this.matchVisibility();
    if (visibilityToken) {
      visibility = visibilityToken;
    }

    let isFinal = false;
    let isExtern = false;
    for (;;) {
      if (this.match(TokenKind.KwFinal)) {
        isFinal = true;
      } else if (this.match(TokenKind.KwExtern)) {
        isExtern = true;
      } else {
        break;
      }
    }

    if (this.check(TokenKind.KwClass)) {
      return this.parseClass(start, visibility, isFinal, isExtern);
    }
    if (this.check(TokenKind.KwInterface)) {
      if (isExtern) {
        throw this.error(this.current, "interfaces cannot be 'extern'");
      }
      if (isFinal) {
        throw this.error(this.current, "interfaces cannot be 'final'");
      }
      return this.parseInterface(start, visibility);
    }
    if (this.check(TokenKind.KwEnum)) {
      if (isExtern) {
        throw this.error(this.current, "enums cannot be 'extern'");
      }
      if (isFinal) {
        throw this.error(this.current, "enums cannot be 'final'");
      }
      return this.parseEnum(start, visibility);
    }
    throw this.error(this.current, "expected 'class', 'interface', or 'enum'");
  }

  private parseClass(
    start: Token,
    visibility: ast.Visibility,
    isFinal: boolean,
    isExtern: boolean,
  ): ast.ClassDecl {
    this.expect(TokenKind.KwClass, "'class'");
    const name = this.expectIdentifier("class name").text;
    const typeParams = this.parseTypeParams();
    let extendsType: ast.TypeRef | undefined;
    if (this.match(TokenKind.KwExtends)) {
      extendsType = this.parseType();
    }
    const implementsTypes: ast.TypeRef[] = [];
    if (this.match(TokenKind.KwImplements)) {
      do {
        implementsTypes.push(this.parseType());
      } while (this.match(TokenKind.Comma));
    }

    this.expect(TokenKind.LBrace, "'{'");
    const members: ast.ClassMember[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.EOF)) {
      members.push(this.parseClassMember(name));
    }
    const end = this.expect(TokenKind.RBrace, "'}'");

    return {
      kind: "ClassDecl",
      name,
      visibility,
      isFinal,
      isExtern,
      typeParams,
      extends: extendsType,
      implements: implementsTypes,
      members,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseClassMember(className: string): ast.ClassMember {
    const start = this.current;
    const visibility = this.expectVisibility();
    let isFinal = false;
    let isStatic = false;
    let isExtern = false;
    for (;;) {
      if (this.match(TokenKind.KwFinal)) {
        isFinal = true;
      } else if (this.match(TokenKind.KwStatic)) {
        isStatic = true;
      } else if (this.match(TokenKind.KwExtern)) {
        isExtern = true;
      } else {
        break;
      }
    }

    if (
      this.check(TokenKind.Identifier) &&
      this.current.text === className &&
      this.peek(1).kind === TokenKind.LParen
    ) {
      if (isFinal || isStatic || isExtern) {
        throw this.error(this.current, "constructors cannot be final, static, or extern");
      }
      return this.parseConstructor(start, visibility, className);
    }

    if (this.check(TokenKind.Identifier) && this.peek(1).kind === TokenKind.LParen) {
      const nameToken = this.advance();
      return this.parseMethod(
        start,
        visibility,
        isFinal,
        isStatic,
        isExtern,
        { kind: "PrimitiveType", name: "void", span: nameToken.span },
        nameToken,
      );
    }

    const type = this.parseType();
    const nameToken = this.expectIdentifier("member name");

    if (this.check(TokenKind.LParen)) {
      return this.parseMethod(
        start,
        visibility,
        isFinal,
        isStatic,
        isExtern,
        type,
        nameToken,
      );
    }

    if (isExtern) {
      throw this.error(nameToken, "attributes cannot be 'extern'");
    }

    let initializer: ast.Expr | undefined;
    if (this.match(TokenKind.Assign)) {
      initializer = this.parseExpression();
    }
    const end = this.expect(TokenKind.Semicolon, "';'");
    return {
      kind: "AttributeDecl",
      visibility,
      isFinal,
      isStatic,
      type,
      name: nameToken.text,
      initializer,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseConstructor(
    start: Token,
    visibility: ast.Visibility,
    className: string,
  ): ast.ConstructorDecl {
    const nameToken = this.expectIdentifier("constructor name");
    const { params, isVariadic } = this.parseParams();
    const body = this.parseBlock();
    return {
      kind: "ConstructorDecl",
      visibility,
      name: className,
      params,
      isVariadic,
      body,
      span: mergeSpans(start.span, body.span),
    };
  }

  private parseMethod(
    start: Token,
    visibility: ast.Visibility,
    isFinal: boolean,
    isStatic: boolean,
    isExtern: boolean,
    returnType: ast.TypeRef,
    nameToken: Token,
  ): ast.MethodDecl {
    const { params, isVariadic } = this.parseParams();

    if (this.check(TokenKind.Semicolon)) {
      const end = this.advance();
      if (!isExtern) {
        throw this.error(nameToken, "method body is required unless the method is 'extern'");
      }
      return {
        kind: "MethodDecl",
        visibility,
        isFinal,
        isStatic,
        isExtern,
        returnType,
        name: nameToken.text,
        params,
        isVariadic,
        span: mergeSpans(start.span, end.span),
      };
    }

    if (isExtern) {
      throw this.error(nameToken, "extern method cannot have a body");
    }

    const body = this.parseBlock();
    return {
      kind: "MethodDecl",
      visibility,
      isFinal,
      isStatic,
      isExtern,
      returnType,
      name: nameToken.text,
      params,
      isVariadic,
      body,
      span: mergeSpans(start.span, body.span),
    };
  }

  private parseInterface(start: Token, visibility: ast.Visibility): ast.InterfaceDecl {
    this.expect(TokenKind.KwInterface, "'interface'");
    const name = this.expectIdentifier("interface name").text;
    const typeParams = this.parseTypeParams();
    const extendsTypes: ast.TypeRef[] = [];
    if (this.match(TokenKind.KwExtends)) {
      do {
        extendsTypes.push(this.parseType());
      } while (this.match(TokenKind.Comma));
    }

    this.expect(TokenKind.LBrace, "'{'");
    const methods: ast.MethodDecl[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.EOF)) {
      const memberStart = this.current;
      const memberVisibility = this.expectVisibility();
      if (
        this.check(TokenKind.KwFinal) ||
        this.check(TokenKind.KwStatic) ||
        this.check(TokenKind.KwExtern)
      ) {
        throw this.error(this.current, "interface methods cannot have modifiers");
      }
      let returnType: ast.TypeRef;
      let nameToken: Token;
      if (this.check(TokenKind.Identifier) && this.peek(1).kind === TokenKind.LParen) {
        nameToken = this.advance();
        returnType = { kind: "PrimitiveType", name: "void", span: nameToken.span };
      } else {
        returnType = this.parseType();
        nameToken = this.expectIdentifier("method name");
      }
      const { params, isVariadic } = this.parseParams();
      const end = this.expect(TokenKind.Semicolon, "';'");
      methods.push({
        kind: "MethodDecl",
        visibility: memberVisibility,
        isFinal: false,
        isStatic: false,
        isExtern: false,
        returnType,
        name: nameToken.text,
        params,
        isVariadic,
        span: mergeSpans(memberStart.span, end.span),
      });
    }
    const end = this.expect(TokenKind.RBrace, "'}'");

    return {
      kind: "InterfaceDecl",
      name,
      visibility,
      typeParams,
      extends: extendsTypes,
      methods,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseEnum(start: Token, visibility: ast.Visibility): ast.EnumDecl {
    this.expect(TokenKind.KwEnum, "'enum'");
    const name = this.expectIdentifier("enum name").text;
    this.expect(TokenKind.LBrace, "'{'");
    const members: ast.EnumMember[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.EOF)) {
      const member = this.expectIdentifier("enum member name");
      let value: bigint | undefined;
      if (this.match(TokenKind.Assign)) {
        let negative = false;
        if (this.match(TokenKind.Minus)) {
          negative = true;
        }
        const token = this.expect(TokenKind.IntLiteral, "integer enum value");
        value = negative ? -(token.value as bigint) : (token.value as bigint);
      }
      members.push({
        name: member.text,
        value,
        span: member.span,
      });
      if (!this.match(TokenKind.Comma)) {
        break;
      }
    }
    const end = this.expect(TokenKind.RBrace, "'}'");
    return {
      kind: "EnumDecl",
      name,
      visibility,
      members,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseTypeParams(): ast.TypeParam[] {
    if (!this.match(TokenKind.Lt)) {
      return [];
    }
    const params: ast.TypeParam[] = [];
    do {
      const token = this.expectIdentifier("type parameter name");
      params.push({ name: token.text, span: token.span });
    } while (this.match(TokenKind.Comma));
    this.expect(TokenKind.Gt, "'>'");
    return params;
  }

  private parseParams(): { params: ast.Param[]; isVariadic: boolean } {
    this.expect(TokenKind.LParen, "'('");
    const params: ast.Param[] = [];
    let isVariadic = false;
    if (!this.check(TokenKind.RParen)) {
      do {
        if (this.match(TokenKind.Ellipsis)) {
          isVariadic = true;
          break;
        }
        const type = this.parseType();
        const nameToken = this.expectIdentifier("parameter name");
        params.push({
          name: nameToken.text,
          type,
          span: mergeSpans(type.span, nameToken.span),
        });
        if (!this.match(TokenKind.Comma)) {
          break;
        }
        if (this.check(TokenKind.Ellipsis)) {
          this.advance();
          isVariadic = true;
          break;
        }
      } while (true);
    }
    this.expect(TokenKind.RParen, "')'");
    return { params, isVariadic };
  }

  private parseType(): ast.TypeRef {
    let type = this.parsePrimaryType();

    for (;;) {
      if (this.check(TokenKind.LBracket)) {
        this.advance();
        if (this.check(TokenKind.RBracket)) {
          const end = this.expect(TokenKind.RBracket, "']'");
          type = {
            kind: "ArrayType",
            element: type,
            span: mergeSpans(type.span, end.span),
          };
        } else {
          const size = this.parseExpression();
          const end = this.expect(TokenKind.RBracket, "']'");
          type = {
            kind: "ArrayType",
            element: type,
            size,
            span: mergeSpans(type.span, end.span),
          };
        }
        continue;
      }
      if (this.check(TokenKind.Question)) {
        const end = this.advance();
        type = {
          kind: "NullableType",
          inner: type,
          span: mergeSpans(type.span, end.span),
        };
        continue;
      }
      break;
    }

    return type;
  }

  private parsePrimaryType(): ast.TypeRef {
    const token = this.current;
    const primitive = PRIMITIVE_KEYWORDS.get(token.kind);
    if (primitive) {
      this.advance();
      return { kind: "PrimitiveType", name: primitive, span: token.span };
    }

    if (this.match(TokenKind.KwPtr)) {
      let target: ast.TypeRef | undefined;
      let end = this.previous();
      if (this.match(TokenKind.Lt)) {
        target = this.parseType();
        end = this.expect(TokenKind.Gt, "'>'");
      }
      return {
        kind: "PointerType",
        target,
        span: mergeSpans(token.span, end.span),
      };
    }

    if (this.check(TokenKind.Identifier)) {
      const name = this.parseQualifiedName("type name");
      const typeArgs: ast.TypeRef[] = [];
      let end = this.previous();
      if (this.check(TokenKind.Lt)) {
        this.advance();
        if (!this.check(TokenKind.Gt)) {
          do {
            typeArgs.push(this.parseType());
          } while (this.match(TokenKind.Comma));
        }
        end = this.expect(TokenKind.Gt, "'>'");
      }
      return {
        kind: "NamedType",
        name,
        typeArgs,
        span: mergeSpans(token.span, end.span),
      };
    }

    throw this.error(token, "expected a type");
  }

  private parseBlock(): ast.BlockStmt {
    const start = this.expect(TokenKind.LBrace, "'{'");
    const statements: ast.Stmt[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.EOF)) {
      statements.push(this.parseStatement());
    }
    const end = this.expect(TokenKind.RBrace, "'}'");
    return {
      kind: "BlockStmt",
      statements,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseStatement(): ast.Stmt {
    switch (this.current.kind) {
      case TokenKind.LBrace:
        return this.parseBlock();
      case TokenKind.KwIf:
        return this.parseIf();
      case TokenKind.KwWhile:
        return this.parseWhile();
      case TokenKind.KwFor:
        return this.parseFor();
      case TokenKind.KwSwitch:
        return this.parseSwitch();
      case TokenKind.KwReturn:
        return this.parseReturn();
      case TokenKind.KwBreak:
        return this.parseBreakOrContinue("BreakStmt");
      case TokenKind.KwContinue:
        return this.parseBreakOrContinue("ContinueStmt");
      case TokenKind.KwFinal:
        return this.parseVarDecl(true);
      case TokenKind.Dollar:
        return this.parseEnvDefault();
      default:
        break;
    }

    if (
      isTypeStartToken(this.current.kind) &&
      this.peek(1).kind !== TokenKind.LParen
    ) {
      return this.parseVarDecl(true);
    }

    const declaration = this.tryParseVarDecl(true);
    if (declaration) {
      return declaration;
    }
    return this.parseExprOrAssignStatement(true);
  }

  private parseVarDecl(requireSemicolon: boolean): ast.VarDeclStmt {
    const start = this.current;
    const isFinal = this.match(TokenKind.KwFinal);
    const type = this.parseType();
    const nameToken = this.expectIdentifier("variable name");
    let initializer: ast.Expr | undefined;
    if (this.match(TokenKind.Assign)) {
      initializer = this.parseExpression();
    }
    const end = requireSemicolon
      ? this.expect(TokenKind.Semicolon, "';'")
      : this.previousOrCurrent();
    return {
      kind: "VarDeclStmt",
      isFinal,
      type,
      name: nameToken.text,
      initializer,
      span: mergeSpans(start.span, end.span),
    };
  }

  private tryParseVarDecl(requireSemicolon: boolean): ast.VarDeclStmt | null {
    const savedIndex = this.index;
    try {
      const start = this.current;
      const isFinal = this.match(TokenKind.KwFinal);
      const type = this.parseType();
      if (!this.check(TokenKind.Identifier)) {
        this.index = savedIndex;
        return null;
      }
      const nameToken = this.advance();
      if (
        !this.check(TokenKind.Assign) &&
        !this.check(TokenKind.Semicolon)
      ) {
        this.index = savedIndex;
        return null;
      }
      let initializer: ast.Expr | undefined;
      if (this.match(TokenKind.Assign)) {
        initializer = this.parseExpression();
      }
      const end = requireSemicolon
        ? this.expect(TokenKind.Semicolon, "';'")
        : this.previousOrCurrent();
      return {
        kind: "VarDeclStmt",
        isFinal,
        type,
        name: nameToken.text,
        initializer,
        span: mergeSpans(start.span, end.span),
      };
    } catch (error) {
      this.index = savedIndex;
      if (error instanceof CoplError) {
        return null;
      }
      throw error;
    }
  }

  private parseExprOrAssignStatement(
    requireSemicolon: boolean,
  ): ast.ExprStmt | ast.AssignStmt {
    const start = this.current;
    const expression = this.parseExpression();
    let statement: ast.ExprStmt | ast.AssignStmt;

    const assignOp = ASSIGN_OPERATORS.get(this.current.kind);
    if (assignOp) {
      this.advance();
      const value = this.parseExpression();
      statement = {
        kind: "AssignStmt",
        target: expression,
        op: assignOp,
        value,
        span: mergeSpans(start.span, value.span),
      };
    } else {
      statement = {
        kind: "ExprStmt",
        expression,
        span: expression.span,
      };
    }

    if (requireSemicolon) {
      const end = this.expect(TokenKind.Semicolon, "';'");
      statement = {
        ...statement,
        span: mergeSpans(statement.span, end.span),
      };
    }
    return statement;
  }

  private parseIf(): ast.IfStmt {
    const start = this.expect(TokenKind.KwIf, "'if'");
    this.expect(TokenKind.LParen, "'('");
    const condition = this.parseExpression();
    this.expect(TokenKind.RParen, "')'");
    const thenBranch = this.parseStatement();
    let elseBranch: ast.Stmt | undefined;
    if (this.match(TokenKind.KwElse)) {
      elseBranch = this.parseStatement();
    }
    return {
      kind: "IfStmt",
      condition,
      thenBranch,
      elseBranch,
      span: mergeSpans(start.span, (elseBranch ?? thenBranch).span),
    };
  }

  private parseWhile(): ast.WhileStmt {
    const start = this.expect(TokenKind.KwWhile, "'while'");
    this.expect(TokenKind.LParen, "'('");
    const condition = this.parseExpression();
    this.expect(TokenKind.RParen, "')'");
    const body = this.parseStatement();
    return {
      kind: "WhileStmt",
      condition,
      body,
      span: mergeSpans(start.span, body.span),
    };
  }

  private parseFor(): ast.ForStmt {
    const start = this.expect(TokenKind.KwFor, "'for'");
    this.expect(TokenKind.LParen, "'('");

    let initializer: ast.VarDeclStmt | ast.ExprStmt | ast.AssignStmt | undefined;
    if (!this.check(TokenKind.Semicolon)) {
      if (
        this.check(TokenKind.KwFinal) ||
        (isTypeStartToken(this.current.kind) &&
          this.peek(1).kind !== TokenKind.LParen)
      ) {
        initializer = this.parseVarDecl(false);
      } else {
        initializer =
          this.tryParseVarDecl(false) ??
          this.parseExprOrAssignStatement(false);
      }
    }
    this.expect(TokenKind.Semicolon, "';'");

    let condition: ast.Expr | undefined;
    if (!this.check(TokenKind.Semicolon)) {
      condition = this.parseExpression();
    }
    this.expect(TokenKind.Semicolon, "';'");

    let update: ast.ExprStmt | ast.AssignStmt | undefined;
    if (!this.check(TokenKind.RParen)) {
      const updateStatement = this.parseExprOrAssignStatement(false);
      update = updateStatement;
    }
    this.expect(TokenKind.RParen, "')'");

    const body = this.parseStatement();
    return {
      kind: "ForStmt",
      initializer,
      condition,
      update,
      body,
      span: mergeSpans(start.span, body.span),
    };
  }

  private parseSwitch(): ast.SwitchStmt {
    const start = this.expect(TokenKind.KwSwitch, "'switch'");
    this.expect(TokenKind.LParen, "'('");
    const discriminant = this.parseExpression();
    this.expect(TokenKind.RParen, "')'");
    this.expect(TokenKind.LBrace, "'{'");

    const cases: ast.SwitchCase[] = [];
    while (!this.check(TokenKind.RBrace) && !this.check(TokenKind.EOF)) {
      const caseStart = this.current;
      let value: ast.Expr | undefined;
      if (this.match(TokenKind.KwCase)) {
        value = this.parseExpression();
      } else if (this.match(TokenKind.KwDefault)) {
        value = undefined;
      } else {
        throw this.error(this.current, "expected 'case' or 'default'");
      }
      const colon = this.expect(TokenKind.Colon, "':'");

      const statements: ast.Stmt[] = [];
      while (
        !this.check(TokenKind.KwCase) &&
        !this.check(TokenKind.KwDefault) &&
        !this.check(TokenKind.RBrace) &&
        !this.check(TokenKind.EOF)
      ) {
        statements.push(this.parseStatement());
      }
      const end = statements.at(-1)?.span ?? colon.span;
      cases.push({
        kind: "SwitchCase",
        value,
        statements,
        span: mergeSpans(caseStart.span, end),
      });
    }
    const end = this.expect(TokenKind.RBrace, "'}'");
    return {
      kind: "SwitchStmt",
      discriminant,
      cases,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseReturn(): ast.ReturnStmt {
    const start = this.expect(TokenKind.KwReturn, "'return'");
    let value: ast.Expr | undefined;
    if (!this.check(TokenKind.Semicolon)) {
      value = this.parseExpression();
    }
    const end = this.expect(TokenKind.Semicolon, "';'");
    return {
      kind: "ReturnStmt",
      value,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseBreakOrContinue(kind: "BreakStmt" | "ContinueStmt"): ast.Stmt {
    const start = this.advance();
    const end = this.expect(TokenKind.Semicolon, "';'");
    return { kind, span: mergeSpans(start.span, end.span) };
  }

  private parseEnvDefault(): ast.EnvDefaultStmt {
    const start = this.expect(TokenKind.Dollar, "'$'");
    const name = this.expectIdentifier("environment variable name");
    this.expect(TokenKind.Assign, "'='");
    const value = this.parseExpression();
    const end = this.expect(TokenKind.Semicolon, "';'");
    return {
      kind: "EnvDefaultStmt",
      name: name.text,
      value,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseExpression(): ast.Expr {
    return this.parseTernary();
  }

  private parseTernary(): ast.Expr {
    const condition = this.parseBinary(0);
    if (!this.match(TokenKind.Question)) {
      return condition;
    }
    const thenExpr = this.parseExpression();
    this.expect(TokenKind.Colon, "':'");
    const elseExpr = this.parseExpression();
    return {
      kind: "TernaryExpr",
      condition,
      thenExpr,
      elseExpr,
      span: mergeSpans(condition.span, elseExpr.span),
    };
  }

  private parseBinary(minPrecedence: number): ast.Expr {
    let left = this.parseUnary();

    for (;;) {
      const info = BINARY_OPERATORS.get(this.current.kind);
      if (!info || info.precedence < minPrecedence) {
        break;
      }
      this.advance();
      const right = this.parseBinary(info.precedence + 1);
      left = {
        kind: "BinaryExpr",
        op: info.op,
        left,
        right,
        span: mergeSpans(left.span, right.span),
      };
    }

    return left;
  }

  private parseUnary(): ast.Expr {
    if (this.check(TokenKind.PlusPlus) || this.check(TokenKind.MinusMinus)) {
      const start = this.advance();
      const operand = this.parseUnary();
      return {
        kind: "UpdateExpr",
        op: start.kind === TokenKind.PlusPlus ? "++" : "--",
        operand,
        prefix: true,
        span: mergeSpans(start.span, operand.span),
      };
    }

    const unaryOp = UNARY_OPERATORS.get(this.current.kind);
    if (unaryOp) {
      const start = this.advance();
      const operand = this.parseUnary();
      return {
        kind: "UnaryExpr",
        op: unaryOp,
        operand,
        span: mergeSpans(start.span, operand.span),
      };
    }

    if (this.check(TokenKind.Amp)) {
      return this.parseAmpExpression();
    }

    return this.parsePostfix();
  }

  private parseAmpExpression(): ast.Expr {
    const start = this.expect(TokenKind.Amp, "'&'");
    let workers: number | undefined;
    if (this.check(TokenKind.IntLiteral)) {
      const token = this.advance();
      const value = Number(token.value);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw this.error(token, "worker count must be a positive integer");
      }
      workers = value;
    }
    if (
      this.check(TokenKind.Identifier) &&
      this.peek(1).kind === TokenKind.LParen
    ) {
      const method = this.advance();
      const args = this.parseCallArguments();
      return {
        kind: "WorkerCallExpr",
        workers,
        method: method.text,
        args: args.values,
        span: mergeSpans(start.span, args.end.span),
      };
    }
    if (workers !== undefined) {
      throw this.error(this.current, "worker count requires a method call");
    }
    const expression = this.parseUnary();
    return {
      kind: "TaskProbeExpr",
      expression,
      span: mergeSpans(start.span, expression.span),
    };
  }

  private parsePostfix(): ast.Expr {
    let expression = this.parsePrimary();

    for (;;) {
      if (this.match(TokenKind.Dot)) {
        const member = this.expectIdentifier("member name");
        expression = {
          kind: "MemberExpr",
          object: expression,
          member: member.text,
          span: mergeSpans(expression.span, member.span),
        };
        continue;
      }
      if (this.match(TokenKind.LBracket)) {
        const index = this.parseExpression();
        const end = this.expect(TokenKind.RBracket, "']'");
        expression = {
          kind: "IndexExpr",
          object: expression,
          index,
          span: mergeSpans(expression.span, end.span),
        };
        continue;
      }
      if (this.check(TokenKind.LParen)) {
        const args = this.parseCallArguments();
        expression = {
          kind: "CallExpr",
          callee: expression,
          args: args.values,
          span: mergeSpans(expression.span, args.end.span),
        };
        continue;
      }
      if (this.check(TokenKind.PlusPlus) || this.check(TokenKind.MinusMinus)) {
        const op = this.advance();
        expression = {
          kind: "UpdateExpr",
          op: op.kind === TokenKind.PlusPlus ? "++" : "--",
          operand: expression,
          prefix: false,
          span: mergeSpans(expression.span, op.span),
        };
        continue;
      }
      break;
    }

    return expression;
  }

  private parseCallArguments(): { values: ast.Expr[]; end: Token } {
    this.expect(TokenKind.LParen, "'('");
    const values: ast.Expr[] = [];
    if (!this.check(TokenKind.RParen)) {
      do {
        values.push(this.parseExpression());
      } while (this.match(TokenKind.Comma));
    }
    const end = this.expect(TokenKind.RParen, "')'");
    return { values, end };
  }

  private parsePrimary(): ast.Expr {
    const token = this.current;

    switch (token.kind) {
      case TokenKind.IntLiteral:
        this.advance();
        return {
          kind: "IntLiteralExpr",
          value: token.value as bigint,
          raw: token.text,
          span: token.span,
        };
      case TokenKind.FloatLiteral:
        this.advance();
        return {
          kind: "FloatLiteralExpr",
          value: token.value as number,
          raw: token.text,
          span: token.span,
        };
      case TokenKind.StringLiteral:
        this.advance();
        return {
          kind: "StringLiteralExpr",
          value: String(token.value ?? ""),
          span: token.span,
        };
      case TokenKind.CharLiteral:
        this.advance();
        return {
          kind: "CharLiteralExpr",
          value: String(token.value ?? ""),
          span: token.span,
        };
      case TokenKind.KwTrue:
      case TokenKind.KwFalse:
        this.advance();
        return {
          kind: "BoolLiteralExpr",
          value: token.kind === TokenKind.KwTrue,
          span: token.span,
        };
      case TokenKind.KwNull:
        this.advance();
        return { kind: "NullLiteralExpr", span: token.span };
      case TokenKind.KwSelf:
        this.advance();
        return { kind: "SelfExpr", span: token.span };
      case TokenKind.KwSuper:
        this.advance();
        return { kind: "SuperExpr", span: token.span };
      case TokenKind.Identifier:
        this.advance();
        return {
          kind: "IdentifierExpr",
          name: token.text,
          span: token.span,
        };
      case TokenKind.KwEnv:
      case TokenKind.KwSyscall:
      case TokenKind.KwCopy:
        this.advance();
        return {
          kind: "IdentifierExpr",
          name: token.text,
          span: token.span,
        };
      case TokenKind.KwNew:
        return this.parseNew();
      case TokenKind.LParen: {
        const start = this.advance();
        const expression = this.parseExpression();
        const end = this.expect(TokenKind.RParen, "')'");
        return { ...expression, span: mergeSpans(start.span, end.span) };
      }
      case TokenKind.LBracket:
        return this.parseArrayLiteral();
      default:
        break;
    }

    if (isTypeStartToken(token.kind)) {
      return this.parseCast();
    }

    throw this.error(token, "expected an expression");
  }

  private parseCast(): ast.CastExpr {
    const start = this.current;
    const target = this.parseType();
    this.expect(TokenKind.LParen, "'('");
    const value = this.parseExpression();
    const end = this.expect(TokenKind.RParen, "')'");
    return {
      kind: "CastExpr",
      target,
      value,
      span: mergeSpans(start.span, end.span),
    };
  }

  private parseNew(): ast.Expr {
    const start = this.expect(TokenKind.KwNew, "'new'");
    const type = this.parseType();

    if (type.kind === "ArrayType" && type.size) {
      return {
        kind: "NewArrayExpr",
        elementType: type.element,
        size: type.size,
        span: mergeSpans(start.span, type.span),
      };
    }

    if (type.kind === "ArrayType") {
      throw this.error(this.current, "array allocation requires a size");
    }

    if (this.check(TokenKind.LParen)) {
      const args = this.parseCallArguments();
      return {
        kind: "NewObjectExpr",
        type,
        args: args.values,
        span: mergeSpans(start.span, args.end.span),
      };
    }

    throw this.error(this.current, "expected '(' or '[' after 'new' type");
  }

  private parseArrayLiteral(): ast.ArrayLiteralExpr {
    const start = this.expect(TokenKind.LBracket, "'['");
    const elements: ast.Expr[] = [];
    if (!this.check(TokenKind.RBracket)) {
      do {
        if (this.match(TokenKind.Ellipsis)) {
          const ellipsis = this.previous();
          const expression = this.parseExpression();
          elements.push({
            kind: "SpreadExpr",
            expression,
            span: mergeSpans(ellipsis.span, expression.span),
          });
        } else {
          elements.push(this.parseExpression());
        }
      } while (this.match(TokenKind.Comma));
    }
    const end = this.expect(TokenKind.RBracket, "']'");
    return {
      kind: "ArrayLiteralExpr",
      elements,
      span: mergeSpans(start.span, end.span),
    };
  }

  private matchVisibility(): ast.Visibility | undefined {
    const visibility = VISIBILITY_KEYWORDS.get(this.current.kind);
    if (visibility) {
      this.advance();
    }
    return visibility;
  }

  private expectVisibility(): ast.Visibility {
    const visibility = this.matchVisibility();
    if (!visibility) {
      throw this.error(
        this.current,
        "visibility modifier required (public, protected, internal, or private)",
      );
    }
    return visibility;
  }

  private expectIdentifier(what: string): Token {
    if (!this.check(TokenKind.Identifier)) {
      throw this.error(this.current, `expected ${what}`);
    }
    return this.advance();
  }

  private expect(kind: TokenKind, what: string): Token {
    if (!this.check(kind)) {
      throw this.error(this.current, `expected ${what}`);
    }
    return this.advance();
  }

  private match(kind: TokenKind): boolean {
    if (!this.check(kind)) {
      return false;
    }
    this.advance();
    return true;
  }

  private check(kind: TokenKind): boolean {
    return this.current.kind === kind;
  }

  private advance(): Token {
    const token = this.current;
    if (token.kind !== TokenKind.EOF) {
      this.index += 1;
    }
    return token;
  }

  private get current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private peek(ahead: number): Token {
    return (
      this.tokens[this.index + ahead] ??
      this.tokens[this.tokens.length - 1]!
    );
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.index - 1)] ?? this.current;
  }

  private previousOrCurrent(): Token {
    return this.previous();
  }

  private error(token: Token, message: string): CoplError {
    const found = token.kind === TokenKind.EOF
      ? "end of file"
      : `'${token.text || tokenKindName(token.kind)}'`;
    return new CoplError(`${message} (found ${found})`, token.span);
  }
}

export function parseSourceUnit(
  file: SourceFile,
  tokens?: readonly Token[],
): ast.SourceUnit {
  return new Parser(file, tokens).parseSourceUnit();
}
