import { useSignalEffect } from '@preact/signals'
import { sessions, isLoading, error, refresh } from './store'
import type { MinionSession } from './types'

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    running: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    skipped: 'bg-gray-100 text-gray-800',
  }
  return (
    <span class={`px-2 py-1 rounded text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-800'}`}>
      {status}
    </span>
  )
}

function SessionCard({ session }: { session: MinionSession }) {
  return (
    <div class="bg-telegram-secondary rounded-lg p-4 mb-3">
      <div class="flex items-center justify-between mb-2">
        <h3 class="font-semibold text-telegram-text">{session.slug}</h3>
        <StatusBadge status={session.status} />
      </div>
      <p class="text-sm text-telegram-hint mb-2 line-clamp-2">{session.command}</p>
      {session.repo && (
        <p class="text-xs text-telegram-link">{session.repo}</p>
      )}
      {session.prUrl && (
        <a
          href={session.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs text-telegram-link underline mt-1 block"
        >
          View PR
        </a>
      )}
    </div>
  )
}

function SessionList() {
  if (isLoading.value && sessions.value.length === 0) {
    return <p class="text-center text-telegram-hint py-8">Loading sessions...</p>
  }

  if (sessions.value.length === 0) {
    return <p class="text-center text-telegram-hint py-8">No active minions</p>
  }

  return (
    <div>
      {sessions.value.map((session) => (
        <SessionCard key={session.id} session={session} />
      ))}
    </div>
  )
}

function ErrorMessage() {
  if (!error.value) return null
  return (
    <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
      {error.value}
    </div>
  )
}

function RefreshButton() {
  return (
    <button
      onClick={() => refresh()}
      disabled={isLoading.value}
      class="bg-telegram-button text-telegram-buttonText px-4 py-2 rounded font-medium disabled:opacity-50"
    >
      {isLoading.value ? 'Refreshing...' : 'Refresh'}
    </button>
  )
}

export default function App() {
  useSignalEffect(() => {
    refresh()
  })

  return (
    <div class="min-h-screen p-4">
      <header class="flex items-center justify-between mb-6">
        <h1 class="text-xl font-bold text-telegram-text">Minions Dashboard</h1>
        <RefreshButton />
      </header>

      <ErrorMessage />

      <section>
        <h2 class="text-lg font-semibold text-telegram-text mb-3">Active Sessions</h2>
        <SessionList />
      </section>
    </div>
  )
}
