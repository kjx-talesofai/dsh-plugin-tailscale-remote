/**
 * Artifact / reference integrity.
 *
 * This suite exists because of one concrete failure: `scripts/install.mjs` spent two
 * releases importing `../bundle/scripts/install.mjs`, a file deleted when the package
 * moved to the repository root. Nothing checked it — the script was shipped (it is in
 * `files`), listed in the README, and crashed the moment anyone ran it. A path is a
 * promise; this is the only place that keeps it.
 *
 * It asserts that every path this package *names* actually exists:
 *   - every `files` entry that is a literal path (what `npm pack` will ship)
 *   - every `exports` target that is a literal path (what the harness resolves)
 *   - every relative import and `new URL(..., import.meta.url)` in the sources
 *
 *   node tests/artifacts.test.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (label, condition, extra = '') => {
  if (condition) console.log(`✅ ${label}`)
  else {
    failures.push(label)
    console.log(`❌ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const isGlob = (value) => /[*?]/.test(value)

// ---- 1. `files`: what npm pack will actually ship --------------------------
const shipped = Array.isArray(manifest.files) ? manifest.files : []
const missingShipped = shipped.filter((entry) => !isGlob(entry) && !existsSync(join(root, entry)))
check(
  `files 里每个字面路径都存在（${shipped.length} 项）`,
  shipped.length > 0 && missingShipped.length === 0,
  missingShipped.join(', '),
)

// A `files` entry that matches nothing is a silent omission from the tarball.
const emptyGlobs = shipped.filter((entry) => isGlob(entry) && !globHasMatch(entry))
check(`files 里每个通配项都至少命中一个文件（${emptyGlobs.length} 个通配）`, emptyGlobs.length === 0, emptyGlobs.join(', '))

/** Expand the two glob shapes a `files` array realistically uses (`dir/*`, `dir/**`). */
function globHasMatch(pattern) {
  const base = pattern.slice(0, pattern.search(/[*?]/)).replace(/\/$/, '')
  const dir = join(root, base)
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false
  const recursive = pattern.includes('**')
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isFile()) return true
      if (entry.isDirectory() && recursive && walk(join(current, entry.name))) return true
    }
    return false
  }
  return walk(dir)
}

// ---- 2. `exports`: what the harness resolves ------------------------------
const exportTargets = []
const collectExports = (value) => {
  if (typeof value === 'string') exportTargets.push(value)
  else if (value !== null && typeof value === 'object') for (const nested of Object.values(value)) collectExports(nested)
}
collectExports(manifest.exports)
const missingExports = exportTargets.filter((target) => !isGlob(target) && !existsSync(join(root, target)))
check(
  `exports 里每个字面目标都存在（${exportTargets.length} 项）`,
  exportTargets.length > 0 && missingExports.length === 0,
  missingExports.join(', '),
)
// The locale files are how `dsh-app-boot` localizes the plugin's own name; the
// subpath MUST be exported or the resolver reports them as missing.
check('exports 暴露 ./locale/*（否则插件列表只有英文名）', typeof manifest.exports?.['./locale/*'] === 'string')

// ---- 3. every relative reference in the sources ---------------------------
const sourceFiles = []
for (const dir of ['src', 'scripts', 'tests']) {
  const absolute = join(root, dir)
  if (!existsSync(absolute)) continue
  for (const entry of readdirSync(absolute)) {
    if (/\.(mjs|js|jsx)$/.test(entry)) sourceFiles.push(join(dir, entry))
  }
}
const REFERENCE = /(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]|new\s+URL\(\s*['"](\.[^'"]+)['"]/g
const dangling = []
for (const file of sourceFiles) {
  const text = readFileSync(join(root, file), 'utf8')
  for (const match of text.matchAll(REFERENCE)) {
    const specifier = match[1] ?? match[2]
    const target = resolve(root, dirname(file), specifier)
    if (!existsSync(target)) dangling.push(`${file} → ${specifier}`)
  }
}
check(
  `源码里每个相对引用都指向真实文件（扫了 ${sourceFiles.length} 个文件）`,
  sourceFiles.length > 0 && dangling.length === 0,
  dangling.join('; '),
)

// ---- 4. the two halves ship together and in sync --------------------------
check('lib/index.js 与 src/index.js 逐字节一致（构建只是拷贝）', readFileSync(join(root, 'lib/index.js'), 'utf8') === readFileSync(join(root, 'src/index.js'), 'utf8'))
const clientBundle = readFileSync(join(root, 'lib/client.js'), 'utf8')
check('lib/client.js 带 module-loader 包装', clientBundle.includes('window.__ModuleLoader__.load('))
check('lib/client.js 注册的是本包的 id', clientBundle.includes(JSON.stringify(manifest.name)))

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL（${failures.length} 项）`}`)
if (failures.length > 0) {
  for (const line of failures) console.log(`  · ${line}`)
  process.exitCode = 1
}
