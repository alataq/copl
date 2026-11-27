import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = join(import.meta.dir, "..");

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"),
    body,
  ]);
}

describe("LSP server", () => {
  test("initializes, opens a document, and serves symbols/hover", async () => {
    const root = mkdtempSync(join(tmpdir(), "copl-lsp-"));
    const path = join(root, "test.copl");
    const text = "public class A {\n    public A() { }\n}\n";
    writeFileSync(path, text);
    const uri = pathToFileURL(path).href;
    const child = spawn("bun", ["run", "src/cli.ts", "lsp"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "inherit"],
    });
    let buffer = Buffer.alloc(0);
    const waiters = new Map<number, (message: any) => void>();
    child.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.from(chunk as Uint8Array)]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) {
          break;
        }
        const header = buffer.subarray(0, headerEnd).toString("utf8");
        const match = /Content-Length:\s*(\d+)/i.exec(header);
        if (!match) {
          break;
        }
        const length = Number(match[1]);
        const messageEnd = headerEnd + 4 + length;
        if (buffer.length < messageEnd) {
          break;
        }
        const message = JSON.parse(
          buffer.subarray(headerEnd + 4, messageEnd).toString("utf8"),
        );
        buffer = buffer.subarray(messageEnd);
        if (message.id !== undefined) {
          waiters.get(message.id)?.(message);
          waiters.delete(message.id);
        }
      }
    });
    const send = (message: unknown): void => {
      child.stdin.write(frame(message));
    };
    const request = (id: number, method: string, params: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        waiters.set(id, resolve);
        send({ jsonrpc: "2.0", id, method, params });
        setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 3000);
      });
    try {
      const init = await request(1, "initialize", {
        rootUri: pathToFileURL(root).href,
      });
      expect(init.result.capabilities.documentSymbolProvider).toBe(true);

      send({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "copl",
            version: 1,
            text,
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      const symbols = await request(2, "textDocument/documentSymbol", {
        textDocument: { uri },
      });
      expect(symbols.result.map((symbol: any) => symbol.name)).toEqual(["A"]);

      const hover = await request(3, "textDocument/hover", {
        textDocument: { uri },
        position: { line: 0, character: 14 },
      });
      expect(hover.result.contents.value).toContain("class A");

      const completion = await request(4, "textDocument/completion", {
        textDocument: { uri },
        position: { line: 0, character: 14 },
      });
      const classItem = completion.result.items.find(
        (item: any) => item.label === "A" && item.kind === 7,
      );
      expect(classItem.detail).toContain("class A");
      expect(
        completion.result.items.some(
          (item: any) => item.kind === 4 && String(item.label).startsWith("A"),
        ),
      ).toBe(true);

      await request(5, "shutdown", null);
      send({ jsonrpc: "2.0", method: "exit", params: {} });
    } finally {
      child.kill();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
