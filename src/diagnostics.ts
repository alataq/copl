import type { Span } from "./source";

export type DiagnosticSeverity = "error" | "warning" | "note";

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly span?: Span;
  readonly code?: string;
}

export class CoplError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, span?: Span, code?: string) {
    super(message);
    this.name = "CoplError";
    this.diagnostics = [{ severity: "error", message, span, code }];
  }

  static fromDiagnostics(diagnostics: readonly Diagnostic[]): CoplError {
    const first = diagnostics.find((d) => d.severity === "error") ?? diagnostics[0];
    const error = new CoplError(first?.message ?? "compilation failed");
    Object.defineProperty(error, "diagnostics", { value: diagnostics });
    return error;
  }
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const location = diagnostic.span
    ? `${diagnostic.span.file}:${diagnostic.span.start.line}:${diagnostic.span.start.column}`
    : "<project>";
  const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
  return `${location}: ${diagnostic.severity}${code}: ${diagnostic.message}`;
}

export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map(formatDiagnostic).join("\n");
}
