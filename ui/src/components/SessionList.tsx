import { useState, useCallback } from 'preact/hooks'
import type { MinionSession, QuickAction } from '../types'
import { ConfirmDialog, ReplyDialog } from './ConfirmDialog'
import { PrLink } from './PrLink'
import { useTelegram, usePopup as useTelegramPopup } from '../hooks'
import { StatusBadge, AttentionBadge, formatRelativeTime, getAttentionBorder } from './shared'

export { StatusBadge, AttentionBadge }

const QUICK_ACTION_STYLE: Record<QuickAction['type'], { emoji: string; className: string; darkClassName: string }> = {
  make_pr: {
    emoji: '🔀',
    className: 'bg-green-100 text-green-700 hover:bg-green-200',
    darkClassName: 'bg-green-900/50 text-green-300 hover:bg-green-800/50',
  },
  retry: {
    emoji: '🔄',
    className: 'bg-blue-100 text-blue-700 hover:bg-blue-200',
    darkClassName: 'bg-blue-900/50 text-blue-300 hover:bg-blue-800/50',
  },
  resume: {
    emoji: '▶️',
    className: 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200',
    darkClassName: 'bg-indigo-900/50 text-indigo-300 hover:bg-indigo-800/50',
  },
}

interface QuickActionButtonProps {
  action: QuickAction
  darkMode: boolean
  disabled: boolean
  onExecute: (message: string) => void
}

function QuickActionButton({ action, darkMode, disabled, onExecute }: QuickActionButtonProps) {
  const style = QUICK_ACTION_STYLE[action.type]
  const className = darkMode ? style.darkClassName : style.className

  const handleClick = useCallback(
    (e: Event) => {
      e.stopPropagation()
      onExecute(action.message)
    },
    [action.message, onExecute],
  )

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      class={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-50 ${className}`}
      title={action.message}
    >
      <span>{style.emoji}</span>
      <span>{action.label}</span>
    </button>
  )
}

interface SessionCardProps {
  session: MinionSession
  onThreadClick?: (session: MinionSession) => void
  onSendReply?: (sessionId: string, message: string) => Promise<void>
  onStopMinion?: (sessionId: string) => Promise<void>
  onCloseSession?: (sessionId: string) => Promise<void>
  isActionLoading?: boolean
}

export function SessionCard({
  session,
  onThreadClick,
  onSendReply,
  onStopMinion,
  onCloseSession,
  isActionLoading = false,
}: SessionCardProps) {
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [showReplyDialog, setShowReplyDialog] = useState(false)
  const tg = useTelegram()
  const telegramConfirm = useTelegramPopup()

  const cardBg = tg.darkMode ? 'bg-gray-800' : 'bg-gray-50'
  const textColor = tg.darkMode ? 'text-white' : 'text-gray-900'
  const hintColor = tg.darkMode ? 'text-gray-400' : 'text-gray-500'

  const handleCardClick = useCallback(() => {
    if (onThreadClick) {
      onThreadClick(session)
    } else if (session.threadId && session.chatId) {
      const threadUrl = `https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`
      tg.navigation.openTgLink(threadUrl)
    }
  }, [session, onThreadClick, tg.navigation])

  const handleStopClick = useCallback(async (e: Event) => {
    e.stopPropagation()
    if (tg.isTelegram) {
      const confirmed = await telegramConfirm.destructive(
        'Are you sure you want to stop this minion? Any in-progress work will be interrupted.',
        'Stop Minion',
        'Stop'
      )
      if (confirmed && onStopMinion) {
        await onStopMinion(session.id)
      }
    } else {
      setShowStopConfirm(true)
    }
  }, [session.id, onStopMinion, tg.isTelegram, telegramConfirm])

  const handleCloseClick = useCallback(async (e: Event) => {
    e.stopPropagation()
    if (tg.isTelegram) {
      const confirmed = await telegramConfirm.destructive(
        'Are you sure you want to close this session? This will terminate the minion and clean up resources.',
        'Close Session',
        'Close'
      )
      if (confirmed && onCloseSession) {
        await onCloseSession(session.id)
      }
    } else {
      setShowCloseConfirm(true)
    }
  }, [session.id, onCloseSession, tg.isTelegram, telegramConfirm])

  const handleReplyClick = useCallback((e: Event) => {
    e.stopPropagation()
    setShowReplyDialog(true)
  }, [])

  const handleConfirmStop = useCallback(async () => {
    if (onStopMinion) {
      await onStopMinion(session.id)
      setShowStopConfirm(false)
    }
  }, [session.id, onStopMinion])

  const handleConfirmClose = useCallback(async () => {
    if (onCloseSession) {
      await onCloseSession(session.id)
      setShowCloseConfirm(false)
    }
  }, [session.id, onCloseSession])

  const handleSendReply = useCallback(
    async (sessionId: string, message: string) => {
      if (onSendReply) {
        await onSendReply(sessionId, message)
        setShowReplyDialog(false)
      }
    },
    [onSendReply]
  )

  const isActive = session.status === 'running' || session.status === 'pending'
  const isClickable = Boolean(session.threadId && session.chatId)

  const attentionBorder = getAttentionBorder(session, tg.darkMode)

  return (
    <>
      <div
        class={`rounded-lg p-4 mb-3 ${cardBg} ${attentionBorder} ${isClickable ? 'cursor-pointer hover:opacity-90 transition-opacity active:scale-[0.98]' : ''}`}
        onClick={isClickable ? handleCardClick : undefined}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
      >
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2">
            <h3 class={`font-semibold ${textColor}`}>{session.slug}</h3>
            {session.threadId && (
              <span class={`text-xs font-mono ${hintColor}`}>#{session.threadId}</span>
            )}
          </div>
          <StatusBadge status={session.status} />
        </div>

        <p class={`text-sm mb-2 line-clamp-2 ${hintColor}`}>{session.command}</p>

        {session.needsAttention && session.attentionReasons.length > 0 && (
          <div class="flex flex-wrap gap-1 mb-2">
            {session.attentionReasons.map((reason) => (
              <AttentionBadge key={reason} reason={reason} darkMode={tg.darkMode} />
            ))}
          </div>
        )}

        <div class={`flex items-center justify-between text-xs ${hintColor}`}>
          <div class="flex items-center gap-2">
            {session.repo && (
              <span class="truncate max-w-[180px]">{session.repo.split('/').slice(-2).join('/')}</span>
            )}
            {session.branch && (
              <span class={`px-1.5 py-0.5 rounded ${tg.darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
                {session.branch}
              </span>
            )}
          </div>
          <span>{formatRelativeTime(session.updatedAt)}</span>
        </div>

        {session.prUrl && (
          <div class="mt-2">
            <PrLink prUrl={session.prUrl} />
          </div>
        )}

        {session.childIds.length > 0 && (
          <div class={`mt-2 text-xs ${hintColor}`}>
            {session.childIds.length} child{session.childIds.length > 1 ? 'ren' : ''}
          </div>
        )}

        {session.quickActions && session.quickActions.length > 0 && onSendReply && (
          <div class={`flex flex-wrap gap-2 mt-3 pt-3 border-t ${tg.darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            {session.quickActions.map((action) => (
              <QuickActionButton
                key={action.type}
                action={action}
                darkMode={tg.darkMode}
                disabled={isActionLoading}
                onExecute={(message) => {
                  onSendReply(session.id, message)
                }}
              />
            ))}
          </div>
        )}

        {/* Action buttons for active sessions */}
        {isActive && (onSendReply || onStopMinion || onCloseSession) && (
          <div class={`flex gap-2 mt-3 pt-3 border-t ${tg.darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            {onSendReply && (
              <button
                onClick={handleReplyClick}
                disabled={isActionLoading}
                class="flex-1 px-3 py-1.5 text-xs font-medium rounded transition-opacity disabled:opacity-50"
                style={tg.isTelegram ? { backgroundColor: tg.theme.buttonColor, color: tg.theme.buttonTextColor } : undefined}
                title="Send a reply to the minion thread"
              >
                Reply
              </button>
            )}
            {onStopMinion && session.status === 'running' && (
              <button
                onClick={handleStopClick}
                disabled={isActionLoading}
                class={`px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-50 ${tg.darkMode ? 'bg-orange-900/50 text-orange-300 hover:bg-orange-800/50' : 'bg-orange-100 text-orange-700 hover:bg-orange-200'}`}
                title="Stop the running minion"
              >
                Stop
              </button>
            )}
            {onCloseSession && (
              <button
                onClick={handleCloseClick}
                disabled={isActionLoading}
                class={`px-3 py-1.5 text-xs font-medium rounded transition-colors disabled:opacity-50 ${tg.darkMode ? 'bg-red-900/50 text-red-300 hover:bg-red-800/50' : 'bg-red-100 text-red-700 hover:bg-red-200'}`}
                title="Close this session"
              >
                Close
              </button>
            )}
          </div>
        )}
      </div>

      {/* Confirmation dialogs - only shown outside Telegram */}
      <ConfirmDialog
        isOpen={showStopConfirm}
        title="Stop Minion"
        message="Are you sure you want to stop this minion? Any in-progress work will be interrupted."
        confirmLabel="Stop"
        confirmVariant="danger"
        isLoading={isActionLoading}
        onConfirm={handleConfirmStop}
        onCancel={() => setShowStopConfirm(false)}
      />

      <ConfirmDialog
        isOpen={showCloseConfirm}
        title="Close Session"
        message="Are you sure you want to close this session? This will terminate the minion and clean up resources."
        confirmLabel="Close"
        confirmVariant="danger"
        isLoading={isActionLoading}
        onConfirm={handleConfirmClose}
        onCancel={() => setShowCloseConfirm(false)}
      />

      <ReplyDialog
        isOpen={showReplyDialog}
        sessionId={session.id}
        isLoading={isActionLoading}
        onSend={handleSendReply}
        onCancel={() => setShowReplyDialog(false)}
      />
    </>
  )
}

interface SessionListProps {
  sessions: MinionSession[]
  isLoading: boolean
  onThreadClick?: (session: MinionSession) => void
  onSendReply?: (sessionId: string, message: string) => Promise<void>
  onStopMinion?: (sessionId: string) => Promise<void>
  onCloseSession?: (sessionId: string) => Promise<void>
  isActionLoading?: boolean
}

export function SessionList({
  sessions,
  isLoading,
  onThreadClick,
  onSendReply,
  onStopMinion,
  onCloseSession,
  isActionLoading = false,
}: SessionListProps) {
  const tg = useTelegram()
  const hintColor = tg.darkMode ? 'text-gray-400' : 'text-gray-500'

  if (isLoading && sessions.length === 0) {
    return (
      <div class="text-center py-8">
        <div class={`animate-pulse ${hintColor}`}>Loading sessions...</div>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div class="text-center py-8">
        <div class={hintColor}>No active minions</div>
        <div class={`text-xs mt-1 ${hintColor}`}>Start a task with /task or /plan</div>
      </div>
    )
  }

  const attentionSessions = sessions.filter((s) => s.needsAttention)
  const activeSessions = sessions.filter((s) => (s.status === 'running' || s.status === 'pending') && !s.needsAttention)
  const completedSessions = sessions.filter((s) => (s.status === 'completed' || s.status === 'failed') && !s.needsAttention)

  const sectionLabelColor = tg.darkMode ? 'text-gray-400' : 'text-gray-500'
  const attentionLabelColor = tg.darkMode ? 'text-yellow-400' : 'text-yellow-600'

  return (
    <div>
      {attentionSessions.length > 0 && (
        <section class="mb-6">
          <h3 class={`text-sm font-medium mb-3 uppercase tracking-wide ${attentionLabelColor}`}>
            Needs attention ({attentionSessions.length})
          </h3>
          {attentionSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onThreadClick={onThreadClick}
              onSendReply={onSendReply}
              onStopMinion={onStopMinion}
              onCloseSession={onCloseSession}
              isActionLoading={isActionLoading}
            />
          ))}
        </section>
      )}

      {activeSessions.length > 0 && (
        <section class="mb-6">
          <h3 class={`text-sm font-medium mb-3 uppercase tracking-wide ${sectionLabelColor}`}>
            Active ({activeSessions.length})
          </h3>
          {activeSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onThreadClick={onThreadClick}
              onSendReply={onSendReply}
              onStopMinion={onStopMinion}
              onCloseSession={onCloseSession}
              isActionLoading={isActionLoading}
            />
          ))}
        </section>
      )}

      {completedSessions.length > 0 && (
        <section>
          <h3 class={`text-sm font-medium mb-3 uppercase tracking-wide ${sectionLabelColor}`}>
            Recent ({completedSessions.length})
          </h3>
          {completedSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              onThreadClick={onThreadClick}
              onCloseSession={onCloseSession}
              isActionLoading={isActionLoading}
            />
          ))}
        </section>
      )}
    </div>
  )
}
