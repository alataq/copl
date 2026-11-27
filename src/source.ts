export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface Position {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface Span {
  readonly file: string;
  readonly start: Position;
  readonly end: Position;
}

export function sourceFile(path: string, text: string): SourceFile {
  return { path, text };
}

export function makeSpan(file: string, start: Position, end: Position): Span {
  return { file, start, end };
}

export function mergeSpans(left: Span, right: Span): Span {
  if (left.file !== right.file) {
    throw new Error("cannot merge spans from different files");
  }
  const start = left.start.offset <= right.start.offset ? left.start : right.start;
  const end = left.end.offset >= right.end.offset ? left.end : right.end;
  return makeSpan(left.file, start, end);
}

export function pointSpan(file: string, position: Position): Span {
  return makeSpan(file, position, position);
}
