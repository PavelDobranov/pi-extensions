import { access, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const extensionsDir = path.join(rootDir, "extensions");
const packageScope = "@pdobranov";

type JsonObject = Record<string, unknown>;

const errors: string[] = [];

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(packageName: string, message: string): void {
  errors.push(`${packageName}: ${message}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);

    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, "utf8");

  return JSON.parse(text) as unknown;
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

function validatePackageJson(
  folderName: string,
  packageJson: JsonObject,
): void {
  const displayName = `extensions/${folderName}`;
  const expectedName = `${packageScope}/${folderName}`;

  if (packageJson.name !== expectedName) {
    fail(displayName, `expected package name ${expectedName}`);
  }

  if (packageJson.version !== "0.0.0" && packageJson.private !== false) {
    fail(displayName, 'expected version "0.0.0" before publication');
  }

  if (typeof packageJson.private !== "boolean") {
    fail(displayName, "expected explicit boolean private field");
  }

  if (
    typeof packageJson.description !== "string" ||
    packageJson.description.trim() === ""
  ) {
    fail(displayName, "expected non-empty description");
  }

  if (
    !Array.isArray(packageJson.keywords) ||
    !packageJson.keywords.includes("pi-package")
  ) {
    fail(displayName, 'expected keywords to include "pi-package"');
  }

  const scripts = packageJson.scripts;

  if (
    !isObject(scripts) ||
    typeof scripts.typecheck !== "string" ||
    scripts.typecheck.trim() === ""
  ) {
    fail(displayName, "expected scripts.typecheck");
  }

  const pi = packageJson.pi;
  const extensions = isObject(pi) ? pi.extensions : undefined;

  if (!Array.isArray(extensions) || extensions.length === 0) {
    fail(displayName, "expected non-empty pi.extensions array");
  } else {
    for (const extension of extensions) {
      if (typeof extension !== "string" || extension.trim() === "") {
        fail(
          displayName,
          "expected every pi.extensions entry to be a non-empty string",
        );
      }
    }
  }

  if (packageJson.private === false) {
    if (!Array.isArray(packageJson.files) || packageJson.files.length === 0) {
      fail(displayName, "public packages must define non-empty files");
    }

    const publishConfig = packageJson.publishConfig;

    if (!isObject(publishConfig) || publishConfig.access !== "public") {
      fail(
        displayName,
        'public packages must define publishConfig.access = "public"',
      );
    }

    if (
      !isObject(packageJson.repository) &&
      typeof packageJson.repository !== "string"
    ) {
      fail(displayName, "public packages must define repository metadata");
    }

    if (
      typeof packageJson.license !== "string" ||
      packageJson.license.trim() === ""
    ) {
      fail(displayName, "public packages must define license");
    }
  }
}

async function validateExtension(folderName: string): Promise<void> {
  const extensionDir = path.join(extensionsDir, folderName);
  const displayName = `extensions/${folderName}`;
  const packageJsonPath = path.join(extensionDir, "package.json");

  for (const requiredFile of ["package.json", "README.md", "tsconfig.json"]) {
    const filePath = path.join(extensionDir, requiredFile);

    if (!(await exists(filePath))) {
      fail(displayName, `missing ${requiredFile}`);
    }
  }

  if (!(await exists(packageJsonPath))) {
    return;
  }

  let packageJson: unknown;
  try {
    packageJson = await readJson(packageJsonPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(displayName, `invalid package.json: ${message}`);

    return;
  }

  if (!isObject(packageJson)) {
    fail(displayName, "package.json must contain a JSON object");

    return;
  }

  validatePackageJson(folderName, packageJson);

  const pi = packageJson.pi;
  const piExtensions =
    isObject(pi) && Array.isArray(pi.extensions) ? pi.extensions : [];

  for (const entrypoint of piExtensions) {
    if (typeof entrypoint !== "string" || entrypoint.trim() === "") {
      continue;
    }

    const entrypointPath = path.resolve(extensionDir, entrypoint);

    if (
      !entrypointPath.startsWith(`${extensionDir}${path.sep}`) &&
      entrypointPath !== extensionDir
    ) {
      fail(
        displayName,
        `pi.extensions entry escapes package directory: ${entrypoint}`,
      );
      continue;
    }

    if (!(await exists(entrypointPath))) {
      fail(displayName, `missing Pi entrypoint ${entrypoint}`);
      continue;
    }

    const entrypointStat = await stat(entrypointPath);

    if (!entrypointStat.isFile()) {
      fail(displayName, `Pi entrypoint is not a file: ${entrypoint}`);
    }
  }
}

const folders = await getExtensionFolders();

for (const folder of folders) {
  await validateExtension(folder);
}

if (errors.length > 0) {
  console.error("Package checks failed:");

  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Package checks passed (${folders.length} extension package${folders.length === 1 ? "" : "s"}).`,
);
