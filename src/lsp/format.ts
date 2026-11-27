import { tokenize } from "../lexer/lexer";
import { TokenKind } from "../lexer/token";
import { sourceFile } from "../source";

function trimTrailing(line: string): string {
  return line.replace(/[ \t]+$/, "");
}

export function formatCopl(path: string, text: string): string {
  let tokens;
  try {
    tokens = tokenize(sourceFile(path, text));
  } catch {
    return text;
  }

  const rawLines = new Set<number>();
  const braces = new Map<number, { open: number; close: number }>();
  for (const token of tokens) {
    if (token.kind === TokenKind.CInlineBlock) {
      for (let line = token.span.start.line; line <= token.span.end.line; line += 1) {
        rawLines.add(line);
      }
      continue;
    }
    if (token.kind !== TokenKind.LBrace && token.kind !== TokenKind.RBrace) {
      continue;
    }
    const line = token.span.start.line;
    const entry = braces.get(line) ?? { open: 0, close: 0 };
    if (token.kind === TokenKind.LBrace) {
      entry.open += 1;
    } else {
      entry.close += 1;
    }
    braces.set(line, entry);
  }

  const lines = text.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const output: string[] = [];
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const original = trimTrailing(lines[index] ?? "");
    if (rawLines.has(lineNumber)) {
      output.push(original);
      continue;
    }

    const trimmed = original.trimStart();
    if (trimmed.length === 0) {
      output.push("");
      continue;
    }

    const startsWithClose = trimmed.startsWith("}");
    const indentDepth = Math.max(0, depth - (startsWithClose ? 1 : 0));
    output.push(`${"    ".repeat(indentDepth)}${trimmed}`);

    const counts = braces.get(lineNumber) ?? { open: 0, close: 0 };
    depth = Math.max(0, depth + counts.open - counts.close);
  }

  return `${output.join("\n").replace(/\n+$/, "")}\n`;
}
