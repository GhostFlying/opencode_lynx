#!/usr/bin/env node

// Builds Lynx bundles, runs xcodebuild, installs on simulator, and launches.

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
  })
}

function findBootedSimulator(output) {
  const match = output.match(/([A-F0-9-]{36})\s+\(Booted\)/i)
  return match?.[1] ?? null
}

function readBuildSetting(output, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`${escapedKey}\\s*=\\s*(.+)`))
  return match?.[1]?.trim() ?? null
}

async function main() {
  // Step 1: Build JS bundles
  process.stdout.write('Building Lynx bundles...\n')
  await run('pnpm', ['build'], { cwd: repoRoot })

  // Step 2: pod install
  process.stdout.write('Running pod install...\n')
  await run('pod', ['install'], { cwd: resolve(repoRoot, 'ios') })

  // Step 3: xcodebuild
  process.stdout.write('Building Xcode project...\n')
  const destination = process.env.IOS_DESTINATION ?? 'platform=iOS Simulator,name=iPhone 16'
  await run('xcodebuild', [
    'build',
    '-workspace', 'ios/OpenCodeLynx.xcworkspace',
    '-scheme', 'OpenCodeLynx',
    '-destination', destination,
    '-quiet',
  ], { cwd: repoRoot })

  // Step 4: Find booted simulator
  const { stdout: devicesOutput } = await run('xcrun', ['simctl', 'list', 'devices', 'booted'])
  let simulatorUdid = findBootedSimulator(devicesOutput)
  if (!simulatorUdid) {
    process.stdout.write('No booted simulator found, booting iPhone 16...\n')
    await run('xcrun', ['simctl', 'boot', 'iPhone 16'])
    const { stdout: retryOutput } = await run('xcrun', ['simctl', 'list', 'devices', 'booted'])
    simulatorUdid = findBootedSimulator(retryOutput)
    if (!simulatorUdid) {
      throw new Error('run:ios failed: could not boot a simulator')
    }
  }

  // Step 5: Find built app
  const { stdout: buildDirOut } = await run('xcodebuild', [
    '-workspace', 'ios/OpenCodeLynx.xcworkspace',
    '-scheme', 'OpenCodeLynx',
    '-destination', destination,
    '-showBuildSettings',
  ], { cwd: repoRoot })
  const buildDirMatch = buildDirOut.match(/BUILT_PRODUCTS_DIR\s*=\s*(.+)/)
  const buildDir = buildDirMatch?.[1]?.trim()
  if (!buildDir) {
    throw new Error('run:ios failed: could not determine BUILT_PRODUCTS_DIR')
  }
  const appPath = resolve(buildDir, 'OpenCodeLynx.app')

  // Step 6: Install and launch
  const bundleId = process.env.IOS_BUNDLE_ID ?? readBuildSetting(buildDirOut, 'PRODUCT_BUNDLE_IDENTIFIER')
  if (!bundleId) {
    throw new Error('run:ios failed: could not determine PRODUCT_BUNDLE_IDENTIFIER')
  }
  process.stdout.write(`Installing on simulator ${simulatorUdid}...\n`)
  await run('xcrun', ['simctl', 'install', simulatorUdid, appPath])

  process.stdout.write(`Launching ${bundleId}...\n`)
  const { stdout: launchOut } = await run('xcrun', ['simctl', 'launch', simulatorUdid, bundleId])
  process.stdout.write(launchOut)
  process.stdout.write('Done.\n')
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
