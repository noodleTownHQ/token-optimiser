import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

/** The engine beneath the mod: just enough of it to start a session. */
export const world = (on: On, files: Record<string, string>, written: Record<string, string>) => {
  mock.store(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', ($, e) => ({ value: files[e.path] ?? '' }))
  on('fs.write', ($, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('session.cwd', () => ({ value: '/repo' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__token-optimiser__${e.name}` } }))
  on('agent.register', ($, e) => ({ value: { agent: `token-optimiser:${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
}

export const START = { cwd: '/repo', surface: null, isInteractive: true } as const
