import { describe, expect, test } from "bun:test";
import { tokenize } from "../src/lexer/lexer";
import { TokenKind } from "../src/lexer/token";
import { sourceFile } from "../src/source";

describe("lexer", () => {
  test("recognizes keywords, qualified names, and spans", () => {
    const file = sourceFile("test.copl", "namespace copl::io {\n  public class File {}\n}");
    const tokens = tokenize(file);

    expect(tokens[0]!.kind).toBe(TokenKind.KwNamespace);
    expect(tokens[1]!.text).toBe("copl");
    expect(tokens[2]!.kind).toBe(TokenKind.ColonColon);
    expect(tokens[3]!.text).toBe("io");
    expect(tokens.some((token) => token.kind === TokenKind.KwPublic)).toBe(true);
    expect(tokens.some((token) => token.kind === TokenKind.KwClass)).toBe(true);

    const internal = tokenize(sourceFile("internal.copl", "internal __cleanup"));
    expect(internal[0]!.kind).toBe(TokenKind.KwInternal);
    expect(internal[1]!.text).toBe("__cleanup");

    const classToken = tokens.find((token) => token.kind === TokenKind.KwClass)!;
    expect(classToken.span.start.line).toBe(2);
    expect(classToken.span.start.column).toBe(10);
    expect(tokens.at(-1)!.kind).toBe(TokenKind.EOF);
  });

  test("captures cinline blocks while ignoring braces in strings and comments", () => {
    const code = [
      "cinline {",
      '  static const char *brace = "}";',
      "  // this brace must not close: }",
      "  /* neither { */",
      "  int f(void) { return 1; }",
      "}",
      "",
    ].join("\n");
    const tokens = tokenize(sourceFile("test.copl", code));

    expect(tokens).toHaveLength(2);
    expect(tokens[0]!.kind).toBe(TokenKind.CInlineBlock);
    expect(tokens[0]!.value).toContain('static const char *brace = "}";');
    expect(tokens[0]!.value).toContain("int f(void) { return 1; }");
    expect(tokens[0]!.span.start.line).toBe(1);
  });

  test("decodes string and char escapes", () => {
    const tokens = tokenize(sourceFile("test.copl", '"a\\n\\"b"\n\'\\n\'\n'));
    expect(tokens[0]!.kind).toBe(TokenKind.StringLiteral);
    expect(tokens[0]!.value).toBe('a\n"b');
    expect(tokens[1]!.kind).toBe(TokenKind.CharLiteral);
    expect(tokens[1]!.value).toBe("\n");
  });

  test("lexes numeric bases and worker prefixes", () => {
    const tokens = tokenize(sourceFile("test.copl", "0xFF 0b1010 42 &4work"));
    expect(tokens[0]!.kind).toBe(TokenKind.IntLiteral);
    expect(tokens[0]!.value).toBe(255n);
    expect(tokens[1]!.value).toBe(10n);
    expect(tokens[2]!.value).toBe(42n);
    expect(tokens[3]!.kind).toBe(TokenKind.Amp);
    expect(tokens[4]!.value).toBe(4n);
    expect(tokens[5]!.kind).toBe(TokenKind.Identifier);
  });
});
