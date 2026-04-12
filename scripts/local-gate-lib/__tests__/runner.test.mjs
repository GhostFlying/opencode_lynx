import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXIT_CODES,
  parseArgs,
  runLocalGate,
  buildSummaryText,
} from '../runner.mjs'

function createClock(startIso = '2026-03-15T09:00:00.000Z') {
  let tick = 0
  const start = new Date(startIso).getTime()
  return () => {
    const date = new Date(start + tick)
    tick += 1
    return date
  }
}

function createWriterSpy() {
  /** @type {Array<{ baseName: string, report: Record<string, unknown>, summaryText: string, cwd: string }>} */
  const writes = []

  return {
    writes,
    async writeArtifactFiles(baseName, report, summaryText, cwd) {
      writes.push({ baseName, report, summaryText, cwd })
      return {
        jsonPath: `${cwd}/.sisyphus/evidence/local-gate/${baseName}.json`,
        textPath: `${cwd}/.sisyphus/evidence/local-gate/${baseName}.txt`,
      }
    },
  }
}

function createCommandRunner(sequence) {
  let index = 0
  return async () => {
    if (index >= sequence.length) {
      return {
        code: 0,
        stdout: '',
        stderr: '',
        notFound: false,
      }
    }

    const response = sequence[index]
    index += 1
    return response
  }
}

test('parseArgs enforces base when mode changed', () => {
  assert.throws(
    () => parseArgs(['--mode', 'changed', '--platform', 'auto']),
    /--base is required when --mode changed is used/,
  )
})

test('parseArgs rejects invalid flag values', () => {
  assert.throws(
    () => parseArgs(['--mode', 'delta', '--base', 'origin/main', '--platform', 'auto']),
    /Invalid --mode value/,
  )

  assert.throws(
    () => parseArgs(['--mode', 'full', '--platform', 'mobile']),
    /Invalid --platform value/,
  )
})

test('runLocalGate returns exit code 5 for invalid arguments and writes artifacts', async () => {
  const writer = createWriterSpy()
  const result = await runLocalGate({
    argv: ['--mode', 'full'],
    cwd: '/tmp/project',
    now: createClock(),
    commandRunner: createCommandRunner([]),
    writeArtifactFiles: writer.writeArtifactFiles,
  })

  assert.equal(result.exitCode, EXIT_CODES.INVALID_ARGUMENTS)
  assert.equal(writer.writes.length, 1)
  assert.equal(result.report.outcome.exitCode, EXIT_CODES.INVALID_ARGUMENTS)
})

test('runLocalGate returns exit code 2 when toolchain is missing', async () => {
  const writer = createWriterSpy()
  const result = await runLocalGate({
    argv: ['--mode', 'full', '--platform', 'both'],
    cwd: '/tmp/project',
    now: createClock(),
    commandRunner: createCommandRunner([
      { code: 1, stdout: '', stderr: 'ENOENT', notFound: true },
    ]),
    writeArtifactFiles: writer.writeArtifactFiles,
  })

  assert.equal(result.exitCode, EXIT_CODES.ENV_MISSING)
  assert.equal(result.report.outcome.reason, 'missing-toolchain:pnpm')
  assert.equal(writer.writes.length, 1)
})

test('runLocalGate returns exit code 3 on changed detection failure', async () => {
  const writer = createWriterSpy()
  const result = await runLocalGate({
    argv: ['--mode', 'changed', '--base', 'origin/main', '--platform', 'auto'],
    cwd: '/tmp/project',
    now: createClock(),
    commandRunner: createCommandRunner([
      { code: 0, stdout: '10.0.0\n', stderr: '', notFound: false },
      { code: 0, stdout: 'git version 2.0\n', stderr: '', notFound: false },
      { code: 128, stdout: '', stderr: 'unknown revision', notFound: false },
    ]),
    writeArtifactFiles: writer.writeArtifactFiles,
  })

  assert.equal(result.exitCode, EXIT_CODES.CHANGED_DETECTION_ERROR)
  assert.equal(result.report.outcome.reason, 'changed-detection-failed')
  assert.equal(writer.writes.length, 1)
})

test('runLocalGate returns exit code 3 on changed classification parse errors', async () => {
  const writer = createWriterSpy()
  const result = await runLocalGate({
    argv: ['--mode', 'changed', '--base', 'origin/main', '--platform', 'auto'],
    cwd: '/tmp/project',
    now: createClock(),
    commandRunner: createCommandRunner([
      { code: 0, stdout: '10.0.0\n', stderr: '', notFound: false },
      { code: 0, stdout: 'git version 2.0\n', stderr: '', notFound: false },
      { code: 0, stdout: 'R100\tonly-one-path\n', stderr: '', notFound: false },
    ]),
    writeArtifactFiles: writer.writeArtifactFiles,
  })

  assert.equal(result.exitCode, EXIT_CODES.CHANGED_DETECTION_ERROR)
  assert.equal(result.report.outcome.reason, 'classification-failed')
  assert.equal(writer.writes.length, 1)
})

test('runLocalGate returns exit code 4 when any stage fails and writes artifacts', async () => {
  const writer = createWriterSpy()
  const result = await runLocalGate({
    argv: ['--mode', 'full', '--platform', 'ios'],
    cwd: '/tmp/project',
    now: createClock(),
    commandRunner: createCommandRunner([
      { code: 0, stdout: '10.0.0\n', stderr: '', notFound: false },
      { code: 0, stdout: 'git version 2.0\n', stderr: '', notFound: false },
      { code: 0, stdout: 'ok', stderr: '', notFound: false },
      { code: 1, stdout: '', stderr: 'failed', notFound: false },
    ]),
    writeArtifactFiles: writer.writeArtifactFiles,
  })

  assert.equal(result.exitCode, EXIT_CODES.VALIDATION_FAILURE)
  assert.equal(result.report.outcome.reason, 'stage-failed:gate:ios-smoke')
  assert.equal(result.report.stageResults.length, 2)
  assert.equal(writer.writes.length, 1)
  assert.match(writer.writes[0].summaryText, /outcome: fail/)
})

test('runLocalGate returns exit code 0 on pass and writes artifacts', async () => {
  const writer = createWriterSpy()
  const result = await runLocalGate({
    argv: ['--mode', 'changed', '--base', 'origin/main', '--platform', 'auto'],
    cwd: '/tmp/project',
    now: createClock(),
    commandRunner: createCommandRunner([
      { code: 0, stdout: '10.0.0\n', stderr: '', notFound: false },
      { code: 0, stdout: 'git version 2.0\n', stderr: '', notFound: false },
      { code: 0, stdout: 'M\tsrc/ios/OpenCodeLynx/OpenCodeLynx/OpenCodeSwiftVC.swift\n', stderr: '', notFound: false },
      { code: 0, stdout: 'ok', stderr: '', notFound: false },
      { code: 0, stdout: 'ok', stderr: '', notFound: false },
    ]),
    writeArtifactFiles: writer.writeArtifactFiles,
  })

  assert.equal(result.exitCode, EXIT_CODES.PASS)
  assert.equal(result.report.selectedPlatform, 'ios')
  assert.equal(result.report.stageResults.length, 2)
  assert.equal(writer.writes.length, 1)
  assert.match(writer.writes[0].summaryText, /outcome: pass/)
})

test('buildSummaryText includes selected platform and stage statuses', () => {
  const summary = buildSummaryText({
    runId: 'r1',
    mode: 'changed',
    selectedPlatform: 'android',
    stageResults: [{ id: 'gate:android-smoke', status: 'pass' }],
    outcome: { status: 'pass', exitCode: 0, reason: 'pass' },
  })

  assert.match(summary, /selected_platform: android/)
  assert.match(summary, /stage gate:android-smoke: pass/)
})
