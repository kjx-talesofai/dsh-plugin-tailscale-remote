#!/usr/bin/env node
/**
 * Repo-side wrapper. The canonical installer ships INSIDE the package
 * (`bundle/scripts/install.mjs`) so that someone who only received the .tgz can
 * still write the harness `trustedHosts` block. This wrapper keeps the familiar
 * `node scripts/install.mjs …` entry point working from the development tree.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../bundle/scripts/install.mjs', import.meta.url))
const result = spawnSync(process.execPath, [installer, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
