import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const extensionsDir = path.join(rootDir, "extensions");
const packageScope = "@pdobranov";
const sourceExtensions = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const ignoredDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".cache",
  ".tmp",
  "tmp",
]);

type JsonObject = Record<string, unknown>;

const errors: string[] = [];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): void {
  errors.push(message);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(
  filePath: string,
): Promise<JsonObject | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;

    if (!isObject(parsed)) {
      fail(`${path.relative(rootDir, filePath)} must contain a JSON object`);

      return undefined;
    }

    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`cannot read ${path.relative(rootDir, filePath)}: ${message}`);

    return undefined;
  }
}

async function getExtensionFolders(): Promise<string[]> {
  if (!(await exists(extensionsDir))) {
    return [];
  }

  const entries = await readdir(extensionsDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function dependencyMap(
  packageJson: JsonObject,
  field: "dependencies" | "peerDependencies" | "optionalDependencies",
): JsonObject {
  const value = packageJson[field];

  return isObject(value) ? value : {};
}

function validateWorkspaceDependencies(packageJson: JsonObject): void {
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const dependencies = dependencyMap(packageJson, field);

    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version === "string" && version.startsWith("workspace:")) {
        fail(
          `${field}.${name} uses forbidden workspace: runtime dependency range`,
        );
      }
    }
  }
}

function validateSiblingPackageDependencies(
  packageJson: JsonObject,
  ownName: string,
  siblingPackageNames: Set<string>,
): void {
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const dependencies = dependencyMap(packageJson, field);

    for (const name of Object.keys(dependencies)) {
      if (name !== ownName && siblingPackageNames.has(name)) {
        fail(`${field}.${name} depends on sibling extension package`);
      }
    }
  }
}

async function walkSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await walkSourceFiles(fullPath)));
      }

      continue;
    }

    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function importedSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const importExportPattern =
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/gu;
  const dynamicImportPattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  const requirePattern = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu;

  for (const pattern of [
    importExportPattern,
    dynamicImportPattern,
    requirePattern,
  ]) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];

      if (specifier !== undefined) {
        specifiers.add(specifier);
      }
    }
  }

  return [...specifiers].sort();
}

function packageNameFromSpecifier(specifier: string): string | undefined {
  if (
    specifier.startsWith("node:") ||
    specifier.startsWith(".") ||
    specifier.startsWith("/")
  ) {
    return undefined;
  }

  const parts = specifier.split("/");
  const firstPart = parts[0];

  if (firstPart === undefined || firstPart === "") {
    return undefined;
  }

  if (firstPart.startsWith("@")) {
    const secondPart = parts[1];

    return secondPart === undefined ? firstPart : `${firstPart}/${secondPart}`;
  }

  return firstPart;
}

function isRelativeSiblingImport(specifier: string): boolean {
  return /^\.\.\/(?:\.\.\/)*pi-[^/]*(?:\/.*)?$/u.test(specifier);
}

async function validateSourceImports(
  extensionDir: string,
  packageJson: JsonObject,
  siblingPackageNames: Set<string>,
): Promise<void> {
  const declaredRuntimeDependencies = new Set([
    ...Object.keys(dependencyMap(packageJson, "dependencies")),
    ...Object.keys(dependencyMap(packageJson, "peerDependencies")),
    ...Object.keys(dependencyMap(packageJson, "optionalDependencies")),
  ]);

  const sourceFiles = await walkSourceFiles(extensionDir);

  for (const sourceFile of sourceFiles) {
    const relativeFile = path.relative(rootDir, sourceFile);
    const content = await readFile(sourceFile, "utf8");

    for (const specifier of importedSpecifiers(content)) {
      if (isRelativeSiblingImport(specifier)) {
        fail(
          `${relativeFile} imports sibling extension runtime code: ${specifier}`,
        );
      }

      const importedPackageName = packageNameFromSpecifier(specifier);

      if (importedPackageName === undefined) {
        continue;
      }

      if (siblingPackageNames.has(importedPackageName)) {
        fail(`${relativeFile} imports sibling extension package: ${specifier}`);
      }

      if (!declaredRuntimeDependencies.has(importedPackageName)) {
        fail(
          `${relativeFile} imports undeclared runtime package: ${importedPackageName}`,
        );
      }
    }
  }
}

async function validateEntrypoints(
  extensionDir: string,
  packageJson: JsonObject,
): Promise<void> {
  const pi = packageJson.pi;
  const piExtensions = isObject(pi) ? pi.extensions : undefined;

  if (!Array.isArray(piExtensions) || piExtensions.length === 0) {
    fail("package must define non-empty pi.extensions");

    return;
  }

  for (const entrypoint of piExtensions) {
    if (typeof entrypoint !== "string" || entrypoint.trim() === "") {
      fail("every pi.extensions entry must be a non-empty string");
      continue;
    }

    const entrypointPath = path.resolve(extensionDir, entrypoint);

    if (
      !entrypointPath.startsWith(`${extensionDir}${path.sep}`) &&
      entrypointPath !== extensionDir
    ) {
      fail(`pi.extensions entry escapes package directory: ${entrypoint}`);
      continue;
    }

    if (!(await exists(entrypointPath))) {
      fail(`missing Pi entrypoint: ${entrypoint}`);
      continue;
    }

    const entrypointStat = await stat(entrypointPath);

    if (!entrypointStat.isFile()) {
      fail(`Pi entrypoint is not a file: ${entrypoint}`);
    }
  }
}

async function resolveExtensionFolder(
  input: string,
  folders: string[],
): Promise<string | undefined> {
  if (folders.includes(input)) {
    return input;
  }

  const unscopedName = input.startsWith(`${packageScope}/`)
    ? input.slice(packageScope.length + 1)
    : input;

  if (folders.includes(unscopedName)) {
    return unscopedName;
  }

  return undefined;
}

const target = process.argv[2];

if (target === undefined || target.trim() === "") {
  console.error(
    "Usage: pnpm check:isolated <extension-folder-or-package-name>",
  );
  process.exit(1);
}

const folders = await getExtensionFolders();
const folder = await resolveExtensionFolder(target, folders);

if (folder === undefined) {
  console.error(
    `Unknown extension ${target}. Available extensions: ${folders.length > 0 ? folders.join(", ") : "none"}.`,
  );
  process.exit(1);
}

const extensionDir = path.join(extensionsDir, folder);
const packageJsonPath = path.join(extensionDir, "package.json");

for (const requiredFile of ["package.json", "README.md", "tsconfig.json"]) {
  if (!(await exists(path.join(extensionDir, requiredFile)))) {
    fail(`missing ${requiredFile}`);
  }
}

const packageJson = await readJsonObject(packageJsonPath);

if (packageJson !== undefined) {
  const expectedName = `${packageScope}/${folder}`;

  if (packageJson.name !== expectedName) {
    fail(`expected package name ${expectedName}`);
  }

  validateWorkspaceDependencies(packageJson);

  const siblingPackageNames = new Set(
    folders
      .filter((name) => name !== folder)
      .map((name) => `${packageScope}/${name}`),
  );
  validateSiblingPackageDependencies(
    packageJson,
    expectedName,
    siblingPackageNames,
  );
  await validateEntrypoints(extensionDir, packageJson);
  await validateSourceImports(extensionDir, packageJson, siblingPackageNames);
}

if (errors.length > 0) {
  console.error(`Isolation checks failed for ${target}:`);

  for (const error of errors) {
    console.error(`- ${error}`);
  }

  process.exit(1);
}

console.log(`Isolation checks passed for ${folder}.`);
