import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

function pushUnique(roots: string[], root: string): void {
  if (existsSync(join(root, "copl")) && !roots.includes(root)) {
    roots.push(root);
  }
}

export function defaultModuleRoots(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const roots: string[] = [];
  if (env.COPL_HOME) {
    pushUnique(roots, join(resolve(env.COPL_HOME), "modules"));
  }
  if (env.COPL_PATH) {
    for (const root of env.COPL_PATH.split(delimiter)) {
      if (root.length > 0) {
        pushUnique(roots, resolve(root));
      }
    }
  }

  const execDir = dirname(process.execPath);
  pushUnique(roots, resolve(execDir, "..", "share", "copl", "modules"));
  pushUnique(roots, resolve(execDir, "share", "copl", "modules"));

  if (basename(process.execPath).startsWith("bun")) {
    pushUnique(roots, resolve(import.meta.dir, "..", "modules"));
  }
  return roots;
}
