#!/usr/bin/env node

// Builds Lynx bundles, builds + signs for a real iOS device, installs and launches.
//
// Required configuration (env vars or ./.env.ios.local key=value lines):
//   IOS_DEVICE_UDID         e.g. 00008150-00054DE80183401C  (xcrun xctrace list devices)
//   IOS_DEVELOPMENT_TEAM    Apple Developer Team ID (10 chars, e.g. YB9TA5FQBW)
//
// Optional:
//   IOS_CONFIGURATION       Debug (default) | Release
//   IOS_BUNDLE_ID           override PRODUCT_BUNDLE_IDENTIFIER auto-detection
//   IOS_SKIP_POD_INSTALL    set to '1' to skip `pod install`
//   IOS_SKIP_LYNX_BUILD     set to '1' to skip `pnpm build` (use the last bundle)
//
// Prereqs (one-time):
//   - Xcode → Settings → Accounts → sign in to the Apple ID for IOS_DEVELOPMENT_TEAM
//   - Connect the device once via USB; trust this Mac on the device
//   - Optional: enable "Connect via network" in Window → Devices and Simulators

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')

function loadEnvFile(path) {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  })
}

async function runStreaming(command, args, options = {}) {
  return new Promise((resolveFn, rejectFn) => {
    const child = execFile(command, args, {
      cwd: options.cwd ?? repoRoot,
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    })
    child.stdout?.pipe(process.stdout)
    child.stderr?.pipe(process.stderr)
    child.on('error', rejectFn)
    child.on('exit', (code) => {
      if (code === 0) resolveFn()
      else rejectFn(new Error(`${command} exited with code ${code}`))
    })
  })
}

function readBuildSetting(output, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = output.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+)$`, 'm'))
  return match?.[1]?.trim() ?? null
}

function fail(message) {
  process.stderr.write(`run:ios-device — ${message}\n`)
  process.exit(1)
}

// Mirror of the post_install injection in ios/Podfile so that runs with
// IOS_SKIP_POD_INSTALL=1 still produce Xcode-UI-buildable Pods xcconfigs.
function injectSigningIntoPodsXcconfigs(xcconfigPath) {
  if (!existsSync(xcconfigPath)) return
  const localLines = readFileSync(xcconfigPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
  if (localLines.length === 0) return

  const startMarker = '// >>> opencode_lynx local signing'
  const endMarker = '// <<< opencode_lynx local signing'
  const injection = `\n${startMarker}\n${localLines.join('\n')}\n${endMarker}\n`

  const supportRoot = resolve(repoRoot, 'ios/Pods/Target Support Files')
  if (!existsSync(supportRoot)) return
  const targetDirs = readdirSync(supportRoot)
    .filter((name) => name.startsWith('Pods-OpenCodeLynx'))
  for (const dir of targetDirs) {
    const dirPath = resolve(supportRoot, dir)
    const files = readdirSync(dirPath).filter((f) => f.endsWith('.xcconfig'))
    for (const file of files) {
      const filePath = resolve(dirPath, file)
      const original = readFileSync(filePath, 'utf8')
      const stripped = original.replace(
        new RegExp(`\\n${startMarker.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\n?`, 'm'),
        '',
      )
      writeFileSync(filePath, stripped + injection, 'utf8')
    }
  }
}

async function listDevices() {
  try {
    const { stdout } = await run('xcrun', ['xctrace', 'list', 'devices'])
    return stdout
  } catch {
    return '(could not list devices)'
  }
}

async function main() {
  loadEnvFile(resolve(repoRoot, '.env.ios.local'))

  const deviceUdid = process.env.IOS_DEVICE_UDID
  const team = process.env.IOS_DEVELOPMENT_TEAM
  const configuration = process.env.IOS_CONFIGURATION ?? 'Debug'

  if (!deviceUdid || !team) {
    const devicesOutput = await listDevices()
    fail([
      'missing required configuration.',
      '',
      'Set these in your shell or in ./.env.ios.local:',
      '  IOS_DEVICE_UDID=<your-device-udid>',
      '  IOS_DEVELOPMENT_TEAM=<10-char-team-id>',
      '',
      'Connected devices:',
      devicesOutput.split('\n').filter((l) => l.trim().length > 0).slice(0, 20).join('\n'),
    ].join('\n'))
  }

  if (!/^[A-F0-9]{8}-[A-F0-9]{16}$/i.test(deviceUdid) && !/^[A-F0-9]{40}$/i.test(deviceUdid)) {
    process.stdout.write(`Warning: IOS_DEVICE_UDID ${deviceUdid} does not look like an iOS device UDID — proceeding anyway.\n`)
  }

  // Step 1: Lynx bundle
  if (process.env.IOS_SKIP_LYNX_BUILD !== '1') {
    process.stdout.write('Building Lynx bundles...\n')
    await runStreaming('pnpm', ['build'])
  }

  // Step 2: pod install
  if (process.env.IOS_SKIP_POD_INSTALL !== '1') {
    process.stdout.write('Running pod install...\n')
    await runStreaming('pod', ['install'], { cwd: resolve(repoRoot, 'ios') })
  }

  // Step 3: xcodebuild for the real device.
  // Pass the team via -xcconfig so it is NOT written back into project.pbxproj.
  // (Inline `DEVELOPMENT_TEAM=...` build settings can be persisted by xcodebuild
  // when -allowProvisioningUpdates resolves automatic signing; an external
  // xcconfig file is treated as an override and never round-trips.)
  const xcconfigPath = resolve(repoRoot, 'ios/Local.xcconfig')
  writeFileSync(
    xcconfigPath,
    [
      '// Auto-generated by scripts/run-ios-device.mjs — do not commit.',
      `DEVELOPMENT_TEAM = ${team}`,
      'CODE_SIGN_STYLE = Automatic',
      '',
    ].join('\n'),
    'utf8',
  )

  // Ensure Xcode UI builds pick up the team without writing it back into
  // project.pbxproj. The Podfile post_install does this on `pod install`;
  // we mirror it here so IOS_SKIP_POD_INSTALL=1 paths also stay clean.
  injectSigningIntoPodsXcconfigs(xcconfigPath)

  process.stdout.write(`Building Xcode project for device ${deviceUdid} (team ${team})...\n`)
  const destination = `id=${deviceUdid}`
  await runStreaming('xcodebuild', [
    'build',
    '-workspace', 'ios/OpenCodeLynx.xcworkspace',
    '-scheme', 'OpenCodeLynx',
    '-configuration', configuration,
    '-destination', destination,
    '-xcconfig', xcconfigPath,
    '-allowProvisioningUpdates',
    '-quiet',
  ])

  // Step 4: Locate built .app
  const { stdout: settingsOutput } = await run('xcodebuild', [
    '-workspace', 'ios/OpenCodeLynx.xcworkspace',
    '-scheme', 'OpenCodeLynx',
    '-configuration', configuration,
    '-destination', destination,
    '-xcconfig', xcconfigPath,
    '-showBuildSettings',
  ])
  const builtProductsDir = readBuildSetting(settingsOutput, 'BUILT_PRODUCTS_DIR')
  if (!builtProductsDir) fail('could not determine BUILT_PRODUCTS_DIR from xcodebuild settings.')
  const appPath = resolve(builtProductsDir, 'OpenCodeLynx.app')
  if (!existsSync(appPath)) fail(`built app not found at ${appPath}.`)

  const bundleId = process.env.IOS_BUNDLE_ID ?? readBuildSetting(settingsOutput, 'PRODUCT_BUNDLE_IDENTIFIER')
  if (!bundleId) fail('could not determine PRODUCT_BUNDLE_IDENTIFIER.')

  // Step 5: install + launch via devicectl
  process.stdout.write(`Installing on ${deviceUdid}...\n`)
  await runStreaming('xcrun', [
    'devicectl', 'device', 'install', 'app',
    '--device', deviceUdid,
    appPath,
  ])

  process.stdout.write(`Launching ${bundleId}...\n`)
  await runStreaming('xcrun', [
    'devicectl', 'device', 'process', 'launch',
    '--device', deviceUdid,
    bundleId,
  ])

  process.stdout.write('Done.\n')
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
