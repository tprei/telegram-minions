import { useCallback, useEffect } from 'preact/hooks'
import type { MinionSession, PlanActionType } from '../types'
import { useTelegram } from '../hooks'

interface SessionReadoutModalProps {
  session: MinionSession
  isActionLoading: boolean
  onAction: (action: PlanActionType) => void
  onClose: () => void
}

const PLAN_ACTIONS: { action: PlanActionType; label: string; emoji: string }[] = [
  { action: 'execute', label: 'Execute', emoji: '▶️' },
  { action: 'split', label: 'Split', emoji: '🔀' },
  { action: 'stack', label: 'Stack', emoji: '📚' },
  { action: 'dag', label: 'DAG', emoji: '🔗' },
]

export function SessionReadoutModal({
  session,
  isActionLoading,
  onAction,
  onClose,
}: SessionReadoutModalProps) {
  const tg = useTelegram()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
    },
    [onClose],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const overlayBg = tg.darkMode ? 'bg-black/70' : 'bg-black/50'
  const dialogBg = tg.darkMode ? 'bg-gray-800' : 'bg-white'
  const titleColor = tg.darkMode ? 'text-white' : 'text-gray-900'
  const hintColor = tg.darkMode ? 'text-gray-400' : 'text-gray-500'
  const borderColor = tg.darkMode ? 'border-gray-700' : 'border-gray-200'
  const userBubbleBg = tg.darkMode ? 'bg-blue-900/40' : 'bg-blue-50'
  const assistantBubbleBg = tg.darkMode ? 'bg-gray-700' : 'bg-gray-100'
  const messageText = tg.darkMode ? 'text-gray-200' : 'text-gray-800'
  const roleColor = tg.darkMode ? 'text-gray-400' : 'text-gray-500'
  const cancelColor = tg.darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100'
  const actionBg = tg.darkMode
    ? 'bg-blue-600 text-white hover:bg-blue-700'
    : 'bg-blue-500 text-white hover:bg-blue-600'

  const hasConversation = session.conversation && session.conversation.length > 0

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <div class={`absolute inset-0 ${overlayBg}`} onClick={onClose} />
      <div
        class={`relative ${dialogBg} rounded-lg max-w-lg w-full mx-4 shadow-xl flex flex-col`}
        style={{ maxHeight: '85vh' }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="readout-title"
      >
        <div class={`p-4 border-b ${borderColor} flex-shrink-0`}>
          <div class="flex items-center justify-between">
            <h3 id="readout-title" class={`text-lg font-semibold ${titleColor}`}>
              {session.slug}
            </h3>
            <button
              onClick={onClose}
              class={`p-1 rounded transition-colors ${cancelColor}`}
              aria-label="Close"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 5l10 10M15 5l-10 10" />
              </svg>
            </button>
          </div>
          <p class={`text-xs mt-1 ${hintColor}`}>
            {session.mode} session
          </p>
        </div>

        <div class="flex-1 overflow-y-auto p-4" style={{ maxHeight: '60vh' }}>
          {hasConversation ? (
            <div class="space-y-3">
              {session.conversation.map((msg, i) => {
                const isUser = msg.role === 'user'
                const bubbleBg = isUser ? userBubbleBg : assistantBubbleBg
                return (
                  <div key={i} class={`rounded-lg p-3 ${bubbleBg}`}>
                    <div class={`text-xs font-medium mb-1 ${roleColor}`}>
                      {isUser ? 'You' : 'Assistant'}
                    </div>
                    <div class={`text-sm whitespace-pre-wrap break-words ${messageText}`}>
                      {msg.text}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <div class={`text-center py-8 ${hintColor}`}>
              No messages yet
            </div>
          )}
        </div>

        <div class={`p-4 border-t ${borderColor} flex-shrink-0`}>
          <div class="grid grid-cols-4 gap-2">
            {PLAN_ACTIONS.map(({ action, label, emoji }) => (
              <button
                key={action}
                onClick={() => onAction(action)}
                disabled={isActionLoading}
                class={`flex flex-col items-center gap-1 px-2 py-2 text-xs font-medium rounded transition-colors disabled:opacity-50 ${actionBg}`}
              >
                <span>{emoji}</span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
