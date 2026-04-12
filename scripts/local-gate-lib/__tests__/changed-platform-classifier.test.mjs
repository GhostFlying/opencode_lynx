import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyChangedPlatform } from '../changed-platform-classifier.mjs'
import matrix from './fixtures/changed-platform-classifier.matrix.mjs'

/**
 * @typedef {{ status: string, path?: string, fromPath?: string, toPath?: string }} ChangedFile
 * @typedef {{ name: string, changes: ChangedFile[], expected: 'ios' | 'android' | 'both' }} MatrixCase
 */

test('fixture matrix classifies changed-platform targets deterministically', () => {
  for (const fixture of /** @type {MatrixCase[]} */ (matrix)) {
    const actual = classifyChangedPlatform(fixture.changes)
    assert.equal(actual, fixture.expected, fixture.name)
  }
})

test('unknown or unmatched paths fail-closed to both', () => {
  const outcome = classifyChangedPlatform([
    { status: 'M', path: 'totally/unknown/path.ts' },
  ])

  assert.equal(outcome, 'both')
})

test('rename and delete inputs are supported', () => {
  const renameOutcome = classifyChangedPlatform([
    {
      status: 'R100',
      fromPath: 'ios/OpenCodeLynx/Old.swift',
      toPath: 'ios/OpenCodeLynx/New.swift',
    },
  ])

  const deleteOutcome = classifyChangedPlatform([
    { status: 'D', path: 'android/app/src/main/java/com/example/DeadCode.kt' },
  ])

  assert.equal(renameOutcome, 'ios')
  assert.equal(deleteOutcome, 'android')
})
