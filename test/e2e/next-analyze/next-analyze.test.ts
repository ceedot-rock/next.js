import { nextTestSetup } from 'e2e-utils'
import { shouldUseTurbopack } from 'next-test-utils'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

type RouteEntry = {
  route_entry_id: string
  module_ident: string
  role: 'route' | 'shared'
  entry_kind?: 'server' | 'client_bootstrap'
  client_references?: Array<{
    module_ident: string
    module_path: string
    reference_kind: 'ecmascript' | 'css'
  }>
}

function readAnalyzeHeader<T>(filename: string): T {
  const buffer = readFileSync(filename)
  const jsonLength = buffer.readUInt32BE(0)
  return JSON.parse(buffer.subarray(4, 4 + jsonLength).toString('utf8')) as T
}

describe('next analyze', () => {
  if (!shouldUseTurbopack()) {
    // Test suites require at least one test
    it('skips in non-Turbopack tests', () => {})
    return
  }

  const { next, skipped } = nextTestSetup({
    files: __dirname,
    skipStart: true,
    skipDeployment: true,
  })

  if (skipped) {
    // Test suites require at least one test
    it('is skipped', () => {})
    return
  }

  it('runs successfully without errors', async () => {
    let serveProcess: ChildProcess | undefined
    let stdoutBuffer = ''
    let resolveUrl!: (url: string) => void
    let rejectUrl!: (err: Error) => void
    const urlPromise = new Promise<string>((resolve, reject) => {
      resolveUrl = resolve
      rejectUrl = reject
    })

    const timeout = setTimeout(() => {
      rejectUrl(new Error('Server did not start within timeout'))
    }, 30000)

    const exit = next
      .runCommand(['analyze', '--port', '0'], {
        onStdout(msg) {
          stdoutBuffer += msg
          const urlMatch = stdoutBuffer.match(/http:\/\/[^\s]+/)
          if (urlMatch) {
            resolveUrl(urlMatch[0])
          }
        },
        instance(p) {
          serveProcess = p
        },
      })
      .finally(() => {
        clearTimeout(timeout)
      })

    try {
      const url = await urlPromise
      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(
        '<title>Next.js Bundle Analyzer</title>'
      )
    } finally {
      serveProcess?.kill()
      await exit.catch(() => {})
    }
  })

  it('stores the snapshot name in live and historical metadata', async () => {
    const name = 'My snapshot'
    const { exitCode, stderr } = await next.runCommand([
      'analyze',
      '--output',
      '--snapshot-name',
      name,
    ])

    expect(exitCode).toBe(0)
    expect(stderr).not.toContain('Error')

    const analyzeDir = path.join(next.testDir, '.next/diagnostics/analyze')
    const metadata = JSON.parse(
      readFileSync(path.join(analyzeDir, 'data/metadata.json'), 'utf-8')
    )
    expect(metadata.snapshotName).toBe(name)
    expect(metadata).not.toHaveProperty('baselineName')

    const history = JSON.parse(
      readFileSync(path.join(analyzeDir, 'history/history.json'), 'utf-8')
    )
    expect(history.snapshots[0].snapshotName).toBe(name)
    expect(history.snapshots[0]).not.toHaveProperty('baselineName')
  })

  it('dumps a versioned graph and replays the saved snapshot on demand', async () => {
    const started = Date.now()
    const fresh = await next.runCommand([
      'analyze',
      '--output=json',
      '--snapshot-name',
      'JSON snapshot',
    ])
    // Log the real fixture's output size and elapsed time without pasting its graph.
    console.log(
      `Analyzer NDJSON fixture: ${Buffer.byteLength(fresh.stdout)} bytes in ${Date.now() - started}ms`
    )
    expect(fresh.exitCode).toBe(0)
    expect(fresh.stderr).toContain('Analyzing a production build')
    const records = fresh.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(records[0]).toMatchObject({ type: 'meta', schema_version: 1 })
    expect(records.some((record) => record.type === 'module')).toBe(true)
    expect(records.some((record) => record.type === 'part')).toBe(true)
    expect(records.some((record) => record.type === 'output')).toBe(true)
    expect(records.some((record) => record.type === 'route')).toBe(true)

    const analyzeDir = path.join(next.testDir, '.next/diagnostics/analyze')
    const history = JSON.parse(
      readFileSync(path.join(analyzeDir, 'history/history.json'), 'utf8')
    )
    const id = history.snapshots[0].id
    expect(history.snapshots[0].snapshotName).toBe('JSON snapshot')
    expect(records[0].snapshot_id).toBe(id)
    const appHeader = readAnalyzeHeader<{ route_entries: RouteEntry[] }>(
      path.join(analyzeDir, 'history', id, 'analyze.data')
    )
    const appRecord = records.find(
      (record) => record.type === 'route' && record.route === '/'
    )
    expect(
      appRecord.entries.map((entry: RouteEntry) => ({
        route_entry_id: entry.route_entry_id,
        module_ident: entry.module_ident,
        role: entry.role,
        entry_kind: entry.entry_kind,
        client_references: entry.client_references,
      }))
    ).toEqual(
      appHeader.route_entries.map((entry) => ({
        route_entry_id: entry.route_entry_id,
        module_ident: entry.module_ident,
        role: entry.role,
        entry_kind: entry.entry_kind ?? null,
        client_references: entry.client_references ?? [],
      }))
    )
    expect(
      existsSync(path.join(analyzeDir, 'history', id, 'graph.ndjson'))
    ).toBe(false)
    const replay = await next.runCommand([
      'analyze',
      '--output=json',
      '--snapshot',
      id,
    ])
    expect(replay.exitCode).toBe(0)
    // History IDs are second-resolution and can be replaced by another build;
    // compare two read-only replays of the saved files, not separate writers.
    const replayAgain = await next.runCommand([
      'analyze',
      '--output=json',
      '--snapshot',
      id,
    ])
    expect(replayAgain.exitCode).toBe(0)
    expect(replayAgain.stdout).toBe(replay.stdout)
    const alias = await next.runCommand([
      'experimental-analyze',
      '--output=json',
      '--snapshot',
      id,
    ])
    expect(alias.exitCode).toBe(0)
    expect(alias.stdout).toBe(replay.stdout)
    expect(replay.stderr).not.toContain('Analyzing a production build')
    const root = await next.runCommand([
      'analyze',
      '--output=json',
      '--snapshot',
      id,
      '--route',
      '/',
    ])
    expect(root.exitCode).toBe(0)
    const rootRecords = root.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rootRecords.filter((record) => record.type === 'module')).toEqual(
      records.filter((record) => record.type === 'module')
    )
    expect(rootRecords.filter((record) => record.type === 'route')).toEqual(
      records.filter(
        (record) => record.type === 'route' && record.route === '/'
      )
    )
    const missing = await next.runCommand([
      'analyze',
      '--output=json',
      '--snapshot',
      id,
      '--route',
      '/does-not-exist',
    ])
    expect(missing.exitCode).not.toBe(0)
    expect(missing.stdout).toBe('')
    expect(missing.stderr).toContain('Unknown analyzer route')
    const traversal = await next.runCommand([
      'analyze',
      '--output=json',
      '--snapshot',
      '../bad',
    ])
    expect(traversal.exitCode).not.toBe(0)
    expect(traversal.stdout).toBe('')
    for (const args of [
      ['analyze', '--output=xml'],
      ['analyze', '--route', '/'],
      ['analyze', '--snapshot', id],
    ]) {
      const invalid = await next.runCommand(args)
      expect(invalid.exitCode).not.toBe(0)
      expect(invalid.stdout).toBe('')
    }

    const moduleFile = path.join(analyzeDir, 'history', id, 'modules.data')
    const original = readFileSync(moduleFile)
    try {
      const unsupported = Buffer.from(original)
      const headerLength = unsupported.readUInt32BE(0)
      const header = JSON.parse(
        unsupported.toString('utf8', 4, 4 + headerLength)
      )
      const versionedHeader = Buffer.from(
        JSON.stringify({ ...header, schema_version: 999 })
      )
      writeFileSync(
        moduleFile,
        Buffer.concat([
          Buffer.from([
            (versionedHeader.length >>> 24) & 255,
            (versionedHeader.length >>> 16) & 255,
            (versionedHeader.length >>> 8) & 255,
            versionedHeader.length & 255,
          ]),
          versionedHeader,
          unsupported.subarray(4 + headerLength),
        ])
      )
      const unknownVersion = await next.runCommand([
        'analyze',
        '--output=json',
        '--snapshot',
        id,
      ])
      expect(unknownVersion.exitCode).not.toBe(0)
      expect(unknownVersion.stdout).toBe('')
      expect(unknownVersion.stderr).toContain('Unsupported analyzer schema')

      writeFileSync(moduleFile, original.subarray(0, 3))
      const truncated = await next.runCommand([
        'analyze',
        '--output=json',
        '--snapshot',
        id,
      ])
      expect(truncated.exitCode).not.toBe(0)
      expect(truncated.stdout).toBe('')
      expect(truncated.stderr).toContain('Truncated analyzer header')
    } finally {
      writeFileSync(moduleFile, original)
    }
  })

  it('replays a snapshot created by next build --analyze', async () => {
    const build = await next.runCommand(['build', '--analyze'])
    if (build.exitCode !== 0) {
      throw new Error(
        `next build --analyze failed: ${build.stderr}\n${build.stdout}`
      )
    }
    const analyzeDir = path.join(next.testDir, '.next/diagnostics/analyze')
    const history = JSON.parse(
      readFileSync(path.join(analyzeDir, 'history/history.json'), 'utf8')
    )
    const id = history.snapshots[0].id
    const replay = await next.runCommand([
      'analyze',
      '--output=json',
      '--snapshot',
      id,
    ])
    expect(replay.exitCode).toBe(0)
    expect(
      replay.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))[0]
    ).toMatchObject({
      type: 'meta',
      snapshot_id: id,
    })
    expect(replay.stderr).not.toContain('Analyzing a production build')
  })
  ;['-o', '--output'].forEach((flag) => {
    describe(`with ${flag} flag`, () => {
      it('writes output to .next/diagnostics/analyze path', async () => {
        const defaultOutputPath = path.join(
          next.testDir,
          '.next/diagnostics/analyze'
        )

        const { exitCode, stderr, stdout } = await next.runCommand([
          'analyze',
          flag,
          ...(flag === '--output' ? ['.'] : []),
        ])

        expect(exitCode).toBe(0)
        expect(stderr).not.toContain('Error')
        expect(stdout).toContain('.next/diagnostics/analyze')

        expect(existsSync(defaultOutputPath)).toBe(true)
        for (const file of [
          'index.html',
          'data/routes.json',
          'data/modules.data',
          'data/analyze.data',
        ]) {
          expect(existsSync(path.join(defaultOutputPath, file))).toBe(true)
        }

        const routesJson = readFileSync(
          path.join(defaultOutputPath, 'data', 'routes.json'),
          'utf-8'
        )
        const routes = JSON.parse(routesJson)
        expect([...routes].sort()).toEqual(
          ['/', '/_not-found', '/api/ping', '/legacy'].sort()
        )

        const dataDir = path.join(defaultOutputPath, 'data')
        const { modules } = readAnalyzeHeader<{
          modules: Array<{ ident: string }>
        }>(path.join(dataDir, 'modules.data'))
        const moduleIdents = new Set(modules.map((module) => module.ident))
        const { route_entries: appEntries } = readAnalyzeHeader<{
          route_entries: RouteEntry[]
        }>(path.join(dataDir, 'analyze.data'))
        const { route_entries: pagesEntries } = readAnalyzeHeader<{
          route_entries: RouteEntry[]
        }>(path.join(dataDir, 'legacy', 'analyze.data'))
        const { route_entries: apiEntries } = readAnalyzeHeader<{
          route_entries: RouteEntry[]
        }>(path.join(dataDir, 'api', 'ping', 'analyze.data'))

        expect(appEntries.some((entry) => entry.entry_kind === 'server')).toBe(
          true
        )
        expect(
          appEntries.some((entry) => entry.entry_kind === 'client_bootstrap')
        ).toBe(true)
        const clientReferences = appEntries.flatMap(
          (entry) => entry.client_references ?? []
        )
        expect(
          clientReferences.some((reference) =>
            reference.module_path.includes('client-entry')
          )
        ).toBe(true)
        expect(
          clientReferences.some(
            (reference) => reference.reference_kind === 'css'
          )
        ).toBe(true)
        const rootIdents = new Set(
          appEntries.map((entry) => entry.module_ident)
        )
        for (const reference of clientReferences) {
          expect(rootIdents.has(reference.module_ident)).toBe(false)
          expect(moduleIdents.has(reference.module_ident)).toBe(true)
          expect(['ecmascript', 'css']).toContain(reference.reference_kind)
        }
        expect(
          pagesEntries.some((entry) => entry.entry_kind === 'client_bootstrap')
        ).toBe(true)
        expect(pagesEntries.some((entry) => entry.role === 'shared')).toBe(true)
        expect(apiEntries.some((entry) => entry.entry_kind === 'server')).toBe(
          true
        )
        expect(
          apiEntries.some((entry) => entry.entry_kind === 'client_bootstrap')
        ).toBe(false)
        expect(
          apiEntries.every((entry) => !entry.client_references?.length)
        ).toBe(true)
        for (const entry of [...appEntries, ...pagesEntries, ...apiEntries]) {
          expect(moduleIdents.has(entry.module_ident)).toBe(true)
          expect(entry).not.toHaveProperty('initial')
          expect(entry).not.toHaveProperty('load_scope')
        }
      })
    })
  })
})
