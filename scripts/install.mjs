#!/usr/bin/env node
/**
 * Install this plugin into a DSH profile — as a thin wrapper over the harness's
 * own plugin command, which is the only thing that knows how a profile is laid
 * out.
 *
 * Why it is a wrapper and not a profile editor: an earlier version of this file
 * hand-wrote a `connection.trustedHosts` override plus a plugin row into
 * `cordis.patch.yml`. Both jobs moved. The plugin now registers its own tailnet
 * authority with the harness fence at runtime, so no profile edit is needed for
 * it; and `dsh plugin add` already writes the profile dependency and reconciles
 * `dsh.profile.bundles`, from which the package's own `dsh.bundle.patch` inserts
 * the plugin row. Owning a second, less correct copy of that logic is how this
 * script ended up pointing at a `bundle/` directory that no longer exists.
 *
 *   node scripts/install.mjs                       # install into profile `desktop`
 *   node scripts/install.mjs --profile work
 *   node scripts/install.mjs --spec /abs/path/to/checkout
 *   node scripts/install.mjs --dry-run             # print the command, change nothing
 *   node scripts/install.mjs --revert              # remove it again
 *
 * Exit code: 0 on success, the plugin manager's own code on failure, 2 on a usage
 * error.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = `Usage: node scripts/install.mjs [options]

  --profile <name>   DSH profile to install into (default: desktop)
  --spec <spec>      Install spec; default is this package's own GitHub release.
                     Registry name, github:owner/repo#tag, an ABSOLUTE local path,
                     or a file:/https: .tgz URL.
  --revert           Remove the plugin from the profile instead of adding it.
  --dry-run          Print the plugin-manager command without running it.
  -h, --help         Show this message.`

/** Parse the few flags this script has; unknown flags are a usage error, not a guess. */
function parseArgs(argv) {
  const options = { profile: 'desktop', spec: '', revert: false, dryRun: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '-h' || flag === '--help') options.help = true
    else if (flag === '--revert') options.revert = true
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--profile' || flag === '--spec') {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
      if (flag === '--profile') options.profile = value
      else options.spec = value
      i += 1
    } else throw new Error(`unknown option: ${flag}`)
  }
  if (options.profile.trim() === '') throw new Error('--profile must not be empty')
  return options
}

/** The package this script ships inside — also the profile dependency name. */
function readOwnManifest() {
  const manifestPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  return { manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
}

/**
 * The installed spec for THIS version: `github:owner/repo#v<version>`.
 *
 * Derived rather than hard-coded so the script can never install a different tag
 * than the one it was published in. A non-GitHub `repository.url` (or a missing
 * version) yields an empty string, and the caller asks for `--spec` instead of
 * guessing.
 */
function defaultSpec(manifest) {
  const url = String(manifest?.repository?.url ?? '')
  const match = /github\.com[/:]([^/]+)\/([^/#]+?)(?:\.git)?(?:#.*)?$/.exec(url)
  if (match === null || typeof manifest.version !== 'string') return ''
  return `github:${match[1]}/${match[2]}#v${manifest.version}`
}

/** Reject the shapes DSH rejects up front, so the failure is a sentence, not a stack. */
function validateSpec(spec) {
  const value = spec.trim()
  if (value === '') throw new Error('the install spec is empty')
  const looksLikePath = value.startsWith('.') || value.startsWith('/') || value.startsWith('~')
  if (looksLikePath && !isAbsolute(value)) {
    throw new Error(
      `a local install spec must be an ABSOLUTE path (got ${JSON.stringify(value)}); DSH resolves it from the profile, not from your shell`,
    )
  }
  return value
}

/** Locate the profile's package.json — used to confirm what actually landed. */
function verify(profileDir, name, expectedSpec) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return { ok: false, detail: `no package.json at ${manifestPath}` }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ok: false, detail: `cannot parse ${manifestPath}: ${String(error?.message ?? error)}` }
  }
  const installed = parsed?.dependencies?.[name]
  if (typeof installed !== 'string') return { ok: false, detail: `${name} is not a profile dependency` }
  const bundles = parsed?.dsh?.profile?.bundles ?? []
  const bundled = Array.isArray(bundles) && bundles.includes(name)
  return {
    ok: bundled,
    spec: installed,
    detail: bundled
      ? `${installed} · listed in dsh.profile.bundles`
      : `${installed} · NOT in dsh.profile.bundles (the plugin row would not be inserted)`,
    expectedSpec,
  }
}

function main(argv) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(USAGE)
    return 0
  }

  const { manifest } = readOwnManifest()
  const name = manifest.name
  const spec = validateSpec(options.spec.length > 0 ? options.spec : defaultSpec(manifest))
  if (options.spec.length === 0 && spec === '') {
    throw new Error(`cannot derive an install spec from ${name}'s repository.url — pass --spec explicitly`)
  }

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileDir = join(home, 'profiles', options.profile)
  if (!existsSync(profileDir)) {
    throw new Error(`no DSH profile at ${profileDir} (pass --profile <name>, or set DSH_HOME)`)
  }

  const args = options.revert
    ? ['plugin', '--profile', options.profile, 'remove', name]
    : ['plugin', '--profile', options.profile, 'add', spec]
  const printable = `dsh ${args.join(' ')}`

  if (options.dryRun) {
    console.log(`[dry-run] ${printable}`)
    console.log(`[dry-run] would inspect ${join(profileDir, 'package.json')}`)
    return 0
  }

  console.log(`→ ${printable}`)
  const result = spawnSync('dsh', args, { stdio: 'inherit', env: process.env })
  if (result.error !== undefined) {
    throw new Error(
      `cannot run \`dsh\`: ${String(result.error.message)}. The desktop app installs its CLI at /usr/local/bin/dsh.`,
    )
  }
  if (result.status !== 0) {
    console.error(`\n✗ the plugin manager exited with ${String(result.status)} — profile left as it was.`)
    return result.status ?? 1
  }

  if (options.revert) {
    const after = verify(profileDir, name, spec)
    console.log(`\n✓ removal reported; ${name} dependency: ${after.spec ?? '(gone)'}`)
    console.log('  Restart the desktop app so the host half is unloaded.')
    return 0
  }

  const check = verify(profileDir, name, spec)
  if (!check.ok) {
    console.error(`\n✗ installed, but the profile looks wrong: ${check.detail}`)
    return 1
  }
  console.log(`\n✓ ${name} → ${check.detail}`)
  console.log('  Restart the desktop app: the host half (mapping, routes, trust registration)')
  console.log('  loads at boot. The browser half alone re-loads on a page refresh, which is why')
  console.log('  a half-updated plugin can look translated in the panel while its error text is not.')
  return 0
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  console.error(`✗ ${String(error?.message ?? error)}`)
  console.error(`\n${USAGE}`)
  process.exitCode = 2
}
