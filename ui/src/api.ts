import type { ApiResponse, DagGraph, MinionSession } from './types'

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
