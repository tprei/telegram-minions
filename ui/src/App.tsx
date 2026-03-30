import { useSignalEffect } from '@preact/signals'
import {
  sessions,
  dags,
  isLoading,
  error,
  refresh,
  sendReply,
  stopMinion,
  closeSession,
  startSse,
  stopSse,
  sseConnected,
  actionState,
  clearActionError,
} from './store'
import { UniverseCanvas } from './components/UniverseCanvas'
import { useTelegram, useMainButton } from './hooks'
import { openTelegramLink } from './telegram'
import type { MinionSession } from './types'

function handleOpenThread(session: MinionSession) {
  if (session.threadId && session.chatId) {
    const threadUrl = `https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`
    openTelegramLink(threadUrl)
  }
}

function ErrorMessage() {
  if (!error.value) return null

  const tg = useTelegram()

  return (
    <div
      class={`p-4 rounded mb-4 ${tg.darkMode ? 'bg-red-900/30 border border-red-700 text-red-200' : 'bg-red-100 border border-red-400 text-red-700'}`}
    >
      {error.value}
    </div>
  )
}

function ActionError() {
  if (!actionState.value.error) return null

  const tg = useTelegram()

  return (
    <div
      class={`px-4 py-3 rounded mb-4 flex items-center justify-between ${tg.darkMode ? 'bg-orange-900/30 border border-orange-700 text-orange-200' : 'bg-orange-100 border border-orange-400 text-orange-700'}`}
    >
      <span>{actionState.value.error}</span>
      <button
        onClick={clearActionError}
        class={`font-medium hover:opacity-80 ${tg.darkMode ? 'text-orange-200' : 'text-orange-700'}`}
      >
        Dismiss
      </button>
    </div>
  )
}

function RefreshButton() {
  const tg = useTelegram()
  const buttonColor = tg.isTelegram ? tg.theme.buttonColor : undefined

  return (
    <button
      onClick={() => refresh()}
      disabled={isLoading.value}
      class="px-4 py-2 rounded font-medium disabled:opacity-50 transition-colors"
      style={tg.isTelegram ? { backgroundColor: buttonColor, color: tg.theme.buttonTextColor } : undefined}
    >
      {isLoading.value ? 'Refreshing...' : 'Refresh'}
    </button>
  )
}

function ConnectionStatus() {
  const tg = useTelegram()
  const dotColor = sseConnected.value ? 'bg-green-500' : 'bg-gray-400'
  const textColor = tg.darkMode ? 'text-gray-400' : undefined

  return (
    <div class={`flex items-center gap-2 text-xs ${tg.darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
      <span class={`w-2 h-2 rounded-full ${dotColor}`} />
      <span style={textColor}>{sseConnected.value ? 'Live' : 'Offline'}</span>
    </div>
  )
}

function Header() {
  const tg = useTelegram()
  const textColor = tg.darkMode ? 'text-white' : 'text-gray-900'

  return (
    <header class="flex items-center justify-between mb-6">
      <h1 class={`text-xl font-bold ${textColor}`}>Minions Dashboard</h1>
      <div class="flex items-center gap-4">
        <ConnectionStatus />
        <RefreshButton />
      </div>
    </header>
  )
}

function MainButtonHandler() {
  // Show main button when there are active sessions to manage
  const activeSessions = sessions.value.filter((s) => s.status === 'running' || s.status === 'pending')
  const hasActive = activeSessions.length > 0

  useMainButton(
    hasActive ? 'Refresh' : '',
    () => {
      refresh()
    },
    [hasActive]
  )

  return null
}

export default function App() {
  const tg = useTelegram()

  useSignalEffect(() => {
    refresh()
    startSse()
  })

  // Cleanup SSE on unmount
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', stopSse)
  }

  return (
    <div class={`min-h-screen p-4 ${tg.darkMode ? 'bg-gray-900' : 'bg-white'}`}>
      <MainButtonHandler />
      <Header />

      <ErrorMessage />
      <ActionError />

      <UniverseCanvas
        sessions={sessions.value}
        dags={dags.value}
        isLoading={isLoading.value}
        onSendReply={sendReply}
        onStopMinion={stopMinion}
        onCloseSession={closeSession}
        onOpenThread={handleOpenThread}
        isActionLoading={actionState.value.isLoading}
      />
    </div>
  )
}
