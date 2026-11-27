export type JsonRpcMessage = Record<string, unknown>;

export async function readJsonRpc(
  onMessage: (message: JsonRpcMessage) => void,
): Promise<void> {
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk as Uint8Array)]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        break;
      }
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const messageEnd = headerEnd + 4 + length;
      if (buffer.length < messageEnd) {
        break;
      }
      const body = buffer.subarray(headerEnd + 4, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);
      onMessage(JSON.parse(body) as JsonRpcMessage);
    }
  }
}

export function writeJsonRpc(message: JsonRpcMessage): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
