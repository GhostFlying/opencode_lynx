import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { classifyChangedPlatform } from './changed-platform-classifier.mjs'

export const EXIT_CODES = Object.freeze({
  PASS: 0,
  ENV_MISSING: 2,
  CHANGED_DETECTION_ERROR: 3,
  VALIDATION_FAILURE: 4,
  INVALID_ARGUMENTS: 5,
})

const VALID_MODES = new Set(['changed', 'full'])
const VALID_PLATFORMS = new Set(['auto', 'ios', 'android', 'both'])

const HELP_TEXT = `Maintainer-only WIP tool for orchestrating repo-owned native smoke checks.
It is not part of the public contribution contract.

Usage: node scripts/local-gate --mode changed|full --base <git-ref> --platform auto|ios|android|both

Flags:
  --mode changed|full
  --base <git-ref>
  --platform auto|ios|android|both

Exit codes:
  0  pass
  2  env/toolchain missing
  3  changed-file detection/classification error
  4  validation stage failure
  5  invalid arguments
`

const PLATFORM_STAGE_MAP = {
  ios: [
    ['gate:ios-deeplink-smoke', ['pnpm', ['--dir', 'src', 'run', 'gate:ios-deeplink-smoke']]],
    ['gate:ios-smoke', ['pnpm', ['--dir', 'src', 'run', 'gate:ios-smoke']]],
  ],
  android: [
    ['gate:android-deeplink-smoke', ['pnpm', ['--dir', 'src', 'run', 'gate:android-deeplink-smoke']]],
    ['gate:android-smoke', ['pnpm', ['--dir', 'src', 'run', 'gate:android-smoke']]],
  ],
  both: [
    ['gate:ios-deeplink-smoke', ['pnpm', ['--dir', 'src', 'run', 'gate:ios-deeplink-smoke']]],
    ['gate:ios-smoke', ['pnpm', ['--dir', 'src', 'run', 'gate:ios-smoke']]],
    ['gate:android-deeplink-smoke', ['pnpm', ['--dir', 'src', 'run', 'gate:android-deeplink-smoke']]],
    ['gate:android-smoke', ['pnpm', ['--dir', 'src', 'run', 'gate:android-smoke']]],
  ],
}

/**
 * @typedef {{ mode: 'changed' | 'full', base: string | null, platform: 'auto' | 'ios' | 'android' | 'both', help: boolean }} ParsedArgs
 * @typedef {{ status: string, path?: string, fromPath?: string, toPath?: string }} ChangedFile
 */

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
  /** @type {ParsedArgs} */
  const parsed = {
    mode: /** @type {'changed'} */ ('changed'),
    base: null,
    platform: /** @type {'auto'} */ ('auto'),
    help: false,
  }

  let hasMode = false
  let hasPlatform = false

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]

    if (token === '--help' || token === '-h') {
      parsed.help = true
      continue
    }

    if (token === '--mode') {
      const modeValue = argv[index + 1]
      if (!modeValue || modeValue.startsWith('--')) {
        throw new Error('Missing value for --mode')
      }

      if (!VALID_MODES.has(modeValue)) {
        throw new Error('Invalid --mode value')
      }

      parsed.mode = /** @type {'changed' | 'full'} */ (modeValue)
      hasMode = true
      index += 1
      continue
    }

    if (token === '--base') {
      const baseValue = argv[index + 1]
      if (!baseValue || baseValue.startsWith('--')) {
        throw new Error('Missing value for --base')
      }

      parsed.base = baseValue
      index += 1
      continue
    }

    if (token === '--platform') {
      const platformValue = argv[index + 1]
      if (!platformValue || platformValue.startsWith('--')) {
        throw new Error('Missing value for --platform')
      }

      if (!VALID_PLATFORMS.has(platformValue)) {
        throw new Error('Invalid --platform value')
      }

      parsed.platform = /** @type {'auto' | 'ios' | 'android' | 'both'} */ (platformValue)
      hasPlatform = true
      index += 1
      continue
    }

    throw new Error(`Unknown argument: ${token}`)
  }

  if (!parsed.help) {
    if (!hasMode) {
      throw new Error('--mode is required')
    }

    if (!hasPlatform) {
      throw new Error('--platform is required')
    }

    if (parsed.mode === 'changed' && !parsed.base) {
      throw new Error('--base is required when --mode changed is used')
    }
  }

  return parsed
}

/**
 * @typedef {{
 *   command: string,
 *   args?: string[],
 *   cwd?: string,
 * }} CommandSpec
 *
 * @typedef {{
 *   code: number,
 *   stdout: string,
 *   stderr: string,
 *   notFound: boolean,
 * }} CommandResult
 */

/**
 * @param {CommandSpec} spec
 * @returns {Promise<CommandResult>}
 */
export function runCommand(spec) {
  return new Promise((resolveResult) => {
    const child = spawn(spec.command, spec.args ?? [], {
      cwd: spec.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let notFound = false

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => {
      if (error && /** @type {{ code?: string }} */ (error).code === 'ENOENT') {
        notFound = true
      }

      stderr += String(error)
    })

    child.on('close', (code) => {
      resolveResult({
        code: code ?? 1,
        stdout,
        stderr,
        notFound,
      })
    })
  })
}

/**
 * @param {string} diffOutput
 * @returns {ChangedFile[]}
 */
export function parseGitNameStatus(diffOutput) {
  if (diffOutput.trim().length === 0) {
    return []
  }

  const parsed = []

  for (const rawLine of diffOutput.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) {
      continue
    }

    const segments = line.split('\t')
    const status = segments[0]

    if (!status || status.length === 0) {
      throw new Error(`Malformed git diff line: ${line}`)
    }

    if (status.toUpperCase().startsWith('R')) {
      if (segments.length < 3) {
        throw new Error(`Malformed rename line: ${line}`)
      }

      parsed.push({
        status,
        fromPath: segments[1],
        toPath: segments[2],
      })
      continue
    }

    if (segments.length < 2) {
      throw new Error(`Malformed status line: ${line}`)
    }

    parsed.push({
      status,
      path: segments[1],
    })
  }

  return parsed
}

/**
 * @param {'ios' | 'android' | 'both'} platform
 */
function buildStages(platform) {
  const entries = PLATFORM_STAGE_MAP[platform]
  return entries.map(([id, [command, args]]) => ({ id, command, args }))
}

/**
 * @param {{ commandRunner: (spec: CommandSpec) => Promise<CommandResult>, cwd: string }} deps
 */
async function ensureToolchain(deps) {
  const pnpmCheck = await deps.commandRunner({ command: 'pnpm', args: ['--version'], cwd: deps.cwd })
  if (pnpmCheck.notFound) {
    return { ok: false, missing: 'pnpm' }
  }

  const gitCheck = await deps.commandRunner({ command: 'git', args: ['--version'], cwd: deps.cwd })
  if (gitCheck.notFound) {
    return { ok: false, missing: 'git' }
  }

  return { ok: true }
}

/**
 * @param {{
 *   argv: string[],
 *   cwd?: string,
 *   now?: () => Date,
 *   commandRunner?: (spec: CommandSpec) => Promise<CommandResult>,
 *   writeArtifactFiles?: (baseName: string, report: Record<string, unknown>, summaryText: string, cwd: string) => Promise<{ jsonPath: string, textPath: string }>,
 * }} input
 */
export async function runLocalGate(input) {
  const now = input.now ?? (() => new Date())
  const cwd = input.cwd ?? process.cwd()
  const commandRunner = input.commandRunner ?? runCommand
  const writeArtifactFiles = input.writeArtifactFiles ?? defaultWriteArtifacts

  const startedAt = now()
  const runId = `${startedAt.getTime()}-${process.pid}`

  const baseReport = {
    schema: 'local_gate_v1',
    runId,
    startedAt: startedAt.toISOString(),
    args: /** @type {Record<string, unknown>} */ ({}),
    mode: null,
    selectedPlatform: null,
    changedFiles: [],
    stageResults: [],
    outcome: {
      status: 'fail',
      exitCode: EXIT_CODES.INVALID_ARGUMENTS,
      reason: 'not-run',
    },
  }

  /** @type {number} */
  let exitCode = EXIT_CODES.PASS
  /** @type {string} */
  let reason = 'pass'
  /** @type {'changed' | 'full' | null} */
  let mode = null
  /** @type {'ios' | 'android' | 'both' | null} */
  let selectedPlatform = null
  /** @type {ChangedFile[]} */
  let changedFiles = []
  /** @type {Array<Record<string, unknown>>} */
  const stageResults = []

  try {
    const parsed = parseArgs(input.argv)
    baseReport.args = {
      mode: parsed.mode,
      base: parsed.base,
      platform: parsed.platform,
      help: parsed.help,
    }

    if (parsed.help) {
      exitCode = EXIT_CODES.PASS
      reason = 'help'
      const report = finalizeReport({
        baseReport,
        now,
        mode,
        selectedPlatform,
        changedFiles,
        stageResults,
        exitCode,
        reason,
      })

      const summaryText = buildSummaryText(report)
      const artifacts = await writeArtifactFiles(`local-gate-${runId}`, report, `${HELP_TEXT}\n${summaryText}`, cwd)
      return {
        exitCode,
        report,
        artifacts,
        stdout: HELP_TEXT,
      }
    }

    mode = parsed.mode

    const toolchain = await ensureToolchain({ commandRunner, cwd })
    if (!toolchain.ok) {
      exitCode = EXIT_CODES.ENV_MISSING
      reason = `missing-toolchain:${toolchain.missing}`
    }

    if (exitCode === EXIT_CODES.PASS && mode === 'changed' && parsed.platform === 'auto') {
      const diffResult = await commandRunner({
        command: 'git',
        args: ['diff', '--name-status', '--find-renames', '--diff-filter=ACDMR', `${parsed.base}...HEAD`],
        cwd,
      })

      if (diffResult.notFound) {
        exitCode = EXIT_CODES.ENV_MISSING
        reason = 'missing-toolchain:git'
      } else if (diffResult.code !== 0) {
        exitCode = EXIT_CODES.CHANGED_DETECTION_ERROR
        reason = 'changed-detection-failed'
      } else {
        try {
          changedFiles = parseGitNameStatus(diffResult.stdout)
          selectedPlatform = classifyChangedPlatform(changedFiles)
        } catch (_error) {
          exitCode = EXIT_CODES.CHANGED_DETECTION_ERROR
          reason = 'classification-failed'
        }
      }
    }

    if (exitCode === EXIT_CODES.PASS && selectedPlatform === null) {
      if (parsed.platform === 'auto') {
        selectedPlatform = mode === 'full' ? 'both' : 'both'
      } else {
        selectedPlatform = parsed.platform
      }
    }

    if (exitCode === EXIT_CODES.PASS && selectedPlatform !== null) {
      const stages = buildStages(selectedPlatform)

      for (const stage of stages) {
        const stageStarted = now()
        const stageResult = await commandRunner({
          command: stage.command,
          args: stage.args,
          cwd,
        })

        const stageEnded = now()
        const record = {
          id: stage.id,
          command: [stage.command, ...(stage.args ?? [])].join(' '),
          startedAt: stageStarted.toISOString(),
          endedAt: stageEnded.toISOString(),
          durationMs: stageEnded.getTime() - stageStarted.getTime(),
          exitCode: stageResult.code,
          notFound: stageResult.notFound,
          status: stageResult.code === 0 && !stageResult.notFound ? 'pass' : 'fail',
        }

        stageResults.push(record)

        if (stageResult.notFound) {
          exitCode = EXIT_CODES.ENV_MISSING
          reason = `missing-toolchain:${stage.command}`
          break
        }

        if (stageResult.code !== 0) {
          exitCode = EXIT_CODES.VALIDATION_FAILURE
          reason = `stage-failed:${stage.id}`
          break
        }
      }
    }

    if (exitCode === EXIT_CODES.PASS && reason !== 'help') {
      reason = 'pass'
    }
  } catch (error) {
    exitCode = EXIT_CODES.INVALID_ARGUMENTS
    reason = `invalid-arguments:${error instanceof Error ? error.message : 'unknown'}`
  }

  const report = finalizeReport({
    baseReport,
    now,
    mode,
    selectedPlatform,
    changedFiles,
    stageResults,
    exitCode,
    reason,
  })

  const summaryText = buildSummaryText(report)
  const artifacts = await writeArtifactFiles(`local-gate-${runId}`, report, summaryText, cwd)

  return {
    exitCode,
    report,
    artifacts,
    stdout: '',
  }
}

/**
 * @param {{
 *   baseReport: Record<string, unknown>,
 *   now: () => Date,
 *   mode: 'changed' | 'full' | null,
 *   selectedPlatform: 'ios' | 'android' | 'both' | null,
 *   changedFiles: ChangedFile[],
 *   stageResults: Array<Record<string, unknown>>,
 *   exitCode: number,
 *   reason: string,
 * }} params
 */
function finalizeReport(params) {
  const endedAt = params.now()
  return {
    ...params.baseReport,
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - new Date(String(params.baseReport.startedAt)).getTime(),
    mode: params.mode,
    selectedPlatform: params.selectedPlatform,
    changedFiles: params.changedFiles,
    stageResults: params.stageResults,
    outcome: {
      status: params.exitCode === EXIT_CODES.PASS ? 'pass' : 'fail',
      exitCode: params.exitCode,
      reason: params.reason,
    },
  }
}

/**
 * @param {Record<string, unknown>} report
 */
export function buildSummaryText(report) {
  const outcome = /** @type {{ status: string, exitCode: number, reason: string }} */ (report.outcome)
  const selectedPlatform = report.selectedPlatform ?? 'n/a'
  const mode = report.mode ?? 'n/a'
  const stageResults = /** @type {Array<{ id: string, status: string }>} */ (report.stageResults)

  const lines = [
    'local-gate summary',
    `run_id: ${String(report.runId)}`,
    `mode: ${String(mode)}`,
    `selected_platform: ${String(selectedPlatform)}`,
    `outcome: ${outcome.status}`,
    `exit_code: ${outcome.exitCode}`,
    `reason: ${outcome.reason}`,
    `stage_count: ${stageResults.length}`,
  ]

  for (const stage of stageResults) {
    lines.push(`stage ${stage.id}: ${stage.status}`)
  }

  return `${lines.join('\n')}\n`
}

/**
 * @param {string} baseName
 * @param {Record<string, unknown>} report
 * @param {string} summaryText
 * @param {string} cwd
 */
export async function defaultWriteArtifacts(baseName, report, summaryText, cwd) {
  const evidenceDir = resolve(cwd, '.sisyphus/evidence/local-gate')
  await mkdir(evidenceDir, { recursive: true })

  const jsonPath = resolve(evidenceDir, `${baseName}.json`)
  const textPath = resolve(evidenceDir, `${baseName}.txt`)

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(textPath, summaryText, 'utf8')

  return { jsonPath, textPath }
}

export const LOCAL_GATE_HELP_TEXT = HELP_TEXT
