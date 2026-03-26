import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  sessions,
  dags,
  isLoading,
  error,
  actionState,
  sseConnected,
  loadSessions,
  loadDags,
  refresh,
  sendReply,
  stopMinion,
  closeSession,
  planAction,
  clearActionError,
} from '../src/store'
import {
  fetchSessions,
  fetchDags,
  sendReply as apiSendReply,
  stopMinion as apiStopMinion,
  closeSession as apiCloseSession,
  executeAction as apiExecuteAction,
} from '../src/api'
import type { MinionSession, DagGraph, CommandResult } from '../src/types'

vi.mock('../src/api', () => ({
  fetchSessions: vi.fn(),
  fetchDags: vi.fn(),
  sendReply: vi.fn(),
  stopMinion: vi.fn(),
  closeSession: vi.fn(),
  executeAction: vi.fn(),
  createSseConnection: vi.fn(),
}))

describe('Store', () => {
  const mockSessions: MinionSession[] = [
    {
      id: 'session-1',
      slug: 'bold-meadow',
      status: 'running',
      command: '/task Add feature',
      repo: 'https://github.com/org/repo',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      childIds: [],
    },
  ]

  const mockDags: DagGraph[] = [
    {
      id: 'dag-1',
      rootTaskId: 'task-1',
      nodes: {},
      status: 'pending',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    sessions.value = []
    dags.value = []
    isLoading.value = false
    error.value = null
    actionState.value = { isLoading: false, error: null, lastAction: null }
    sseConnected.value = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('loadSessions', () => {
    it('should load sessions successfully', async () => {
      ;(fetchSessions as ReturnType<typeof vi.fn>).mockResolvedValue(mockSessions)

      await loadSessions()
      expect(sessions.value).toEqual(mockSessions)
      expect(isLoading.value).toBe(false)
      expect(error.value).toBe(null)
    })

    it('should handle errors', async () => {
      const errorMsg = 'Network error'
      ;(fetchSessions as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(errorMsg))
      await loadSessions()
      expect(error.value).toBe(errorMsg)
      expect(isLoading.value).toBe(false)
    })
  })

  describe('loadDags', () => {
    it('should load dags successfully', async () => {
      ;(fetchDags as ReturnType<typeof vi.fn>).mockResolvedValue(mockDags)
      await loadDags()
      expect(dags.value).toEqual(mockDags)
      expect(isLoading.value).toBe(false)
      expect(error.value).toBe(null)
    })

    it('should handle errors', async () => {
      const errorMsg = 'Failed to load DAGs'
      ;(fetchDags as ReturnType<typeof vi.fn>).mockRejectedValue(new Error(errorMsg))
      await loadDags()
      expect(error.value).toBe(errorMsg)
      expect(isLoading.value).toBe(false)
    })
  })

  describe('refresh', () => {
    it('should load both sessions and dags', async () => {
      ;(fetchSessions as ReturnType<typeof vi.fn>).mockResolvedValue(mockSessions)
      ;(fetchDags as ReturnType<typeof vi.fn>).mockResolvedValue(mockDags)
      await refresh()
      expect(sessions.value).toEqual(mockSessions)
      expect(dags.value).toEqual(mockDags)
    })
  })

  describe('sendReply', () => {
    it('should send reply successfully', async () => {
      const mockResult: CommandResult = { success: true }
      ;(apiSendReply as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult)

      await sendReply('session-1', 'Hello!')

      expect(apiSendReply).toHaveBeenCalledWith('session-1', 'Hello!')
      expect(actionState.value.isLoading).toBe(false)
      expect(actionState.value.lastAction).toBe('sendReply')
    })

    it('should handle errors with retry', async () => {
      ;(apiSendReply as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Network error'))

      await expect(sendReply('session-1', 'Hello!')).rejects.toThrow('Network error')
      expect(actionState.value.error).toBe('Network error')
    })
  })

  describe('stopMinion', () => {
    it('should stop minion successfully', async () => {
      const mockResult: CommandResult = { success: true }
      ;(apiStopMinion as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult)

      await stopMinion('session-1')

      expect(apiStopMinion).toHaveBeenCalledWith('session-1')
      expect(actionState.value.isLoading).toBe(false)
      expect(actionState.value.lastAction).toBe('stopMinion')
    })

    it('should handle errors', async () => {
      ;(apiStopMinion as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Forbidden'))

      await expect(stopMinion('session-1')).rejects.toThrow('Forbidden')
      expect(actionState.value.error).toBe('Forbidden')
    })
  })

  describe('closeSession', () => {
    it('should close session successfully', async () => {
      const mockResult: CommandResult = { success: true }
      ;(apiCloseSession as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult)

      await closeSession('session-1')

      expect(apiCloseSession).toHaveBeenCalledWith('session-1')
      expect(actionState.value.isLoading).toBe(false)
      expect(actionState.value.lastAction).toBe('closeSession')
    })

    it('should handle errors', async () => {
      ;(apiCloseSession as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Not found'))

      await expect(closeSession('session-1')).rejects.toThrow('Not found')
      expect(actionState.value.error).toBe('Not found')
    })
  })

  describe('planAction', () => {
    it('should execute plan action successfully', async () => {
      const mockResult: CommandResult = { success: true }
      ;(apiExecuteAction as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult)

      await planAction('session-1', 'execute')

      expect(apiExecuteAction).toHaveBeenCalledWith('session-1', 'execute')
      expect(actionState.value.isLoading).toBe(false)
      expect(actionState.value.lastAction).toBe('planAction')
    })

    it('should pass action type through to API', async () => {
      const mockResult: CommandResult = { success: true }
      ;(apiExecuteAction as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult)

      await planAction('session-2', 'dag')

      expect(apiExecuteAction).toHaveBeenCalledWith('session-2', 'dag')
    })

    it('should handle errors', async () => {
      ;(apiExecuteAction as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Session not found'))

      await expect(planAction('session-1', 'split')).rejects.toThrow('Session not found')
      expect(actionState.value.error).toBe('Session not found')
    })
  })

  describe('clearActionError', () => {
    it('should clear action error', () => {
      actionState.value = { isLoading: false, error: 'Some error', lastAction: 'sendReply' }
      clearActionError()
      expect(actionState.value.error).toBe(null)
    })
  })
})
