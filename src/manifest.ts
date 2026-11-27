import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CoplError } from "./diagnostics";

export interface ManifestEntry {
  readonly name: string;
  readonly path: string;
  readonly absolutePath: string;
}

export interface LoadedManifest {
  readonly root: string;
  readonly manifestPath: string;
  readonly name?: string;
  readonly version?: string;
  readonly defaultEntry: string;
  readonly entryEnvVar?: string;
  readonly entries: ReadonlyMap<string, ManifestEntry>;
  readonly defaultWorkers: number;
  readonly workersEnvVar?: string;
  readonly linkerFlags: readonly string[];
  readonly cc?: string;
}

export type Environment = Readonly<Record<string, string | undefined>>;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifestError(manifestPath: string, message: string): CoplError {
  return new CoplError(`${manifestPath}: ${message}`, undefined, "manifest");
}

function requireString(
  manifestPath: string,
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw manifestError(manifestPath, `'${field}' must be a non-empty string`);
  }
  return value;
}

function optionalEnvName(
  manifestPath: string,
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const name = requireString(manifestPath, value, field);
  if (!ENV_NAME.test(name)) {
    throw manifestError(manifestPath, `'${field}' must be a valid environment variable name`);
  }
  return name;
}

function optionalStringArray(
  manifestPath: string,
  value: unknown,
  field: string,
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw manifestError(manifestPath, `'${field}' must be an array of strings`);
  }
  return value as string[];
}

export function loadManifest(rootDir: string): LoadedManifest {
  const root = resolve(rootDir);
  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw manifestError(manifestPath, "manifest.json not found");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw manifestError(manifestPath, `invalid JSON: ${detail}`);
  }

  if (!isPlainObject(parsed)) {
    throw manifestError(manifestPath, "manifest root must be a JSON object");
  }

  const name =
    parsed.name === undefined
      ? undefined
      : requireString(manifestPath, parsed.name, "name");
  const version =
    parsed.version === undefined
      ? undefined
      : requireString(manifestPath, parsed.version, "version");
  const defaultEntry = requireString(
    manifestPath,
    parsed.defaultEntry,
    "defaultEntry",
  );
  const entryEnvVar = optionalEnvName(
    manifestPath,
    parsed.entryEnvVar,
    "entryEnvVar",
  );
  const workersEnvVar = optionalEnvName(
    manifestPath,
    parsed.workersEnvVar,
    "workersEnvVar",
  );

  if (!isPlainObject(parsed.entries)) {
    throw manifestError(manifestPath, "'entries' must be an object of name to path");
  }
  const rawEntries = parsed.entries;
  const entryNames = Object.keys(rawEntries);
  if (entryNames.length === 0) {
    throw manifestError(manifestPath, "'entries' must contain at least one entry");
  }

  const entries = new Map<string, ManifestEntry>();
  for (const entryName of entryNames) {
    if (entryName.length === 0) {
      throw manifestError(manifestPath, "entry names must be non-empty");
    }
    const entryPath = requireString(
      manifestPath,
      rawEntries[entryName],
      `entries.${entryName}`,
    );
    const absolutePath = isAbsolute(entryPath)
      ? resolve(entryPath)
      : resolve(root, entryPath);
    if (!existsSync(absolutePath)) {
      throw manifestError(
        manifestPath,
        `entry '${entryName}' points to missing file '${entryPath}'`,
      );
    }
    entries.set(entryName, {
      name: entryName,
      path: entryPath,
      absolutePath,
    });
  }

  if (!entries.has(defaultEntry)) {
    throw manifestError(
      manifestPath,
      `'defaultEntry' refers to unknown entry '${defaultEntry}' (known: ${entryNames.join(", ")})`,
    );
  }

  let defaultWorkers = 1;
  if (parsed.defaultWorkers !== undefined) {
    if (
      typeof parsed.defaultWorkers !== "number" ||
      !Number.isSafeInteger(parsed.defaultWorkers) ||
      parsed.defaultWorkers < 1
    ) {
      throw manifestError(
        manifestPath,
        "'defaultWorkers' must be a positive integer",
      );
    }
    defaultWorkers = parsed.defaultWorkers;
  }

  const linkerFlags = optionalStringArray(
    manifestPath,
    parsed.linkerFlags,
    "linkerFlags",
  );
  const cc =
    parsed.cc === undefined
      ? undefined
      : requireString(manifestPath, parsed.cc, "cc");

  return {
    root,
    manifestPath,
    name,
    version,
    defaultEntry,
    entryEnvVar,
    entries,
    defaultWorkers,
    workersEnvVar,
    linkerFlags,
    cc,
  };
}

export function resolveEntryName(
  manifest: LoadedManifest,
  env: Environment = process.env,
): string {
  if (manifest.entryEnvVar) {
    const selected = env[manifest.entryEnvVar];
    if (selected !== undefined && selected.length > 0) {
      if (!manifest.entries.has(selected)) {
        const known = [...manifest.entries.keys()].join(", ");
        throw new CoplError(
          `unknown entry '${selected}' selected by ${manifest.entryEnvVar}; valid entries: ${known}`,
          undefined,
          "entry",
        );
      }
      return selected;
    }
  }
  return manifest.defaultEntry;
}

export function resolveEntry(
  manifest: LoadedManifest,
  env: Environment = process.env,
): ManifestEntry {
  const name = resolveEntryName(manifest, env);
  const entry = manifest.entries.get(name);
  if (!entry) {
    throw new CoplError(`unknown entry '${name}'`, undefined, "entry");
  }
  return entry;
}

export function resolveWorkerCount(
  manifest: LoadedManifest,
  env: Environment = process.env,
): number {
  if (manifest.workersEnvVar) {
    const raw = env[manifest.workersEnvVar];
    if (raw !== undefined && raw.trim().length > 0) {
      const value = Number(raw);
      if (Number.isSafeInteger(value) && value >= 1) {
        return value;
      }
    }
  }
  return manifest.defaultWorkers;
}
