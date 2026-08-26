import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "coverage",
  "dist",
  "build",
  ".cache",
  ".tmp",
  "tmp",
  ".pi",
]);

const forbiddenFilePatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\/)\.env(?:\..*)?$/u, reason: "local environment file" },
  {
    pattern: /(^|\/)\.npmrc$/u,
    reason: "potentially credential-bearing npm config",
  },
  { pattern: /(^|\/)\.DS_Store$/u, reason: "machine-specific file" },
  {
    pattern: /(^|\/)(?:npm-debug|yarn-debug|yarn-error|pnpm-debug)\.log$/u,
    reason: "package manager log",
  },
  { pattern: /\.log$/u, reason: "log file" },
  { pattern: /(^|\/)pnpm-store\//u, reason: "package manager cache" },
];

const secretContentPatterns: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u,
    reason: "private key",
  },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/u, reason: "AWS access key id" },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{30,}\b/u,
    reason: "GitHub token",
  },
  { pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/u, reason: "API secret token" },
  {
    pattern:
      /\b(?:api[_-]?key|secret|token|password|credential)s?\b\s*[:=]\s*["'][^"'\n]{8,}["']/iu,
    reason: "credential-looking assignment",
  },
  {
    pattern: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?\b/iu,
    reason: "local machine URL",
  },
  {
    pattern: /\b\/home\/[A-Za-z0-9._-]+\//u,
    reason: "machine-specific absolute home path",
  },
];

const binaryExtensions = new Set([
  ".bmp",
  ".gif",
  ".ico",
  ".jpg",
  ".jpeg",
  ".lock",
  ".png",
  ".webp",
  ".woff",
  ".woff2",
]);

const findings: string[] = [];

function toRelative(filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    const relativePath = toRelative(fullPath);

    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await walk(fullPath)));
      }

      continue;
    }

    if (entry.isFile()) {
      files.push(relativePath);
    }
  }

  return files.sort();
}

function checkFileName(relativePath: string): void {
  for (const { pattern, reason } of forbiddenFilePatterns) {
    if (pattern.test(relativePath)) {
      findings.push(`${relativePath}: ${reason}`);
    }
  }
}

async function checkFileContent(relativePath: string): Promise<void> {
  if (binaryExtensions.has(path.extname(relativePath))) {
    return;
  }

  const fullPath = path.join(rootDir, relativePath);
  const fileStat = await stat(fullPath);

  if (fileStat.size > 1024 * 1024) {
    return;
  }

  const content = await readFile(fullPath, "utf8");

  for (const { pattern, reason } of secretContentPatterns) {
    if (pattern.test(content)) {
      findings.push(`${relativePath}: ${reason}`);
    }
  }
}

const files = await walk(rootDir);

for (const file of files) {
  checkFileName(file);
  await checkFileContent(file);
}

if (findings.length > 0) {
  console.error("Public repository checks found possible issues:");

  for (const finding of findings) {
    console.error(`- ${finding}`);
  }

  console.error(
    "Review these findings manually; this is a lightweight helper, not a full secret scanner.",
  );
  process.exit(1);
}

console.log(`Public repository checks passed (${files.length} files scanned).`);
