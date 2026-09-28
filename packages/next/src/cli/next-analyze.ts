#!/usr/bin/env node

import '../server/lib/cpu-profile'
import { saveCpuProfile } from '../server/lib/cpu-profile'
import { existsSync } from 'fs'
import { italic } from '../lib/picocolors'
import analyze from '../build/analyze'
import { warn } from '../build/output/log'
import { printAndExit } from '../server/lib/utils'
import { getProjectDir } from '../lib/get-project-dir'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { dumpAnalyzeGraph } from '../build/analyze/graph-dump'

export type NextAnalyzeOptions = {
  experimentalAnalyze?: boolean
  profile?: boolean
  mangling: boolean
  port: number
  output: boolean | 'json'
  snapshot?: string
  route?: string
  experimentalAppOnly?: boolean
  snapshotName?: string
}

const nextAnalyze = async (options: NextAnalyzeOptions, directory?: string) => {
  process.on('SIGTERM', () => {
    saveCpuProfile()
    process.exit(143)
  })
  process.on('SIGINT', () => {
    saveCpuProfile()
    process.exit(130)
  })

  const { profile, mangling, experimentalAppOnly, output, port, snapshotName } =
    options

  if (output && output !== true && output !== 'json') {
    throw new Error(`Unsupported analyze output format: ${output}`)
  }
  if (output === 'json') {
    const dir = getProjectDir(directory)
    if (!existsSync(dir)) {
      printAndExit(`> No such directory exists as the project root: ${dir}`)
    }
    if (!options.snapshot) {
      // A child process sends every build log (including native output) to stderr.
      // The parent reserves stdout exclusively for JSON lines.
      const args = ['analyze', dir, '--output']
      if (!mangling) args.push('--no-mangling')
      if (profile) args.push('--profile')
      if (experimentalAppOnly) args.push('--experimental-app-only')
      if (snapshotName) args.push('--snapshot-name', snapshotName)
      const child = spawn(process.execPath, [process.argv[1], ...args], {
        stdio: ['inherit', process.stderr, process.stderr],
      })
      const [code] = (await once(child, 'close')) as [number | null]
      if (code !== 0) throw new Error(`Analyze failed (exit code ${code})`)
    }
    const analyzeDir = join(dir, '.next/diagnostics/analyze')
    const index = JSON.parse(
      await readFile(join(analyzeDir, 'history/history.json'), 'utf8')
    ) as { snapshots: Array<{ id: string }> }
    const id = options.snapshot ?? index.snapshots[0]?.id
    if (!id || !index.snapshots.some((snapshot) => snapshot.id === id)) {
      throw new Error(`Analyzer snapshot not found: ${id ?? '(none)'}`)
    }
    await dumpAnalyzeGraph(analyzeDir, id, options.route, process.stdout)
    return
  }
  if (options.snapshot || options.route) {
    throw new Error('--snapshot and --route require --output=json')
  }

  if (!mangling) {
    warn(
      `Mangling is disabled. ${italic('Note: This may affect performance and should only be used for debugging purposes.')}`
    )
  }

  if (profile) {
    warn(
      `Profiling is enabled. ${italic('Note: This may affect performance.')}`
    )
  }

  const dir = getProjectDir(directory)

  if (!existsSync(dir)) {
    printAndExit(`> No such directory exists as the project root: ${dir}`)
  }

  return analyze({
    dir,
    reactProductionProfiling: profile,
    noMangling: !mangling,
    appDirOnly: experimentalAppOnly,
    output,
    port,
    snapshotName,
  })
}

export { nextAnalyze }
