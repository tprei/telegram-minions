import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fetchSessions,
  fetchDags,
  fetchSession,
  fetchDag,
  sendReply,
  stopMinion,
  closeSession,
  executeAction,
  API_BASE,
} from '../src/api'
import type { ApiResponse, CommandResult } from '../src/types'

describe('API Client', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
    vi.clearAllMocks()
  })

  describe('fetchSessions', () => {
    it('should fetch sessions successfully', async () => {
      const mockSessions = [
        {
          id: 'session-1',
          slug: 'bold-meadow',
          status: 'running',
          command: '/task Add feature',
          repo: 'https://github.com/org/repo',
          branch: 'feature-branch',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
          childIds: [],
        },
      ]

      const mockResponse: ApiResponse<typeof mockSessions> = {
        data: mockSessions,
      }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await fetchSessions()

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/sessions`)
      expect(result).toEqual(mockSessions)
    })

    it('should throw on API error', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        statusText: 'Internal Server Error',
      })

      await expect(fetchSessions()).rejects.toThrow('Failed to fetch sessions: Internal Server Error')
    })
  })

  describe('fetchSession', () => {
    it('should fetch a single session', async () => {
      const mockSession = {
        id: 'session-1',
        slug: 'bold-meadow',
        status: 'completed',
        command: '/task Fix bug',
        repo: 'https://github.com/org/repo',
        branch: 'fix-bug',
        prUrl: 'https://github.com/org/repo/pull/123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        childIds: [],
      }

      const mockResponse: ApiResponse<typeof mockSession> = {
        data: mockSession,
      }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await fetchSession('session-1')

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/sessions/session-1`)
      expect(result).toEqual(mockSession)
    })

    it('should throw on not found error', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
      })

      await expect(fetchSession('nonexistent')).rejects.toThrow('Failed to fetch session nonexistent: Not Found')
    })
  })

  describe('fetchDags', () => {
    it('should fetch dags successfully', async () => {
      const mockDags = [
        {
          id: 'dag-1',
          rootTaskId: 'task-1',
          nodes: {},
          status: 'pending',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
      ]

      const mockResponse: ApiResponse<typeof mockDags> = {
        data: mockDags,
      }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await fetchDags()

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/dags`)
      expect(result).toEqual(mockDags)
    })

    it('should throw on API error', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        statusText: 'Bad Gateway',
      })

      await expect(fetchDags()).rejects.toThrow('Failed to fetch DAGs: Bad Gateway')
    })
  })

  describe('fetchDag', () => {
    it('should fetch a single dag', async () => {
      const mockDag = {
        id: 'dag-1',
        rootTaskId: 'task-1',
        status: 'running',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        nodes: {
          'node-1': {
            id: 'node-1',
            slug: 'calm-lake',
            status: 'completed',
            dependencies: [],
            dependents: ['node-2'],
          },
          'node-2': {
            id: 'node-2',
            slug: 'keen-peak',
            status: 'running',
            dependencies: ['node-1'],
            dependents: [],
          },
        },
      }

      const mockResponse: ApiResponse<typeof mockDag> = {
        data: mockDag,
      }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const result = await fetchDag('dag-1')

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/dags/dag-1`)
      expect(result).toEqual(mockDag)
    })
  })

  describe('sendReply', () => {
    it('should send a reply successfully', async () => {
      const mockResult: CommandResult = { success: true }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResult),
      })

      const result = await sendReply('session-1', 'Hello minion!')

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reply', sessionId: 'session-1', message: 'Hello minion!' }),
      })
      expect(result).toEqual(mockResult)
    })

    it('should throw on API error', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
      })

      await expect(sendReply('session-1', 'Hello')).rejects.toThrow('Failed to send reply: Bad Request')
    })
  })

  describe('stopMinion', () => {
    it('should stop a minion successfully', async () => {
      const mockResult: CommandResult = { success: true }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResult),
      })

      const result = await stopMinion('session-1')

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', sessionId: 'session-1' }),
      })
      expect(result).toEqual(mockResult)
    })

    it('should throw on API error', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        statusText: 'Forbidden',
      })

      await expect(stopMinion('session-1')).rejects.toThrow('Failed to stop minion: Forbidden')
    })
  })

  describe('closeSession', () => {
    it('should close a session successfully', async () => {
      const mockResult: CommandResult = { success: true }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResult),
      })

      const result = await closeSession('session-1')

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'close', sessionId: 'session-1' }),
      })
      expect(result).toEqual(mockResult)
    })

    it('should throw on API error', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        statusText: 'Not Found',
      })

      await expect(closeSession('session-1')).rejects.toThrow('Failed to close session: Not Found')
    })
  })

  describe('executeAction', () => {
    it('should execute a plan action successfully', async () => {
      const mockResult: CommandResult = { success: true }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResult),
      })

      const result = await executeAction('session-1', 'execute')

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/sessions/session-1/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'execute' }),
      })
      expect(result).toEqual(mockResult)
    })

    it('should pass different action types correctly', async () => {
      const mockResult: CommandResult = { success: true }

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResult),
      })

      await executeAction('session-2', 'split')

      expect(global.fetch).toHaveBeenCalledWith(`${API_BASE}/sessions/session-2/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'split' }),
      })
    })

    it('should throw on API error', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        statusText: 'Bad Request',
      })

      await expect(executeAction('session-1', 'execute')).rejects.toThrow('Failed to execute execute: Bad Request')
    })
  })
})
