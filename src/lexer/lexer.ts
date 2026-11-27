import { CoplError } from "../diagnostics";
import { makeSpan, type Position, type SourceFile } from "../source";
import {
  KEYWORDS,
  TokenKind,
  type LiteralValue,
  type Token,
} from "./token";

const SINGLE_CHAR_TOKENS: ReadonlyMap<string, TokenKind> = new Map([
  ["{", TokenKind.LBrace],
  ["}", TokenKind.RBrace],
  ["(", TokenKind.LParen],
  [")", TokenKind.RParen],
  ["[", TokenKind.LBracket],
  ["]", TokenKind.RBracket],
  [".", TokenKind.Dot],
  [",", TokenKind.Comma],
  [";", TokenKind.Semicolon],
  ["?", TokenKind.Question],
  ["$", TokenKind.Dollar],
  ["^", TokenKind.Caret],
  ["~", TokenKind.Tilde],
]);

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHexDigit(ch: string): boolean {
  return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

function isIdentifierStart(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

function isIdentifierContinue(ch: string): boolean {
  return isIdentifierStart(ch) || isDigit(ch);
}

export class Lexer {
  private offset = 0;
  private line = 1;
  private column = 1;
  private readonly tokens: Token[] = [];

  constructor(private readonly file: SourceFile) {}

  tokenize(): Token[] {
    while (!this.atEnd()) {
      this.skipTrivia();
      if (this.atEnd()) {
        break;
      }
      this.tokens.push(this.nextToken());
    }
    const position = this.position();
    this.tokens.push({
      kind: TokenKind.EOF,
      text: "",
      span: makeSpan(this.file.path, position, position),
    });
    return this.tokens;
  }

  private nextToken(): Token {
    const start = this.position();
    const ch = this.peek();

    if (isIdentifierStart(ch)) {
      return this.readIdentifierOrKeyword(start);
    }
    if (isDigit(ch)) {
      return this.readNumber(start);
    }
    if (ch === '"' || ch === "'") {
      return this.readQuoted(start, ch);
    }

    return this.readPunctuation(start);
  }

  private readIdentifierOrKeyword(start: Position): Token {
    while (isIdentifierContinue(this.peek())) {
      this.advance();
    }
    const text = this.file.text.slice(start.offset, this.offset);

    if (text === "cinline") {
      this.skipTrivia();
      if (this.peek() !== "{") {
        throw new CoplError("expected '{' after 'cinline'", this.spanFrom(start));
      }
      this.advance();
      const code = this.readRawCBlock();
      return {
        kind: TokenKind.CInlineBlock,
        text,
        value: code,
        span: this.spanFrom(start),
      };
    }

    const keyword = KEYWORDS.get(text);
    return {
      kind: keyword ?? TokenKind.Identifier,
      text,
      span: this.spanFrom(start),
    };
  }

  private readNumber(start: Position): Token {
    let isFloat = false;
    const first = this.peek();
    const second = this.peek(1);

    if (first === "0" && (second === "x" || second === "X")) {
      this.advance();
      this.advance();
      const digitsStart = this.offset;
      while (isHexDigit(this.peek()) || this.peek() === "_") {
        this.advance();
      }
      if (this.offset === digitsStart) {
        throw new CoplError("expected hexadecimal digits", this.spanFrom(start));
      }
      return this.intToken(start);
    }

    if (first === "0" && (second === "b" || second === "B")) {
      this.advance();
      this.advance();
      const digitsStart = this.offset;
      while (this.peek() === "0" || this.peek() === "1" || this.peek() === "_") {
        this.advance();
      }
      if (this.offset === digitsStart) {
        throw new CoplError("expected binary digits", this.spanFrom(start));
      }
      return this.intToken(start);
    }

    if (first === "0" && (second === "o" || second === "O")) {
      this.advance();
      this.advance();
      const digitsStart = this.offset;
      while ((this.peek() >= "0" && this.peek() <= "7") || this.peek() === "_") {
        this.advance();
      }
      if (this.offset === digitsStart) {
        throw new CoplError("expected octal digits", this.spanFrom(start));
      }
      return this.intToken(start);
    }

    while (isDigit(this.peek()) || this.peek() === "_") {
      this.advance();
    }

    if (this.peek() === "." && isDigit(this.peek(1))) {
      isFloat = true;
      this.advance();
      while (isDigit(this.peek()) || this.peek() === "_") {
        this.advance();
      }
    }

    if (this.peek() === "e" || this.peek() === "E") {
      isFloat = true;
      this.advance();
      if (this.peek() === "+" || this.peek() === "-") {
        this.advance();
      }
      const digitsStart = this.offset;
      while (isDigit(this.peek()) || this.peek() === "_") {
        this.advance();
      }
      if (this.offset === digitsStart) {
        throw new CoplError("expected exponent digits", this.spanFrom(start));
      }
    }

    const text = this.file.text.slice(start.offset, this.offset);
    if (isFloat) {
      return {
        kind: TokenKind.FloatLiteral,
        text,
        value: Number(text.replace(/_/g, "")),
        span: this.spanFrom(start),
      };
    }
    return this.intToken(start);
  }

  private intToken(start: Position): Token {
    const text = this.file.text.slice(start.offset, this.offset);
    const normalized = text.replace(/_/g, "");
    let value: bigint;
    try {
      value = BigInt(normalized);
    } catch {
      throw new CoplError(`invalid integer literal '${text}'`, this.spanFrom(start));
    }
    return {
      kind: TokenKind.IntLiteral,
      text,
      value,
      span: this.spanFrom(start),
    };
  }

  private readQuoted(start: Position, quote: string): Token {
    this.advance();
    let value = "";

    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === quote) {
        this.advance();
        const text = this.file.text.slice(start.offset, this.offset);
        if (quote === "'" && Array.from(value).length !== 1) {
          throw new CoplError("char literal must contain exactly one character", this.spanFrom(start));
        }
        return {
          kind: quote === '"' ? TokenKind.StringLiteral : TokenKind.CharLiteral,
          text,
          value,
          span: this.spanFrom(start),
        };
      }
      if (ch === "\n") {
        throw new CoplError("unterminated string literal", this.spanFrom(start));
      }
      if (ch === "\\") {
        this.advance();
        value += this.readEscape(start);
      } else {
        value += this.advance();
      }
    }

    throw new CoplError("unterminated string literal", this.spanFrom(start));
  }

  private readEscape(start: Position): string {
    const ch = this.advance();
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "v":
        return "\v";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      case '"':
        return '"';
      case "'":
        return "'";
      case "x": {
        let digits = "";
        for (let i = 0; i < 2; i += 1) {
          const digit = this.peek();
          if (!isHexDigit(digit)) {
            throw new CoplError("expected two hex digits after '\\x'", this.spanFrom(start));
          }
          digits += this.advance();
        }
        return String.fromCodePoint(Number.parseInt(digits, 16));
      }
      case "u": {
        let digits = "";
        for (let i = 0; i < 4; i += 1) {
          const digit = this.peek();
          if (!isHexDigit(digit)) {
            throw new CoplError("expected four hex digits after '\\u'", this.spanFrom(start));
          }
          digits += this.advance();
        }
        return String.fromCodePoint(Number.parseInt(digits, 16));
      }
      default:
        throw new CoplError(`invalid escape sequence '\\${ch}'`, this.spanFrom(start));
    }
  }

  private readPunctuation(start: Position): Token {
    const ch = this.advance();
    const next = this.peek();

    let kind: TokenKind | undefined;
    switch (ch) {
      case ":":
        kind = next === ":" ? (this.advance(), TokenKind.ColonColon) : TokenKind.Colon;
        break;
      case "=":
        kind = next === "=" ? (this.advance(), TokenKind.EqEq) : TokenKind.Assign;
        break;
      case "!":
        kind = next === "=" ? (this.advance(), TokenKind.BangEq) : TokenKind.Bang;
        break;
      case "<":
        kind = next === "=" ? (this.advance(), TokenKind.Le) : TokenKind.Lt;
        break;
      case ">":
        kind = next === "=" ? (this.advance(), TokenKind.Ge) : TokenKind.Gt;
        break;
      case "&":
        kind = next === "&" ? (this.advance(), TokenKind.AndAnd) : TokenKind.Amp;
        break;
      case "|":
        kind = next === "|" ? (this.advance(), TokenKind.OrOr) : TokenKind.Pipe;
        break;
      case "+":
        if (next === "+") {
          this.advance();
          kind = TokenKind.PlusPlus;
        } else if (next === "=") {
          this.advance();
          kind = TokenKind.PlusAssign;
        } else {
          kind = TokenKind.Plus;
        }
        break;
      case "-":
        if (next === "-") {
          this.advance();
          kind = TokenKind.MinusMinus;
        } else if (next === "=") {
          this.advance();
          kind = TokenKind.MinusAssign;
        } else {
          kind = TokenKind.Minus;
        }
        break;
      case ".":
        if (next === "." && this.peek(1) === ".") {
          this.advance();
          this.advance();
          kind = TokenKind.Ellipsis;
        } else {
          kind = TokenKind.Dot;
        }
        break;
      case "*":
        kind = next === "=" ? (this.advance(), TokenKind.StarAssign) : TokenKind.Star;
        break;
      case "/":
        kind = next === "=" ? (this.advance(), TokenKind.SlashAssign) : TokenKind.Slash;
        break;
      case "%":
        kind = next === "=" ? (this.advance(), TokenKind.PercentAssign) : TokenKind.Percent;
        break;
      default:
        kind = SINGLE_CHAR_TOKENS.get(ch);
    }

    if (kind === undefined) {
      throw new CoplError(`unexpected character '${ch}'`, this.spanFrom(start));
    }

    return {
      kind,
      text: this.file.text.slice(start.offset, this.offset),
      span: this.spanFrom(start),
    };
  }

  private readRawCBlock(): string {
    let depth = 1;
    let code = "";

    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === '"' || ch === "'") {
        code += this.copyRawQuoted(ch);
        continue;
      }
      if (ch === "/" && this.peek(1) === "/") {
        while (!this.atEnd() && this.peek() !== "\n") {
          code += this.advance();
        }
        continue;
      }
      if (ch === "/" && this.peek(1) === "*") {
        code += this.advance();
        code += this.advance();
        while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) {
          code += this.advance();
        }
        if (this.atEnd()) {
          throw new CoplError("unterminated block comment in 'cinline' block");
        }
        code += this.advance();
        code += this.advance();
        continue;
      }
      if (ch === "{") {
        depth += 1;
        code += this.advance();
        continue;
      }
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          this.advance();
          return code;
        }
        code += this.advance();
        continue;
      }
      code += this.advance();
    }

    throw new CoplError("unterminated 'cinline' block");
  }

  private copyRawQuoted(quote: string): string {
    let text = this.advance();
    while (!this.atEnd()) {
      const ch = this.advance();
      text += ch;
      if (ch === "\\") {
        if (!this.atEnd()) {
          text += this.advance();
        }
        continue;
      }
      if (ch === quote) {
        return text;
      }
    }
    throw new CoplError("unterminated string in 'cinline' block");
  }

  private skipTrivia(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        this.advance();
        continue;
      }
      if (ch === "/" && this.peek(1) === "/") {
        while (!this.atEnd() && this.peek() !== "\n") {
          this.advance();
        }
        continue;
      }
      if (ch === "/" && this.peek(1) === "*") {
        const start = this.position();
        this.advance();
        this.advance();
        while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) {
          this.advance();
        }
        if (this.atEnd()) {
          throw new CoplError("unterminated block comment", this.spanFrom(start));
        }
        this.advance();
        this.advance();
        continue;
      }
      return;
    }
  }

  private atEnd(): boolean {
    return this.offset >= this.file.text.length;
  }

  private peek(ahead = 0): string {
    return this.file.text[this.offset + ahead] ?? "";
  }

  private advance(): string {
    const ch = this.file.text[this.offset] ?? "";
    if (ch === "") {
      return ch;
    }
    this.offset += 1;
    if (ch === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return ch;
  }

  private position(): Position {
    return { offset: this.offset, line: this.line, column: this.column };
  }

  private spanFrom(start: Position) {
    return makeSpan(this.file.path, start, this.position());
  }
}

export function tokenize(file: SourceFile): Token[] {
  return new Lexer(file).tokenize();
}
