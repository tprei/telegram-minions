import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessions, dags, isLoading, error, loadSessions, loadDags, refresh } from '../src/store'
import { fetchSessions, fetchDags } from '../src/api'
import type { MinionSession, DagGraph } from '../src/types'

import { signal } from '@preact/signals'

vi.mock('../src/api', () => ({
  fetchSessions: vi.fn(),
  fetchDags: vi.fn(),
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
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    sessions.value = []
    dags.value = []
    isLoading.value = false
    error.value = null
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
})
