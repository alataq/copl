import { describe, expect, test } from "bun:test";
import { formatCopl } from "../src/lsp/format";

describe("formatter", () => {
  test("reindents nested blocks", () => {
    const input = [
      "public class A {",
      "public A() {",
      "int x = 1;",
      "}",
      "}",
      "",
    ].join("\n");
    expect(formatCopl("test.copl", input)).toBe([
      "public class A {",
      "    public A() {",
      "        int x = 1;",
      "    }",
      "}",
      "",
    ].join("\n"));
  });

  test("ignores braces inside strings and comments", () => {
    const input = [
      "public class A {",
      "    public void f() {",
      "        char[] text = \"}\";",
      "        // }",
      "    }",
      "}",
      "",
    ].join("\n");
    const formatted = formatCopl("test.copl", input);
    expect(formatted).toContain("        char[] text = \"}\";");
    expect(formatted).toContain("        // }");
  });
});
