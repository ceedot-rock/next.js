import type { ChildProcess } from 'child_process'
import {
  nudgeUpgradeForHuman,
  type NudgeKind,
  type UpgradeReminder,
} from './nudge'
import type { UpgradeAction } from './prompt'

const MAX_BUFFERED_OUTPUT = 1024 * 1024

export function coordinateUpgradeOutput(
  child: ChildProcess,
  directory: string,
  onAction: (action: UpgradeAction, policy: NudgeKind) => void,
  keepPromptOnExit: boolean = false
) {
  if (!child.stdout || !child.stderr) {
    throw new Error('Upgrade prompt child output must be piped')
  }

  const stdout = child.stdout
  const stderr = child.stderr
  let buffered: { output: NodeJS.WriteStream; data: Buffer }[] = []
  let bufferedBytes = 0
  let buffering = false
  let closed = false
  let prompt: Promise<void> | undefined
  let controller: AbortController | undefined
  const replayCancellation = new AbortController()

  const capture = (output: NodeJS.WriteStream, data: Buffer) => {
    if (!buffering) {
      output.write(data)
      return
    }
    buffered.push({ output, data })
    bufferedBytes += data.length
    if (bufferedBytes > MAX_BUFFERED_OUTPUT) {
      // Keep the build moving until the menu can close, then replay everything.
      stdout.pause()
      stderr.pause()
      controller?.abort()
    }
  }
  stdout.on('data', (data: Buffer) => capture(process.stdout, data))
  stderr.on('data', (data: Buffer) => capture(process.stderr, data))

  function waitForDrain(output: NodeJS.WriteStream): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        output.off('drain', onDrain)
        output.off('error', onError)
        replayCancellation.signal.removeEventListener('abort', onAbort)
      }
      const onDrain = () => {
        cleanup()
        resolve()
      }
      const onError = (error: Error) => {
        cleanup()
        reject(error)
      }
      const onAbort = () => {
        cleanup()
        resolve()
      }
      output.once('drain', onDrain)
      output.once('error', onError)
      replayCancellation.signal.addEventListener('abort', onAbort, {
        once: true,
      })
      if (replayCancellation.signal.aborted) {
        onAbort()
      }
    })
  }

  async function replay() {
    stdout.pause()
    stderr.pause()
    for (const { output, data } of buffered) {
      if (replayCancellation.signal.aborted) {
        break
      }
      if (!output.write(data)) {
        await waitForDrain(output)
      }
    }
    buffered = []
    bufferedBytes = 0
    buffering = false
    stdout.resume()
    stderr.resume()
  }

  child.on('message', (message: unknown) => {
    if (prompt || closed || typeof message !== 'object' || message === null) {
      return
    }
    const reminder = Reflect.get(message, 'upgradePromptReminder') as
      | UpgradeReminder
      | undefined
    if (
      !reminder ||
      (reminder.policy !== 'security' &&
        reminder.policy !== 'latest' &&
        reminder.policy !== 'future')
    ) {
      return
    }
    controller = new AbortController()
    buffering = true
    prompt = (async () => {
      let action: UpgradeAction
      try {
        action = await nudgeUpgradeForHuman(
          directory,
          reminder,
          controller.signal
        )
      } catch (error) {
        console.error(error)
        action = 'skip'
      }
      if (!closed && (action === 'interrupt' || action === 'update')) {
        onAction(action, reminder.policy)
        buffered = []
        bufferedBytes = 0
        buffering = false
        return
      }
      await replay()
      if (!closed) {
        onAction(action, reminder.policy)
      }
    })().catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  })

  child.once('exit', () => {
    if (!keepPromptOnExit) {
      closed = true
      controller?.abort()
    }
  })

  return {
    cancel() {
      closed = true
      controller?.abort()
      replayCancellation.abort()
    },
    async waitForPrompt() {
      await prompt
    },
  }
}
