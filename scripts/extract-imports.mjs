#!/usr/bin/env node
// extract-imports — build a file-level import graph for a local repo.
//
// Pure local: no network, no API calls. Walks the filesystem, runs per-language
// regex extraction, resolves imports to in-repo file paths where possible,
// computes "imported_by" reverse edges + a "hubs" ranking (most-imported files).
//
// Consumed by dev-cache-pr-review-repo (precompute) → sidecar JSON →
// dev-pr-review (review-time context injection). See the IMPORT GRAPH
// integration in those skills' SKILL.md procedures.
//
// Usage:
//   node scripts/extract-imports.mjs --repo <abs-path> [--out <sidecar-path>]
//                                    [--files <comma-list>]
//
// When --out is omitted, JSON goes to stdout. --files filters the *output*
// to those files only (still computes the full graph internally so hubs +
// imported_by stay accurate for the touched-file subset).
//
// Languages supported in v1: Go, TypeScript/JavaScript, Python. Add more by
// extending LANGS below — each entry is one regex + one resolver.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// --------------------------------------------------------------------------
// CLI parsing — bare minimum, no deps.

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}

const repoArg = getArg('--repo');
if (!repoArg) {
  console.error('--repo <path> is required');
  process.exit(2);
}
const repoPath = resolve(repoArg);
if (!existsSync(repoPath)) {
  console.error(`repo path not found: ${repoPath}`);
  process.exit(2);
}
const outArg = getArg('--out');
const filesFilter = getArg('--files')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;

// --------------------------------------------------------------------------
// Walk — collect all files we care about. Skips common heavy + irrelevant
// directories. .gitignore is NOT parsed — keeps the script dependency-free.
// If a repo has unusual ignore needs, the cost is some extra files scanned
// (harmless — they just won't match any LANG extractor).

const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', '.next',
  '.venv', 'venv', '__pycache__', '.pytest_cache', 'target',
  '.cache', 'coverage', '.idea', '.vscode',
]);

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') {
      // Allow walking the root itself (rare with absolute path); skip
      // hidden subdirs by default. Exception: scripts may want `.claude/`,
      // but that's not source code for import-graph purposes.
      if (SKIP_DIRS.has(e.name)) continue;
      // Other dotfiles/dirs: skip
      continue;
    }
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Per-language extractors. Each LANG entry:
//   - extensions: file extensions handled by this lang
//   - extract(content, fileAbsPath, repoCtx) → string[] of raw import paths
//   - resolve(rawImport, fileAbsPath, repoCtx) → string | null (repo-relative path)
//     Resolvers return null for external (non-local) imports — those are
//     dropped from the final graph since we can't connect them to a node.
//   - isTest(fileRelPath) → boolean — files that should be tagged as test
//
// repoCtx is a small object holding repo-wide state (go module prefix,
// tsconfig paths, etc.) shared across all extractor calls.

const LANGS = {
  go: {
    extensions: ['.go'],
    extract(content) {
      const out = [];
      // Single-line:  import "path"
      // Block:        import ( ... )
      const blockRe = /^import\s*\(\s*([\s\S]*?)\s*\)/m;
      const block = content.match(blockRe);
      if (block) {
        for (const line of block[1].split('\n')) {
          // Each line: optional alias + "path" + optional // comment
          const m = line.match(/^\s*(?:[\w./]+\s+)?"([^"]+)"/);
          if (m) out.push(m[1]);
        }
      }
      const singleRe = /^import\s+(?:[\w./]+\s+)?"([^"]+)"/gm;
      let s;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
      while ((s = singleRe.exec(content))) out.push(s[1]);
      return out;
    },
    resolve(rawImport, _fileAbs, repoCtx) {
      const prefix = repoCtx.goModulePrefix;
      if (!prefix) return null;
      if (!rawImport.startsWith(prefix + '/') && rawImport !== prefix) return null;
      // Strip the module prefix to get the in-repo path. The remainder is
      // a *package* directory; expand to the concrete .go files at the end.
      const sub = rawImport === prefix ? '' : rawImport.slice(prefix.length + 1);
      // Return the directory path — the orchestrator later expands package
      // references to all .go files in that directory (minus _test.go).
      return `package:${sub}`;
    },
    isTest(rel) {
      return rel.endsWith('_test.go');
    },
  },

  tsjs: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    extract(content) {
      const out = [];
      // Match: import ... from "<path>"  AND  require("<path>")  AND  import("<path>")
      const importRe = /^import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
      const requireRe = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
      const dynImportRe = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
      let m;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
      while ((m = importRe.exec(content))) out.push(m[1]);
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
      while ((m = requireRe.exec(content))) out.push(m[1]);
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
      while ((m = dynImportRe.exec(content))) out.push(m[1]);
      return out;
    },
    resolve(rawImport, fileAbs, repoCtx) {
      // Only relative imports are repo-local in v1. External packages
      // ("react", "@anthropic-ai/sdk") and TypeScript path aliases are
      // dropped — adding tsconfig.json paths support is a v2 enhancement.
      if (!rawImport.startsWith('.')) return null;
      const baseDir = dirname(fileAbs);
      const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

      // TS/ESM-with-extension convention: TypeScript source uses `.js`
      // extensions in import paths (e.g. `./auth.js`) but the file on
      // disk is `.ts`. Strip a trailing JS-ish extension and try TS-ish
      // ones first; fall back to keeping the original extension for
      // genuine .js source.
      const stripped = rawImport.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
      const target = resolve(baseDir, stripped);

      // 1) Try every candidate extension against the stripped target.
      for (const e of exts) {
        const p = target + e;
        if (existsSync(p)) return relative(repoCtx.repoPath, p);
      }
      // 2) Try as a directory with /index.<ext>.
      if (existsSync(target)) {
        try {
          const st = statSync(target);
          if (st.isDirectory()) {
            for (const e of exts) {
              const p = join(target, `index${e}`);
              if (existsSync(p)) return relative(repoCtx.repoPath, p);
            }
          } else if (st.isFile()) {
            return relative(repoCtx.repoPath, target);
          }
        } catch {
          /* ignore */
        }
      }
      // 3) Last resort — if the original path has its own extension and
      // exists, return it (covers `import './styles.css'` etc.).
      const literal = resolve(baseDir, rawImport);
      if (existsSync(literal)) return relative(repoCtx.repoPath, literal);
      return null;
    },
    isTest(rel) {
      return /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(rel) || /\/__tests__\//.test(rel);
    },
  },

  py: {
    extensions: ['.py'],
    extract(content) {
      const out = [];
      // import foo.bar       OR   import foo, bar
      // from foo.bar import baz
      const importRe = /^import\s+([\w.,\s]+?)(?:\s+as\s+\w+)?$/gm;
      const fromRe = /^from\s+([\w.]+)\s+import\s+/gm;
      let m;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
      while ((m = importRe.exec(content))) {
        for (const item of m[1].split(',').map((s) => s.trim())) out.push(item);
      }
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iter
      while ((m = fromRe.exec(content))) out.push(m[1]);
      return out;
    },
    resolve(rawImport, _fileAbs, repoCtx) {
      // Skip relative imports like ".foo" — v1 limitation; uncommon in
      // top-level scripts which is where the OS uses Python today.
      if (rawImport.startsWith('.')) return null;
      const parts = rawImport.split('.');
      // Try foo/bar.py or foo/bar/__init__.py relative to repo root.
      const asFile = join(repoCtx.repoPath, parts.join('/') + '.py');
      if (existsSync(asFile)) return relative(repoCtx.repoPath, asFile);
      const asPackage = join(repoCtx.repoPath, parts.join('/'), '__init__.py');
      if (existsSync(asPackage)) return relative(repoCtx.repoPath, asPackage);
      return null;
    },
    isTest(rel) {
      const base = rel.split('/').pop() ?? '';
      return base.startsWith('test_') || base.endsWith('_test.py');
    },
  },
};

function langFor(filePath) {
  for (const [name, def] of Object.entries(LANGS)) {
    if (def.extensions.some((e) => filePath.endsWith(e))) return name;
  }
  return null;
}

// --------------------------------------------------------------------------
// Build the repo context — module prefix (Go), etc.

async function buildRepoContext(repoPath) {
  const ctx = { repoPath, goModulePrefix: null };
  const goMod = join(repoPath, 'go.mod');
  if (existsSync(goMod)) {
    try {
      const content = await readFile(goMod, 'utf8');
      const m = content.match(/^module\s+(\S+)/m);
      if (m) ctx.goModulePrefix = m[1];
    } catch {
      /* ignore — Go resolution will be a no-op */
    }
  }
  return ctx;
}

// --------------------------------------------------------------------------
// Main extraction

async function main() {
  const repoCtx = await buildRepoContext(repoPath);
  const allFiles = await walk(repoPath);

  // First pass: per-file, extract raw imports + tag tests.
  const fileData = new Map(); // relPath → { lang, rawImports, isTest }
  const langBreakdown = { go: 0, tsjs: 0, py: 0, other: 0 };
  for (const abs of allFiles) {
    const rel = relative(repoPath, abs);
    const lang = langFor(abs);
    if (!lang) {
      langBreakdown.other++;
      continue;
    }
    langBreakdown[lang]++;
    let content;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const rawImports = LANGS[lang].extract(content);
    fileData.set(rel, {
      lang,
      abs,
      rawImports,
      isTest: LANGS[lang].isTest(rel),
    });
  }

  // Second pass: resolve raw imports → in-repo files. Go's package-level
  // resolution needs a second-stage expansion (one package import → all
  // non-test .go files in that directory).
  const allRelPaths = new Set(fileData.keys());
  const packageFiles = new Map(); // dir → [rel-paths] (for go)
  for (const rel of allRelPaths) {
    const d = fileData.get(rel);
    if (d.lang !== 'go' || d.isTest) continue;
    const dir = dirname(rel);
    if (!packageFiles.has(dir)) packageFiles.set(dir, []);
    packageFiles.get(dir).push(rel);
  }

  // Build the per-file import lists.
  const files = {}; // rel → { lang, imports: [...], imported_by: [...], tests: [...] }
  for (const [rel, d] of fileData.entries()) {
    const resolved = new Set();
    for (const raw of d.rawImports) {
      const r = LANGS[d.lang].resolve(raw, d.abs, repoCtx);
      if (!r) continue;
      // Go: "package:<subpath>" → expand to all non-test .go files in that dir.
      if (typeof r === 'string' && r.startsWith('package:')) {
        const sub = r.slice('package:'.length);
        const pkgFiles = packageFiles.get(sub) ?? [];
        for (const f of pkgFiles) {
          if (f !== rel) resolved.add(f); // exclude self-imports (same-package)
        }
      } else if (allRelPaths.has(r)) {
        resolved.add(r);
      }
    }
    files[rel] = {
      lang: d.lang,
      imports: [...resolved].sort(),
      imported_by: [], // populated below
      tests: [], // populated below
      ...(d.isTest ? { is_test: true } : {}),
    };
  }

  // Reverse-index: walk imports, populate imported_by on the target side.
  for (const [rel, entry] of Object.entries(files)) {
    for (const target of entry.imports) {
      if (files[target]) files[target].imported_by.push(rel);
    }
  }
  for (const entry of Object.values(files)) entry.imported_by.sort();

  // Test association: for non-test files, find sibling tests covering them.
  // Convention-based — same-dir matches, optionally pointing back via import.
  for (const [rel, entry] of Object.entries(files)) {
    if (entry.is_test) continue;
    const base = rel.split('/').pop() ?? '';
    const stem = base.replace(/\.\w+$/, '');
    const dir = dirname(rel);
    // Candidates: anything in the same dir flagged as test that either has the
    // same stem (Go: `foo.go` ↔ `foo_test.go`; TS: `foo.ts` ↔ `foo.test.ts`)
    // OR explicitly imports this file.
    const tests = [];
    for (const [otherRel, otherEntry] of Object.entries(files)) {
      if (!otherEntry.is_test) continue;
      if (dirname(otherRel) !== dir) continue;
      const otherBase = otherRel.split('/').pop() ?? '';
      const otherStem = otherBase.replace(/\.(?:test|spec)\.\w+$|_test\.\w+$|\.\w+$/, '');
      if (otherStem === stem) {
        tests.push(otherRel);
        continue;
      }
      if (otherEntry.imports.includes(rel)) tests.push(otherRel);
    }
    entry.tests = [...new Set(tests)].sort();
  }

  // Hubs: top files by caller count. Threshold scaled to repo size so small
  // repos don't get spammy hub lists. Cap at 20 hubs max for prompt-budget
  // friendliness.
  const ranked = Object.entries(files)
    .filter(([, e]) => !e.is_test)
    .map(([rel, e]) => ({ file: rel, callers: e.imported_by.length }))
    .filter((x) => x.callers >= Math.max(3, Math.floor(Object.keys(files).length / 30)))
    .sort((a, b) => b.callers - a.callers)
    .slice(0, 20);

  // Apply --files filter to the output (not the computation).
  const outputFiles = filesFilter
    ? Object.fromEntries(filesFilter.map((f) => [f, files[f]]).filter(([, v]) => v))
    : files;

  const result = {
    generated_at: new Date().toISOString(),
    repo_path: repoPath,
    language_breakdown: langBreakdown,
    total_files: Object.keys(files).length,
    files: outputFiles,
    hubs: ranked,
  };

  const json = JSON.stringify(result, null, 2);
  if (outArg) {
    await mkdir(dirname(resolve(outArg)), { recursive: true });
    await writeFile(outArg, json + '\n', 'utf8');
    // Stderr summary so callers see what landed without parsing the JSON.
    process.stderr.write(
      `import-graph written: ${outArg}\n` +
        `  files: ${Object.keys(files).length} ` +
        `(go=${langBreakdown.go}, tsjs=${langBreakdown.tsjs}, py=${langBreakdown.py})\n` +
        `  hubs: ${ranked.length}\n`,
    );
  } else {
    process.stdout.write(json + '\n');
  }
}

main().catch((e) => {
  console.error(`extract-imports failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});
