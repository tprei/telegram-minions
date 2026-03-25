import type { ApiResponse, CommandResult, DagGraph, MinionSession, SseEvent } from './types'

export const API_BASE = '/api'

export async function fetchSessions(): Promise<MinionSession[]> {
  const response = await fetch(`${API_BASE}/sessions`)
  if (!response.ok) {
    throw new Error(`Failed to fetch sessions: ${response.statusText}`)
  }
  const data: ApiResponse<MinionSession[]> = await response.json()
  return data.data
}

export async function fetchSession(id: string): Promise<MinionSession> {
  const response = await fetch(`${API_BASE}/sessions/${id}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch session ${id}: ${response.statusText}`)
  }
  const data: ApiResponse<MinionSession> = await response.json()
  return data.data
}

export async function fetchDags(): Promise<DagGraph[]> {
  const response = await fetch(`${API_BASE}/dags`)
  if (!response.ok) {
    throw new Error(`Failed to fetch DAGs: ${response.statusText}`)
  }
  const data: ApiResponse<DagGraph[]> = await response.json()
  return data.data
}

export async function fetchDag(id: string): Promise<DagGraph> {
  const response = await fetch(`${API_BASE}/dags/${id}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch DAG ${id}: ${response.statusText}`)
  }
  const data: ApiResponse<DagGraph> = await response.json()
  return data.data
}

// Command actions
export async function sendReply(sessionId: string, message: string): Promise<CommandResult> {
  const response = await fetch(`${API_BASE}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reply', sessionId, message }),
  })
  if (!response.ok) {
    throw new Error(`Failed to send reply: ${response.statusText}`)
  }
  return response.json()
}

export async function stopMinion(sessionId: string): Promise<CommandResult> {
  const response = await fetch(`${API_BASE}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop', sessionId }),
  })
  if (!response.ok) {
    throw new Error(`Failed to stop minion: ${response.statusText}`)
  }
  return response.json()
}

export async function closeSession(sessionId: string): Promise<CommandResult> {
  const response = await fetch(`${API_BASE}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'close', sessionId }),
  })
  if (!response.ok) {
    throw new Error(`Failed to close session: ${response.statusText}`)
  }
  return response.json()
}

// SSE connection for real-time updates
export function createSseConnection(onEvent: (event: SseEvent) => void): EventSource | null {
  const eventSource = new EventSource(`${API_BASE}/events`)

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as SseEvent
      onEvent(data)
    } catch {
      console.warn('Failed to parse SSE event:', event.data)
    }
  }

  eventSource.onerror = () => {
    console.warn('SSE connection error')
  }

  return eventSource
}
