import { createHash } from "node:crypto";
import { Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { PYTHON_SERVICE_CONTAINER_ASSETS } from "./container-assets";

const INCLUDED_SERVICE_PATHS = ["pyproject.toml", "src"];
const IGNORED_DIRECTORY_NAMES = new Set([".git", "__pycache__", ".pytest_cache", ".mypy_cache", "feedback", "logs", "prompts"]);
const IGNORED_FILE_SUFFIXES = [".pyc", ".pyo", ".DS_Store"];

export function buildDogfoodRuntimeSourceHash(workspaceRoot: string, runtimeDockerContext: string): string {
  const hash = createHash("sha256");
  const entries = [
    ...collectFiles(runtimeDockerContext, runtimeDockerContext).map((entry) => scopedEntry("runtime", entry)),
    ...PYTHON_SERVICE_CONTAINER_ASSETS.flatMap((asset) => {
      const serviceRoot = path.join(workspaceRoot, asset.sourceDirectory);
      return INCLUDED_SERVICE_PATHS.flatMap((includedPath) => {
        const absolutePath = path.join(serviceRoot, includedPath);
        return collectFiles(absolutePath, serviceRoot).map((entry) => scopedEntry(asset.service, entry));
      });
    })
  ].sort((left, right) => left.label.localeCompare(right.label));

  for (const entry of entries) {
    hash.update(entry.label);
    hash.update("\0");
    hash.update(readFileSync(entry.absolutePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

interface SourceEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
}

interface ScopedSourceEntry {
  readonly label: string;
  readonly absolutePath: string;
}

function collectFiles(absolutePath: string, relativeRoot: string): SourceEntry[] {
  if (!existsSync(absolutePath)) {
    return [];
  }
  const stats = statSync(absolutePath);
  if (stats.isFile()) {
    return shouldIncludeFile(absolutePath) ? [{ relativePath: path.relative(relativeRoot, absolutePath), absolutePath }] : [];
  }
  if (!stats.isDirectory() || shouldIgnoreDirectory(path.basename(absolutePath))) {
    return [];
  }

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => collectDirectoryEntry(absolutePath, relativeRoot, entry));
}

function collectDirectoryEntry(parentPath: string, relativeRoot: string, entry: Dirent): SourceEntry[] {
  if (entry.isDirectory() && shouldIgnoreDirectory(entry.name)) {
    return [];
  }
  return collectFiles(path.join(parentPath, entry.name), relativeRoot);
}

function scopedEntry(scope: string, entry: SourceEntry): ScopedSourceEntry {
  return {
    label: `${scope}/${entry.relativePath.split(path.sep).join("/")}`,
    absolutePath: entry.absolutePath
  };
}

function shouldIgnoreDirectory(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name);
}

function shouldIncludeFile(filePath: string): boolean {
  return !IGNORED_FILE_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}
