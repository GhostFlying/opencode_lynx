import { readdirSync, readFileSync, statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

interface SourceFile {
  readonly path: string
  readonly content: string
}

interface SdkImportMatch {
  readonly specifier: string
  readonly line: number
}

interface BoundaryViolation {
  readonly path: string
  readonly line: number
  readonly specifier: string
}

const SDK_IMPORT_PATTERN = /(?:from\s+['"](@opencode-ai\/sdk(?:\/[^'"]*)?)['"]|import\s*\(\s*['"](@opencode-ai\/sdk(?:\/[^'"]*)?)['"]\s*\)|require\(\s*['"](@opencode-ai\/sdk(?:\/[^'"]*)?)['"]\s*\)|import\s+['"](@opencode-ai\/sdk(?:\/[^'"]*)?)['"])/g

const thisFile = fileURLToPath(import.meta.url)
const testsDir = resolve(thisFile, '..')
const srcDir = resolve(testsDir, '..', '..')
const repoRoot = resolve(srcDir, '..')
const allowedRoot = resolve(srcDir, 'opencode')

function collectSourceFiles(dir: string): SourceFile[] {
  const entries = readdirSync(dir)
  const files: SourceFile[] = []

  for (const entry of entries) {
    const fullPath = resolve(dir, entry)
    const stats = statSync(fullPath)

    if (stats.isDirectory()) {
      files.push(...collectSourceFiles(fullPath))
      continue
    }

    if (!fullPath.endsWith('.ts') && !fullPath.endsWith('.tsx')) {
      continue
    }

    files.push({
      path: fullPath,
      content: readFileSync(fullPath, 'utf-8'),
    })
  }

  return files
}

function getLineAtOffset(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

function findSdkImports(content: string): SdkImportMatch[] {
  const matches: SdkImportMatch[] = []
  SDK_IMPORT_PATTERN.lastIndex = 0

  for (let match = SDK_IMPORT_PATTERN.exec(content); match; match = SDK_IMPORT_PATTERN.exec(content)) {
    const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]

    if (!specifier) {
      continue
    }

    matches.push({
      specifier,
      line: getLineAtOffset(content, match.index),
    })
  }

  return matches
}

function isAllowedImportPath(filePath: string): boolean {
  const normalized = filePath.split(sep).join('/')
  const allowed = allowedRoot.split(sep).join('/')
  return normalized === allowed || normalized.startsWith(`${allowed}/`)
}

function findBoundaryViolations(files: readonly SourceFile[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = []

  for (const file of files) {
    const imports = findSdkImports(file.content)

    for (const sdkImport of imports) {
      if (isAllowedImportPath(file.path)) {
        continue
      }

      violations.push({
        path: relative(repoRoot, file.path).split(sep).join('/'),
        line: sdkImport.line,
        specifier: sdkImport.specifier,
      })
    }
  }

  return violations
}

describe('sdk import boundary', () => {
  it('allows @opencode-ai/sdk imports only inside src/opencode/*', () => {
    const legalImport = {
      path: resolve(srcDir, 'opencode', 'wrapper.ts'),
      content: 'import { createOpencodeClient } from "@opencode-ai/sdk/v2"\n',
    }
    const illegalImport = {
      path: resolve(srcDir, 'feature', 'outside-wrapper.ts'),
      content: 'import { createOpencodeClient } from "@opencode-ai/sdk/v2"\n',
    }

    expect(findBoundaryViolations([legalImport])).toEqual([])
    expect(findBoundaryViolations([illegalImport])).toEqual([
      {
        path: 'src/feature/outside-wrapper.ts',
        line: 1,
        specifier: '@opencode-ai/sdk/v2',
      },
    ])
  })

  it('has no out-of-bound @opencode-ai/sdk imports in repository sources', () => {
    const files = collectSourceFiles(srcDir)
    const violations = findBoundaryViolations(files)

    expect(
      violations,
      violations.length === 0
        ? undefined
        : `Illegal @opencode-ai/sdk import(s) outside src/opencode/*:\n${violations
            .map((violation) => `- ${violation.path}:${violation.line} -> ${violation.specifier}`)
            .join('\n')}`,
    ).toEqual([])
  })
})
