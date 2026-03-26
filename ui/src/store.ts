import { signal } from '@preact/signals'
import type { ActionState, DagGraph, MinionSession, PlanActionType, SseEvent } from './types'
import {
  fetchDags,
  fetchSessions,
  sendReply as apiSendReply,
  stopMinion as apiStopMinion,
  closeSession as apiCloseSession,
  executeAction as apiExecuteAction,
  createSseConnection,
} from './api'

export const sessions = signal<MinionSession[]>([])
export const dags = signal<DagGraph[]>([])
export const isLoading = signal(false)
export const error = signal<string | null>(null)
export const actionState = signal<ActionState>({
  isLoading: false,
  error: null,
  lastAction: null,
})
export const sseConnected = signal(false)

let sseConnection: EventSource | null = null
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAY_MS = 3000

export async function loadSessions() {
  try {
    isLoading.value = true
    error.value = null
    sessions.value = await fetchSessions()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load sessions'
  } finally {
    isLoading.value = false
  }
}

export async function loadDags() {
  try {
    isLoading.value = true
    error.value = null
    dags.value = await fetchDags()
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Failed to load DAGs'
  } finally {
    isLoading.value = false
  }
}

export async function refresh() {
  await Promise.all([loadSessions(), loadDags()])
}

// Command actions with retry logic
async function withRetry<T>(
  action: () => Promise<T>,
  actionName: string,
  maxRetries = 3
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      actionState.value = { isLoading: true, error: null, lastAction: actionName }
      const result = await action()
      actionState.value = { isLoading: false, error: null, lastAction: actionName }
      return result
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
      }
    }
  }

  const errorMsg = lastError?.message || `${actionName} failed`
  actionState.value = { isLoading: false, error: errorMsg, lastAction: actionName }
  throw lastError
}

export async function sendReply(sessionId: string, message: string): Promise<void> {
  await withRetry(() => apiSendReply(sessionId, message), 'sendReply')
}

export async function stopMinion(sessionId: string): Promise<void> {
  await withRetry(() => apiStopMinion(sessionId), 'stopMinion')
}

export async function closeSession(sessionId: string): Promise<void> {
  await withRetry(() => apiCloseSession(sessionId), 'closeSession')
}

export async function planAction(sessionId: string, action: PlanActionType): Promise<void> {
  await withRetry(() => apiExecuteAction(sessionId, action), 'planAction')
}

// SSE handling
function handleSseEvent(event: SseEvent) {
  switch (event.type) {
    case 'session_created':
      sessions.value = [...sessions.value, event.session]
      break
    case 'session_updated': {
      const idx = sessions.value.findIndex((s) => s.id === event.session.id)
      if (idx !== -1) {
        const updated = [...sessions.value]
        updated[idx] = event.session
        sessions.value = updated
      }
      break
    }
    case 'session_deleted':
      sessions.value = sessions.value.filter((s) => s.id !== event.sessionId)
      break
    case 'dag_created':
      dags.value = [...dags.value, event.dag]
      break
    case 'dag_updated': {
      const idx = dags.value.findIndex((d) => d.id === event.dag.id)
      if (idx !== -1) {
        const updated = [...dags.value]
        updated[idx] = event.dag
        dags.value = updated
      }
      break
    }
    case 'dag_deleted':
      dags.value = dags.value.filter((d) => d.id !== event.dagId)
      break
  }
}

function connectSse() {
  if (sseConnection) {
    sseConnection.close()
  }

  sseConnection = createSseConnection(handleSseEvent)

  if (sseConnection) {
    sseConnection.onopen = () => {
      sseConnected.value = true
      reconnectAttempts = 0
    }

    sseConnection.onerror = () => {
      sseConnected.value = false

      if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++
        setTimeout(connectSse, RECONNECT_DELAY_MS * reconnectAttempts)
      }
    }
  }
}

export function startSse() {
  if (!sseConnection) {
    connectSse()
  }
}

export function stopSse() {
  if (sseConnection) {
    sseConnection.close()
    sseConnection = null
    sseConnected.value = false
  }
}

export function clearActionError() {
  actionState.value = { ...actionState.value, error: null }
}
