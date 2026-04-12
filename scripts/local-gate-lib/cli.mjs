#!/usr/bin/env node

import process from 'node:process'
import { pathToFileURL } from 'node:url'

import { runLocalGate } from './runner.mjs'

/**
 * @param {string[]} argv
 */
export async function main(argv) {
  const result = await runLocalGate({
    argv,
    cwd: process.cwd(),
  })

  if (result.stdout && result.stdout.length > 0) {
    process.stdout.write(result.stdout)
  }

  process.stdout.write(`local-gate artifact json: ${result.artifacts.jsonPath}\n`)
  process.stdout.write(`local-gate artifact summary: ${result.artifacts.textPath}\n`)
  process.exitCode = result.exitCode
  return result.exitCode
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  await main(process.argv.slice(2))
}
