#!/usr/bin/env node
/**
 * Build the browser half into the harness's lazy-CJS plugin format and stage the
 * host half.
 *
 * The wrapper below is the exact shape the harness's client module system
 * consumes (`dsh-client-modules`): executing a bundle only REGISTERS a factory;
 * `require` inside it resolves other client entries (react, the UI primitive
 * packages) through the loader's module table — hence every bare import must
 * stay external.
 */
import { cpSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')          // the package IS the repository root
const srcDir = join(root, 'src')
const libDir = join(root, 'lib')

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const id = packageJson.name

const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`
const footer = `
\t\treturn module.exports;
\t},
});
`

/** Resolve esbuild from the local tree first, then the Homebrew/global install. */
async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch {
    const candidates = [
      '/opt/homebrew/lib/node_modules/esbuild/lib/main.js',
      '/usr/local/lib/node_modules/esbuild/lib/main.js',
    ]
    for (const candidate of candidates) {
      try {
        return await import(candidate)
      } catch {
        /* try the next one */
      }
    }
  }
  throw new Error('esbuild not found: install it locally (`npm i -D esbuild`) or globally')
}

mkdirSync(libDir, { recursive: true })

const esbuild = await loadEsbuild()
const result = await esbuild.build({
  entryPoints: [join(srcDir, 'client.jsx')],
  outfile: join(libDir, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  legalComments: 'none',
  logLevel: 'warning',
  banner: { js: banner },
  footer: { js: footer },
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  metafile: true,
})

// Stage the host half verbatim: it is plain ESM and resolves its one runtime
// dependency (@deepseek-ai/schemastery) from the harness profile.
cpSync(join(srcDir, 'index.js'), join(libDir, 'index.js'))

const outputs = Object.keys(result.metafile.outputs)
const warnings = []
const client = readFileSync(join(libDir, 'client.js'), 'utf8')
if (!client.includes('window.__ModuleLoader__.load(')) warnings.push('client.js is missing the module-loader wrapper')
if (!client.includes(JSON.stringify(id))) warnings.push(`client.js does not register id ${id}`)
if (client.includes('createElement("div"') && client.length > 400_000) {
  warnings.push('client.js looks like it bundled a dependency that should stay external')
}
// Platform modules MUST stay external (the shell's frozen module table answers
// them); everything else is deliberately inlined, because a bare `require` the
// loader table cannot answer throws at runtime.
const platformBundled = Object.keys(result.metafile.inputs).filter((path) =>
  /node_modules\/(react|react-dom|@deepseek-ai)\//.test(path),
)
if (platformBundled.length > 0) {
  warnings.push(`platform modules were bundled instead of externalized: ${platformBundled.join(', ')}`)
}
const inlined = Object.keys(result.metafile.inputs).filter((path) => path.includes('node_modules'))
console.log(`inlined third-party inputs: ${inlined.length === 0 ? '(none)' : inlined.join(', ')}`)

console.log(`built ${id}`)
for (const file of outputs) {
  console.log(`  ${file.replace(`${root}/`, '')}  ${String(statSync(file).size).padStart(8)} bytes`)
}
if (warnings.length > 0) {
  console.error('\nWARNINGS:')
  for (const warning of warnings) console.error(`  - ${warning}`)
  process.exitCode = 1
}
