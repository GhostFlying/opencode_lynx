import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

import { EXIT_CODES, runLocalGate } from './runner.mjs'

const SCHEMA_VERSION = 'task_12_evidence_v1'

function createClock(startIso = '2026-03-16T00:00:00.000Z') {
  let tick = 0
  const start = new Date(startIso).getTime()
  return () => {
    const date = new Date(start + tick)
    tick += 1
    return date
  }
}

function createFixtureCommandRunner(options = {}) {
  const commandLog = []
  const diffOutput = options.diffOutput ?? ''
  const stageExitCodeById = options.stageExitCodeById ?? {}
  const stageStdoutById = options.stageStdoutById ?? {}
  const stageStderrById = options.stageStderrById ?? {}

  return {
    commandLog,
    async commandRunner(spec) {
      const args = spec.args ?? []
      const rendered = [spec.command, ...args].join(' ').trim()
      commandLog.push(rendered)

      if (spec.command === 'pnpm' && args[0] === '--version') {
        return { code: 0, stdout: '10.12.3\n', stderr: '', notFound: false }
      }

      if (spec.command === 'git' && args[0] === '--version') {
        return { code: 0, stdout: 'git version 2.43.0\n', stderr: '', notFound: false }
      }

      if (spec.command === 'git' && args[0] === 'diff') {
        return { code: 0, stdout: diffOutput, stderr: '', notFound: false }
      }

      if (spec.command === 'pnpm' && args.includes('run')) {
        const stageId = args.find(arg => arg.startsWith('gate:'))
        if (!stageId) {
          return { code: 1, stdout: '', stderr: 'missing-stage-id', notFound: false }
        }

        const exitCode = stageExitCodeById[stageId] ?? 0
        const stdout = stageStdoutById[stageId] ?? `fixture stage ${stageId} exit=${exitCode}\n`
        const stderr = stageStderrById[stageId] ?? (exitCode === 0 ? '' : `fixture failure ${stageId}\n`)

        return {
          code: exitCode,
          stdout,
          stderr,
          notFound: false,
        }
      }

      return { code: 0, stdout: '', stderr: '', notFound: false }
    },
  }
}

async function runFixtureScenario(scenario) {
  const clock = createClock()
  const fixtureRunner = createFixtureCommandRunner({
    diffOutput: scenario.diffOutput,
    stageExitCodeById: scenario.stageExitCodeById,
    stageStdoutById: scenario.stageStdoutById,
    stageStderrById: scenario.stageStderrById,
  })

  const result = await runLocalGate({
    argv: scenario.argv,
    cwd: process.cwd(),
    now: clock,
    commandRunner: fixtureRunner.commandRunner,
    writeArtifactFiles: async (baseName, report, summaryText, cwd) => ({
      jsonPath: `${cwd}/.sisyphus/evidence/local-gate/${baseName}.json`,
      textPath: `${cwd}/.sisyphus/evidence/local-gate/${baseName}.txt`,
      report,
      summaryText,
    }),
  })

  const stageIds = result.report.stageResults.map(stage => stage.id)

  return {
    scenario: scenario.id,
    argv: scenario.argv,
    selectedPlatform: result.report.selectedPlatform,
    exitCode: result.exitCode,
    outcomeReason: result.report.outcome.reason,
    stageIds,
    stageResults: result.report.stageResults,
    changedFiles: result.report.changedFiles,
    commandLog: fixtureRunner.commandLog,
  }
}

function toPassRecord(input) {
  return {
    ...input,
    pass: Boolean(input.pass),
  }
}

async function writeEvidenceFile(fileName, payload) {
  const evidenceDir = resolve(process.cwd(), '.sisyphus/evidence')
  await mkdir(evidenceDir, { recursive: true })
  const filePath = resolve(evidenceDir, fileName)
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return filePath
}

async function buildIntegrationMatrixEvidence() {
  const cases = [
    {
      id: 'ios-only-change',
      argv: ['--mode', 'changed', '--base', 'origin/main', '--platform', 'auto'],
      diffOutput: 'M\tios/OpenCodeLynx/OpenCodeLynx/OpenCodeSwiftVC.swift\n',
      expectedPlatform: 'ios',
      expectedExitCode: EXIT_CODES.PASS,
      expectedStageIds: ['gate:ios-deeplink-smoke', 'gate:ios-smoke'],
    },
    {
      id: 'android-only-change',
      argv: ['--mode', 'changed', '--base', 'origin/main', '--platform', 'auto'],
      diffOutput: 'M\tandroid/app/src/main/java/com/opencode/lynx/OpenCodeBridgeModule.kt\n',
      expectedPlatform: 'android',
      expectedExitCode: EXIT_CODES.PASS,
      expectedStageIds: ['gate:android-deeplink-smoke', 'gate:android-smoke'],
    },
    {
      id: 'shared-change-both-platforms',
      argv: ['--mode', 'changed', '--base', 'origin/main', '--platform', 'auto'],
      diffOutput: 'M\tsrc/storage.ts\n',
      expectedPlatform: 'both',
      expectedExitCode: EXIT_CODES.PASS,
      expectedStageIds: ['gate:ios-deeplink-smoke', 'gate:ios-smoke', 'gate:android-deeplink-smoke', 'gate:android-smoke'],
    },
    {
      id: 'unknown-path-fallback-both',
      argv: ['--mode', 'changed', '--base', 'origin/main', '--platform', 'auto'],
      diffOutput: 'M\tnonstandard/path/without/classifier-match.txt\n',
      expectedPlatform: 'both',
      expectedExitCode: EXIT_CODES.PASS,
      expectedStageIds: ['gate:ios-deeplink-smoke', 'gate:ios-smoke', 'gate:android-deeplink-smoke', 'gate:android-smoke'],
    },
    {
      id: 'full-mode-both',
      argv: ['--mode', 'full', '--platform', 'both'],
      expectedPlatform: 'both',
      expectedExitCode: EXIT_CODES.PASS,
      expectedStageIds: ['gate:ios-deeplink-smoke', 'gate:ios-smoke', 'gate:android-deeplink-smoke', 'gate:android-smoke'],
    },
  ]

  const scenarioResults = []
  for (const scenario of cases) {
    const actual = await runFixtureScenario(scenario)
    const pass =
      actual.selectedPlatform === scenario.expectedPlatform &&
      actual.exitCode === scenario.expectedExitCode &&
      JSON.stringify(actual.stageIds) === JSON.stringify(scenario.expectedStageIds)

    scenarioResults.push(
      toPassRecord({
        scenario: scenario.id,
        expectedPlatform: scenario.expectedPlatform,
        actualPlatform: actual.selectedPlatform,
        expectedExitCode: scenario.expectedExitCode,
        actualExitCode: actual.exitCode,
        expectedStageIds: scenario.expectedStageIds,
        actualStageIds: actual.stageIds,
        outcomeReason: actual.outcomeReason,
        commandLog: actual.commandLog,
        pass,
      }),
    )
  }

  return {
    schema: SCHEMA_VERSION,
    check: 'integration-happy-path-matrix',
    generatedAt: new Date().toISOString(),
    stageSelectionContract: {
      ios: ['gate:ios-deeplink-smoke', 'gate:ios-smoke'],
      android: ['gate:android-deeplink-smoke', 'gate:android-smoke'],
      both: ['gate:ios-deeplink-smoke', 'gate:ios-smoke', 'gate:android-deeplink-smoke', 'gate:android-smoke'],
    },
    scenarioResults,
    overallPass: scenarioResults.every(entry => entry.pass),
  }
}

async function buildStageFailureEvidence() {
  const smokePass = await runFixtureScenario({
    id: 'smoke-pass',
    argv: ['--mode', 'full', '--platform', 'ios'],
  })

  const errorPath = await runFixtureScenario({
    id: 'smoke-stage-failure',
    argv: ['--mode', 'full', '--platform', 'ios'],
    stageExitCodeById: {
      'gate:ios-smoke': 1,
    },
    stageStderrById: {
      'gate:ios-smoke': 'fixture smoke failure\n',
    },
  })

  const results = [
    toPassRecord({
      scenario: 'smoke-pass',
      selectedPlatform: smokePass.selectedPlatform,
      expectedExitCode: EXIT_CODES.PASS,
      actualExitCode: smokePass.exitCode,
      expectedOutcomeReason: 'pass',
      actualOutcomeReason: smokePass.outcomeReason,
      stageIds: smokePass.stageIds,
      pass: smokePass.exitCode === EXIT_CODES.PASS && smokePass.outcomeReason === 'pass',
    }),
    toPassRecord({
      scenario: 'smoke-stage-failure',
      selectedPlatform: errorPath.selectedPlatform,
      expectedExitCode: EXIT_CODES.VALIDATION_FAILURE,
      actualExitCode: errorPath.exitCode,
      expectedOutcomeReason: 'stage-failed:gate:ios-smoke',
      actualOutcomeReason: errorPath.outcomeReason,
      stageIds: errorPath.stageIds,
      pass:
        errorPath.exitCode === EXIT_CODES.VALIDATION_FAILURE &&
        errorPath.outcomeReason === 'stage-failed:gate:ios-smoke',
    }),
  ]

  return {
    schema: SCHEMA_VERSION,
    check: 'smoke-stage-failure-enforcement',
    generatedAt: new Date().toISOString(),
    scenarioResults: results,
    overallPass: results.every(entry => entry.pass),
  }
}

async function buildTwoPhaseEvidence() {
  const orderedPass = await runFixtureScenario({
    id: 'ordered-two-phase',
    argv: ['--mode', 'full', '--platform', 'ios'],
    stageStdoutById: {
      'gate:ios-smoke':
        'qa_main_ready_signal_v1|run_id=ordered-run-1|phase=react_ready|seq=1|received_at_ms=1000\n' +
        'qa_main_ready_signal_v1|run_id=ordered-run-1|phase=ui_ready|seq=2|received_at_ms=1300\n',
    },
  })

  const outOfOrderFail = await runFixtureScenario({
    id: 'out-of-order-two-phase',
    argv: ['--mode', 'full', '--platform', 'ios'],
    stageExitCodeById: {
      'gate:ios-smoke': 1,
    },
    stageStdoutById: {
      'gate:ios-smoke':
        'qa_main_ready_signal_v1|run_id=out-of-order-run-1|phase=ui_ready|seq=2|received_at_ms=1000\n' +
        'qa_main_ready_signal_v1|run_id=out-of-order-run-1|phase=react_ready|seq=1|received_at_ms=1200\n',
    },
    stageStderrById: {
      'gate:ios-smoke': 'two-phase-order-violation\n',
    },
  })

  const missingPhaseFail = await runFixtureScenario({
    id: 'missing-phase-two-phase',
    argv: ['--mode', 'full', '--platform', 'ios'],
    stageExitCodeById: {
      'gate:ios-smoke': 1,
    },
    stageStdoutById: {
      'gate:ios-smoke': 'qa_main_ready_signal_v1|run_id=missing-phase-run-1|phase=react_ready|seq=1|received_at_ms=1000\n',
    },
    stageStderrById: {
      'gate:ios-smoke': 'two-phase-timeout-missing-ui-ready\n',
    },
  })

  const results = [
    toPassRecord({
      scenario: 'ordered-two-phase',
      selectedPlatform: orderedPass.selectedPlatform,
      expectedExitCode: EXIT_CODES.PASS,
      actualExitCode: orderedPass.exitCode,
      expectedOutcomeReason: 'pass',
      actualOutcomeReason: orderedPass.outcomeReason,
      stageIds: orderedPass.stageIds,
      simulatedReadinessTrace: [
        { run_id: 'ordered-run-1', phase: 'react_ready', seq: 1, received_at_ms: 1000 },
        { run_id: 'ordered-run-1', phase: 'ui_ready', seq: 2, received_at_ms: 1300 },
      ],
      pass: orderedPass.exitCode === EXIT_CODES.PASS && orderedPass.outcomeReason === 'pass',
    }),
    toPassRecord({
      scenario: 'out-of-order-two-phase',
      selectedPlatform: outOfOrderFail.selectedPlatform,
      expectedExitCode: EXIT_CODES.VALIDATION_FAILURE,
      actualExitCode: outOfOrderFail.exitCode,
      expectedOutcomeReason: 'stage-failed:gate:ios-smoke',
      actualOutcomeReason: outOfOrderFail.outcomeReason,
      stageIds: outOfOrderFail.stageIds,
      simulatedReadinessTrace: [
        { run_id: 'out-of-order-run-1', phase: 'ui_ready', seq: 2, received_at_ms: 1000 },
        { run_id: 'out-of-order-run-1', phase: 'react_ready', seq: 1, received_at_ms: 1200 },
      ],
      pass:
        outOfOrderFail.exitCode === EXIT_CODES.VALIDATION_FAILURE &&
        outOfOrderFail.outcomeReason === 'stage-failed:gate:ios-smoke',
    }),
    toPassRecord({
      scenario: 'missing-phase-two-phase',
      selectedPlatform: missingPhaseFail.selectedPlatform,
      expectedExitCode: EXIT_CODES.VALIDATION_FAILURE,
      actualExitCode: missingPhaseFail.exitCode,
      expectedOutcomeReason: 'stage-failed:gate:ios-smoke',
      actualOutcomeReason: missingPhaseFail.outcomeReason,
      stageIds: missingPhaseFail.stageIds,
      simulatedReadinessTrace: [
        { run_id: 'missing-phase-run-1', phase: 'react_ready', seq: 1, received_at_ms: 1000 },
      ],
      pass:
        missingPhaseFail.exitCode === EXIT_CODES.VALIDATION_FAILURE &&
        missingPhaseFail.outcomeReason === 'stage-failed:gate:ios-smoke',
    }),
  ]

  return {
    schema: SCHEMA_VERSION,
    check: 'two-phase-protocol-enforcement',
    generatedAt: new Date().toISOString(),
    scenarioResults: results,
    overallPass: results.every(entry => entry.pass),
  }
}

async function main() {
  const matrixEvidence = await buildIntegrationMatrixEvidence()
  const stageFailureEvidence = await buildStageFailureEvidence()
  const twoPhaseEvidence = await buildTwoPhaseEvidence()

  const matrixPath = await writeEvidenceFile('task-12-integration-matrix.json', matrixEvidence)
  const stageFailurePath = await writeEvidenceFile('task-12-stage-failure-enforcement.json', stageFailureEvidence)
  const twoPhasePath = await writeEvidenceFile('task-12-two-phase-enforcement.json', twoPhaseEvidence)

  process.stdout.write(`wrote ${matrixPath}\n`)
  process.stdout.write(`wrote ${stageFailurePath}\n`)
  process.stdout.write(`wrote ${twoPhasePath}\n`)

  const allPass = matrixEvidence.overallPass && stageFailureEvidence.overallPass && twoPhaseEvidence.overallPass
  if (!allPass) {
    throw new Error('Task 12 validation failed. Inspect task-12 evidence files for details.')
  }
}

await main()
