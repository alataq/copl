import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as ast from "../ast";
import { CoplError, type Diagnostic as CoplDiagnostic } from "../diagnostics";
import { loadManifest, type LoadedManifest } from "../manifest";
import { defaultModuleRoots } from "../modulePaths";
import { parseSourceUnit } from "../parser/parser";
import { resolveProject, type ProjectFile } from "../resolver";
import { analyzeProject, analyzeUnits } from "../sema/checker";
import type { SemanticModel, TypeSymbol } from "../sema/symbols";
import { displayType } from "../sema/types";
import { sourceFile, type Position, type Span } from "../source";
import { formatCopl } from "./format";
import { readJsonRpc, writeJsonRpc, type JsonRpcMessage } from "./transport";

type Json = Record<string, any>;

interface OpenDocument {
  uri: string;
  path: string;
  text: string;
  version: number;
}

interface AnalysisSuccess {
  ok: true;
  model: SemanticModel;
  units: readonly ProjectFile[];
  texts: Map<string, string>;
}

interface AnalysisFailure {
  ok: false;
  error: CoplError;
  texts: Map<string, string>;
}

type AnalysisResult = AnalysisSuccess | AnalysisFailure;

const KEYWORDS = [
  "namespace", "import", "class", "interface", "extends", "implements",
  "public", "protected", "internal", "private", "final", "static", "extern",
  "new", "if", "else", "switch", "case", "default", "for", "while",
  "return", "break", "continue", "null", "true", "false", "self", "super",
  "void", "int", "uint", "i32", "u32", "byte", "char", "float", "bool", "ptr",
  "cinclude", "clink",
];

const BUILTINS = [
  "env", "syscall", "copy",
  "va_int", "va_i32", "va_u32", "va_uint",
  "va_float", "va_bool", "va_char", "va_ptr", "va_char_array",
];

function uriToPath(uri: string): string {
  return resolve(fileURLToPath(uri));
}

function pathToUri(path: string): string {
  return pathToFileURL(path).href;
}

function rangeFromSpan(span: Span): Json {
  return {
    start: {
      line: span.start.line - 1,
      character: span.start.column - 1,
    },
    end: {
      line: span.end.line - 1,
      character: span.end.column - 1,
    },
  };
}

function positionAt(text: string, offset: number): Json {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, character: offset - lineStart };
}

function offsetAt(text: string, line: number, character: number): number {
  let offset = 0;
  let currentLine = 0;
  while (currentLine < line && offset < text.length) {
    const next = text.indexOf("\n", offset);
    if (next < 0) {
      return text.length;
    }
    offset = next + 1;
    currentLine += 1;
  }
  return Math.min(offset + character, text.length);
}

function wordAt(
  text: string,
  line: number,
  character: number,
): { word: string; start: number; end: number } | undefined {
  const offset = offsetAt(text, line, character);
  const isWord = (ch: string | undefined): boolean =>
    ch !== undefined && /[A-Za-z0-9_]/.test(ch);
  let start = offset;
  let end = offset;
  while (start > 0 && isWord(text[start - 1])) {
    start -= 1;
  }
  while (end < text.length && isWord(text[end])) {
    end += 1;
  }
  if (start === end) {
    return undefined;
  }
  return { word: text.slice(start, end), start, end };
}

function lspSeverity(severity: CoplDiagnostic["severity"]): number {
  if (severity === "error") {
    return 1;
  }
  if (severity === "warning") {
    return 2;
  }
  return 3;
}

export class LanguageServer {
  private readonly documents = new Map<string, OpenDocument>();
  private rootPath?: string;
  private shutdownRequested = false;

  async run(): Promise<void> {
    await readJsonRpc((message) => {
      void this.dispatch(message);
    });
  }

  private overlays(): Map<string, string> {
    const overlays = new Map<string, string>();
    for (const document of this.documents.values()) {
      overlays.set(document.path, document.text);
    }
    return overlays;
  }

  private findProjectRoot(filePath: string): string | undefined {
    let current = dirname(filePath);
    for (;;) {
      if (existsSync(join(current, "manifest.json"))) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  private syntheticManifest(root: string, path: string): LoadedManifest {
    const absolutePath = resolve(path);
    return {
      root,
      manifestPath: join(root, "<lsp>"),
      defaultEntry: "__lsp",
      entries: new Map([
        [
          "__lsp",
          {
            name: "__lsp",
            path: absolutePath,
            absolutePath,
          },
        ],
      ]),
      defaultWorkers: 1,
      linkerFlags: [],
    };
  }

  private analyzeSynthetic(
    root: string,
    path: string,
    overlays: ReadonlyMap<string, string>,
  ): AnalysisResult {
    try {
      const manifest = this.syntheticManifest(root, path);
      const project = resolveProject(manifest, {
        env: {},
        overlays,
        coplPath: defaultModuleRoots(),
      });
      const model = analyzeProject(project);
      const texts = new Map<string, string>();
      for (const file of project.files) {
        texts.set(resolve(file.path), this.textFor(resolve(file.path)));
      }
      return { ok: true, model, units: project.files, texts };
    } catch (error) {
      if (error instanceof CoplError) {
        const texts = new Map<string, string>();
        texts.set(resolve(path), this.textFor(resolve(path)));
        return { ok: false, error, texts };
      }
      throw error;
    }
  }

  private textFor(path: string): string {
    const overlays = this.overlays();
    const override = overlays.get(path);
    if (override !== undefined) {
      return override;
    }
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }

  private analyze(uri: string): AnalysisResult {
    const document = this.documents.get(uri);
    const path = document?.path ?? uriToPath(uri);
    const text = document?.text ?? this.textFor(path);
    const overlays = this.overlays();
    const projectRoot = this.findProjectRoot(path) ?? this.rootPath;

    if (projectRoot && existsSync(join(projectRoot, "manifest.json"))) {
      try {
        const manifest = loadManifest(projectRoot);
        const project = resolveProject(manifest, {
          env: {},
          overlays,
          coplPath: defaultModuleRoots(),
        });
        const projectPath = resolve(path);
        if (
          project.units.has(projectPath) ||
          project.files.some((file) => resolve(file.path) === projectPath)
        ) {
          const model = analyzeProject(project);
          const texts = new Map<string, string>();
          for (const file of project.files) {
            texts.set(resolve(file.path), this.textFor(resolve(file.path)));
          }
          return { ok: true, model, units: project.files, texts };
        }
      } catch (error) {
        if (error instanceof CoplError) {
          const texts = new Map<string, string>();
          texts.set(resolve(path), text);
          return { ok: false, error, texts };
        }
        throw error;
      }
    }

    return this.analyzeSynthetic(
      projectRoot ?? dirname(path),
      path,
      overlays,
    );
  }

  private lspDiagnostic(diagnostic: CoplDiagnostic, fallbackPath: string): Json {
    const span = diagnostic.span;
    return {
      range: span
        ? rangeFromSpan(span)
        : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      severity: lspSeverity(diagnostic.severity),
      source: "coplc",
      code: diagnostic.code,
      message: `${diagnostic.message}${span ? ` [${fallbackPath}]` : ""}`,
    };
  }

  private publishDiagnostics(uri: string): void {
    const document = this.documents.get(uri);
    const path = document?.path ?? uriToPath(uri);
    const result = this.analyze(uri);
    if (!result.ok) {
      const grouped = new Map<string, Json[]>();
      for (const diagnostic of result.error.diagnostics) {
        const diagnosticPath = diagnostic.span?.file ?? path;
        const targetUri = pathToUri(resolve(diagnosticPath));
        const list = grouped.get(targetUri) ?? [];
        list.push(this.lspDiagnostic(diagnostic, path));
        grouped.set(targetUri, list);
      }
      this.sendNotification("textDocument/publishDiagnostics", {
        uri,
        diagnostics: grouped.get(uri) ?? [],
      });
      for (const [targetUri, diagnostics] of grouped) {
        if (targetUri !== uri) {
          this.sendNotification("textDocument/publishDiagnostics", {
            uri: targetUri,
            diagnostics,
          });
        }
      }
      return;
    }
    this.sendNotification("textDocument/publishDiagnostics", {
      uri,
      diagnostics: [],
    });
  }

  private async dispatch(message: JsonRpcMessage): Promise<void> {
    const id = message.id;
    const method = typeof message.method === "string" ? message.method : "";
    const params = (message.params ?? {}) as Json;
    try {
      const result = await this.handle(method, params);
      if (id !== undefined) {
        this.sendResponse(id, result ?? null);
      }
    } catch (error) {
      if (id !== undefined) {
        this.sendError(id, -32603, error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async handle(method: string, params: Json): Promise<unknown> {
    switch (method) {
      case "initialize": {
        this.rootPath =
          params.rootPath ??
          (typeof params.rootUri === "string" ? uriToPath(params.rootUri) : undefined);
        return {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1 },
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            renameProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            completionProvider: {
              resolveProvider: false,
              triggerCharacters: [":", "."],
            },
            documentFormattingProvider: true,
            codeActionProvider: true,
          },
          serverInfo: { name: "coplc", version: "0.1.0" },
        };
      }
      case "initialized":
        return null;
      case "shutdown":
        this.shutdownRequested = true;
        return null;
      case "exit":
        process.exit(this.shutdownRequested ? 0 : 1);
        return null;
      case "textDocument/didOpen": {
        const doc = params.textDocument;
        const uri = String(doc.uri);
        this.documents.set(uri, {
          uri,
          path: uriToPath(uri),
          text: String(doc.text ?? ""),
          version: Number(doc.version ?? 0),
        });
        this.publishDiagnostics(uri);
        return null;
      }
      case "textDocument/didChange": {
        const uri = String(params.textDocument.uri);
        const changes = params.contentChanges as Json[] | undefined;
        const text = changes && changes.length > 0 ? String(changes.at(-1)!.text ?? "") : "";
        const document = this.documents.get(uri);
        if (document) {
          document.text = text;
          document.version = Number(params.textDocument.version ?? document.version);
          this.publishDiagnostics(uri);
        }
        return null;
      }
      case "textDocument/didSave": {
        const uri = String(params.textDocument.uri);
        this.publishDiagnostics(uri);
        return null;
      }
      case "textDocument/didClose": {
        const uri = String(params.textDocument.uri);
        this.documents.delete(uri);
        this.sendNotification("textDocument/publishDiagnostics", {
          uri,
          diagnostics: [],
        });
        return null;
      }
      case "textDocument/documentSymbol":
        try {
          return this.documentSymbols(String(params.textDocument.uri));
        } catch {
          return [];
        }
      case "textDocument/hover":
        return this.hover(String(params.textDocument.uri), params.position);
      case "textDocument/definition":
        return this.definition(String(params.textDocument.uri), params.position);
      case "textDocument/references":
        return this.references(String(params.textDocument.uri), params.position);
      case "textDocument/rename":
        return this.rename(
          String(params.textDocument.uri),
          params.position,
          String(params.newName ?? ""),
        );
      case "textDocument/completion":
        return this.completion(String(params.textDocument.uri), params.position);
      case "textDocument/formatting":
        return this.formatting(String(params.textDocument.uri));
      case "textDocument/codeAction":
        return [];
      case "workspace/symbol":
        return this.workspaceSymbols(String(params.query ?? ""));
      default:
        return null;
    }
  }

  private sendResponse(id: unknown, result: unknown): void {
    writeJsonRpc({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: unknown, code: number, message: string): void {
    writeJsonRpc({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private sendNotification(method: string, params: unknown): void {
    writeJsonRpc({ jsonrpc: "2.0", method, params });
  }

  private documentText(uri: string): string {
    return this.documents.get(uri)?.text ?? this.textFor(uriToPath(uri));
  }

  private documentSymbols(uri: string): Json[] {
    const text = this.documentText(uri);
    const path = uriToPath(uri);
    const unit = parseSourceUnit(sourceFile(path, text));
    const symbols: Json[] = [];
    const convert = (member: ast.TypeDecl | ast.ClassMember, kind: number, name: string, span: Span, children: Json[] = []) => ({
      name,
      kind,
      range: rangeFromSpan(span),
      selectionRange: rangeFromSpan(span),
      children,
    });
    for (const namespace of unit.namespaces) {
      const namespaceChildren: Json[] = [];
      for (const member of namespace.members) {
        if (member.kind === "ClassDecl") {
          const children: Json[] = [];
          for (const child of member.members) {
            if (child.kind === "AttributeDecl") {
              children.push(convert(child, 8, child.name, child.span));
            } else if (child.kind === "MethodDecl") {
              children.push(convert(child, 6, child.name, child.span));
            } else {
              children.push(convert(child, 9, child.name, child.span));
            }
          }
          namespaceChildren.push(convert(member, 5, member.name, member.span, children));
        } else if (member.kind === "InterfaceDecl") {
          const children = member.methods.map((method) =>
            convert(method, 6, method.name, method.span),
          );
          namespaceChildren.push(convert(member, 11, member.name, member.span, children));
        } else {
          const children = member.members.map((enumMember) => ({
            name: enumMember.name,
            kind: 22,
            range: rangeFromSpan(enumMember.span),
            selectionRange: rangeFromSpan(enumMember.span),
          }));
          namespaceChildren.push(convert(member, 10, member.name, member.span, children));
        }
      }
      if (namespace.name.length === 0) {
        symbols.push(...namespaceChildren);
      } else {
        symbols.push(
          convert(
            namespace.members[0] ?? (unit as unknown as ast.TypeDecl),
            3,
            namespace.name.join("::"),
            namespace.span,
            namespaceChildren,
          ),
        );
      }
    }
    return symbols;
  }

  private findType(model: SemanticModel, word: string): TypeSymbol | undefined {
    return (
      model.symbols.get(word) ??
      [...model.symbols.values()].find(
        (symbol) =>
          symbol.name === word ||
          symbol.qualifiedName.endsWith(`::${word}`),
      )
    );
  }

  private hover(uri: string, position: Json): Json | null {
    const text = this.documentText(uri);
    const selected = wordAt(text, Number(position.line ?? 0), Number(position.character ?? 0));
    if (!selected) {
      return null;
    }
    const analysis = this.analyze(uri);
    if (!analysis.ok) {
      return null;
    }
    const type = this.findType(analysis.model, selected.word);
    let value: string | undefined;
    if (type) {
      value = `**${type.kind} ${type.qualifiedName}**`;
    } else {
      for (const symbol of analysis.model.symbols.values()) {
        for (const overloads of symbol.methods.values()) {
          for (const method of overloads) {
            if (method.name === selected.word) {
              value = `**method ${symbol.qualifiedName}.${method.name}**\n\nreturns \`${displayType(method.returnType)}\``;
            }
          }
        }
        for (const field of symbol.fields.values()) {
          if (field.name === selected.word) {
            value = `**attribute ${symbol.qualifiedName}.${field.name}**\n\n\`${displayType(field.type)}\``;
          }
        }
      }
    }
    if (!value) {
      return null;
    }
    return {
      contents: { kind: "markdown", value },
      range: {
        start: positionAt(text, selected.start),
        end: positionAt(text, selected.end),
      },
    };
  }

  private definition(uri: string, position: Json): Json[] | null {
    const text = this.documentText(uri);
    const selected = wordAt(text, Number(position.line ?? 0), Number(position.character ?? 0));
    if (!selected) {
      return null;
    }
    const analysis = this.analyze(uri);
    if (!analysis.ok) {
      return null;
    }
    const type = this.findType(analysis.model, selected.word);
    if (type) {
      return [{
        uri: pathToUri(type.file),
        range: rangeFromSpan(type.decl.span),
      }];
    }
    for (const symbol of analysis.model.symbols.values()) {
      for (const overloads of symbol.methods.values()) {
        for (const method of overloads) {
          if (method.name === selected.word) {
            return [{
              uri: pathToUri(symbol.file),
              range: rangeFromSpan(method.decl.span),
            }];
          }
        }
      }
      for (const field of symbol.fields.values()) {
        if (field.name === selected.word) {
          return [{
            uri: pathToUri(symbol.file),
            range: rangeFromSpan(field.decl.span),
          }];
        }
      }
    }
    return null;
  }

  private occurrences(uri: string, position: Json): { word: string; locations: Json[]; texts: Map<string, string> } | null {
    const text = this.documentText(uri);
    const selected = wordAt(text, Number(position.line ?? 0), Number(position.character ?? 0));
    if (!selected) {
      return null;
    }
    const analysis = this.analyze(uri);
    const texts = analysis.ok
      ? analysis.texts
      : new Map([[uriToPath(uri), text]]);
    if (!texts.has(uriToPath(uri))) {
      texts.set(uriToPath(uri), text);
    }
    const escaped = selected.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "g");
    const locations: Json[] = [];
    for (const [path, source] of texts) {
      for (const match of source.matchAll(pattern)) {
        const start = match.index ?? 0;
        locations.push({
          uri: pathToUri(path),
          range: {
            start: positionAt(source, start),
            end: positionAt(source, start + selected.word.length),
          },
        });
      }
    }
    return { word: selected.word, locations, texts };
  }

  private references(uri: string, position: Json): Json[] | null {
    return this.occurrences(uri, position)?.locations ?? null;
  }

  private rename(uri: string, position: Json, newName: string): Json | null {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
      return null;
    }
    const result = this.occurrences(uri, position);
    if (!result) {
      return null;
    }
    const changes: Record<string, Json[]> = {};
    for (const location of result.locations) {
      const target = String(location.uri);
      const edits = changes[target] ?? [];
      edits.push({ range: location.range, newText: newName });
      changes[target] = edits;
    }
    return { changes };
  }

  private completion(uri: string, position: Json): Json {
    const analysis = this.analyze(uri);
    const items: Json[] = [];
    for (const keyword of KEYWORDS) {
      items.push({
        label: keyword,
        kind: 14,
        detail: "keyword",
        sortText: `9_${keyword}`,
      });
    }
    for (const builtin of BUILTINS) {
      items.push({
        label: builtin,
        kind: 3,
        detail: "builtin",
        sortText: `8_${builtin}`,
      });
    }
    if (analysis.ok) {
      for (const symbol of analysis.model.symbols.values()) {
        items.push({
          label: symbol.name,
          kind: symbol.kind === "class" ? 7 : symbol.kind === "interface" ? 8 : 13,
          detail: symbol.kind === "class"
            ? `class ${symbol.qualifiedName}`
            : symbol.kind === "interface"
              ? `interface ${symbol.qualifiedName}`
              : `enum ${symbol.qualifiedName}`,
          sortText: `0_${symbol.qualifiedName}`,
        });
        for (const enumMember of symbol.enumMembers.values()) {
          items.push({
            label: enumMember.name,
            kind: 20,
            detail: `enum member ${symbol.qualifiedName}.${enumMember.name}`,
            sortText: `3_${symbol.qualifiedName}_${enumMember.name}`,
          });
        }
        for (const constructor of symbol.constructors) {
          if (constructor.isImplicit) {
            continue;
          }
          items.push({
            label: `${symbol.name}()`,
            kind: 4,
            detail: `constructor ${symbol.qualifiedName}`,
            sortText: `1_${symbol.qualifiedName}`,
          });
        }
        for (const overloads of symbol.methods.values()) {
          for (const method of overloads) {
            const params = method.params
              .map((param) => displayType(param.type))
              .join(", ");
            items.push({
              label: method.name,
              kind: 2,
              detail: `${method.owner.qualifiedName}.${method.name}(${params}) -> ${displayType(method.returnType)}`,
              sortText: `2_${symbol.qualifiedName}_${method.name}`,
            });
          }
        }
        for (const field of symbol.fields.values()) {
          items.push({
            label: field.name,
            kind: 5,
            detail: `${symbol.qualifiedName}.${field.name}: ${displayType(field.type)}`,
            sortText: `3_${symbol.qualifiedName}_${field.name}`,
          });
        }
      }
    }
    return { isIncomplete: false, items };
  }

  private formatting(uri: string): Json[] {
    const text = this.documentText(uri);
    const formatted = formatCopl(uriToPath(uri), text);
    if (formatted === text) {
      return [];
    }
    return [{
      range: {
        start: { line: 0, character: 0 },
        end: positionAt(text, text.length),
      },
      newText: formatted,
    }];
  }

  private workspaceSymbols(query: string): Json[] {
    if (this.documents.size === 0) {
      return [];
    }
    const first = this.documents.values().next().value as OpenDocument | undefined;
    if (!first) {
      return [];
    }
    const analysis = this.analyze(first.uri);
    if (!analysis.ok) {
      return [];
    }
    const lowered = query.toLowerCase();
    return [...analysis.model.symbols.values()]
      .filter((symbol) => symbol.qualifiedName.toLowerCase().includes(lowered))
      .map((symbol) => ({
        name: symbol.qualifiedName,
        kind: symbol.kind === "class" ? 5 : symbol.kind === "interface" ? 11 : 10,
        location: {
          uri: pathToUri(symbol.file),
          range: rangeFromSpan(symbol.decl.span),
        },
      }));
  }
}
