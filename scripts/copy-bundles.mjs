#!/usr/bin/env node

// Copies built Lynx bundles from dist/ to iOS and Android asset directories.
// Copies bundles into native asset directories after rspeedy build.

import { cpSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const distDir = resolve(repoRoot, 'dist')

const targets = [
  resolve(repoRoot, 'ios', 'LynxResources'),
  resolve(repoRoot, 'android', 'app', 'src', 'main', 'assets'),
]

if (!existsSync(distDir)) {
  process.stderr.write(`copy-bundles: dist/ not found at ${distDir}\n`)
  process.exitCode = 1
} else {
  for (const target of targets) {
    cpSync(distDir, target, { recursive: true, force: true })
    process.stdout.write(`copy-bundles: copied dist/ → ${target}\n`)
  }
}
