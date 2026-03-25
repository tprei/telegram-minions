import { signal } from '@preact/signals'
import type { DagGraph, MinionSession } from './types'
import { fetchDags, fetchSessions } from './api'

export const sessions = signal<MinionSession[]>([])
export const dags = signal<DagGraph[]>([])
export const isLoading = signal(false)
export const error = signal<string | null>(null)

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
