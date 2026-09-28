import { join } from 'path'
import resolveFrom from 'resolve-from'
import { isNextDev, nextTestSetup } from 'e2e-utils'
import { findPort, retry } from 'next-test-utils'

describe('agent upgrade prompt', () => {
  const { next } = nextTestSetup({
    files: join(__dirname, 'agent-upgrade-prompt'),
    skipStart: true,
    skipDeployment: true,
    // The human menu requires a TTY and raw-mode keypresses; pipes skip it.
    dependencies: {
      'node-pty': '0.10.1',
    },
    // pnpm must build node-pty's native binding in the isolated test app.
    packageJson: {
      pnpm: {
        onlyBuiltDependencies: ['node-pty'],
      },
    },
  })

  if (!isNextDev) {
    it.skip('runs only in dev mode', () => {})
    return
  }

  async function startDev(policy: 'security' | null) {
    // NEXT_SKIP_ISOLATE uses this checkout's build instead of an installed copy.
    const nextBin = process.env.NEXT_SKIP_ISOLATE
      ? join(process.cwd(), 'packages/next/dist/bin/next')
      : resolveFrom(next.testDir, 'next/dist/bin/next')
    const pty = require(resolveFrom(next.testDir, 'node-pty'))
    const port = await findPort()
    const env: NodeJS.ProcessEnv = { ...process.env }
    // Set or clear the request explicitly so the ordinary-dev case cannot
    // inherit an upgrade policy from the test runner.
    if (policy) {
      env.__NEXT_AGENTIC_AUTO_UPGRADE = policy
    } else {
      delete env.__NEXT_AGENTIC_AUTO_UPGRADE
    }
    // The test runner may itself be an agent. Clear its markers so the child
    // takes the human prompt path instead of the agent upgrade path.
    delete env.AI_AGENT
    delete env.CODEX_SANDBOX
    delete env.CODEX_CI
    delete env.CODEX_THREAD_ID

    const terminal = pty.spawn(
      process.execPath,
      [nextBin, 'dev', '-p', String(port), '-H', '127.0.0.1'],
      {
        cwd: next.testDir,
        env,
        name: 'xterm-256color',
        cols: 100,
        rows: 30,
      }
    )
    let output = ''
    let exited = false
    terminal.onData((data: string) => {
      output += data
    })
    terminal.onExit(() => {
      exited = true
    })

    return {
      port,
      terminal,
      get output() {
        return output
      },
      get exited() {
        return exited
      },
      async stop() {
        if (!exited) {
          terminal.kill()
          await retry(async () => {
            expect(exited).toBe(true)
          }, 10_000)
        }
      },
    }
  }

  async function expectPage(port: number) {
    await retry(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('hello world')
    }, 10_000)
  }

  it('serves ordinary dev without an upgrade policy', async () => {
    const dev = await startDev(null)
    try {
      await expectPage(dev.port)
      expect(dev.output).not.toContain('Upgrade now')
    } finally {
      await dev.stop()
    }
  })

  // Security advisories do not target canary prereleases, so this policy
  // should leave dev serving without an upgrade menu in either gate variant.
  it('serves dev without a menu under the security policy', async () => {
    const dev = await startDev('security')
    try {
      await expectPage(dev.port)
      expect(dev.output).not.toContain('Upgrade now')
    } finally {
      await dev.stop()
    }
  })

  it('completes build without a menu under the security policy', async () => {
    const nextBin = process.env.NEXT_SKIP_ISOLATE
      ? join(process.cwd(), 'packages/next/dist/bin/next')
      : resolveFrom(next.testDir, 'next/dist/bin/next')
    const pty = require(resolveFrom(next.testDir, 'node-pty'))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      __NEXT_AGENTIC_AUTO_UPGRADE: 'security',
    }
    delete env.AI_AGENT
    delete env.CODEX_SANDBOX
    delete env.CODEX_CI
    delete env.CODEX_THREAD_ID

    const terminal = pty.spawn(process.execPath, [nextBin, 'build'], {
      cwd: next.testDir,
      env,
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
    })
    let output = ''
    let exited = false
    let exitCode: number | undefined
    terminal.onData((data: string) => {
      output += data
    })
    terminal.onExit(({ exitCode: code }) => {
      exited = true
      exitCode = code
    })

    try {
      await retry(async () => {
        expect(exited).toBe(true)
      }, 120_000)
      expect(exitCode).toBe(0)
      expect(output).not.toContain('Upgrade now')
    } finally {
      if (!exited) {
        terminal.kill()
      }
    }
  })
})
