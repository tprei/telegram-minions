import { useState, useCallback } from 'preact/hooks'
import type { MinionSession } from '../types'
import { ConfirmDialog, ReplyDialog } from './ConfirmDialog'
import { useTelegram, usePopup as useTelegramPopup } from '../hooks'

type StatusType = MinionSession['status']

interface StatusBadgeProps {
  status: StatusType
}

const STATUS_CONFIG: Record<StatusType, { emoji: string; label: string; className: string; darkClassName: string }> = {
  pending: {
    emoji: '💬',
    label: 'Idle',
    className: 'bg-gray-100 text-gray-700',
    darkClassName: 'bg-gray-700 text-gray-300',
  },
  running: {
    emoji: '⚡',
    label: 'Running',
    className: 'bg-blue-100 text-blue-700',
    darkClassName: 'bg-blue-900/50 text-blue-300',
  },
  completed: {
    emoji: '✅',
    label: 'Done',
    className: 'bg-green-100 text-green-700',
    darkClassName: 'bg-green-900/50 text-green-300',
  },
  failed: {
    emoji: '❌',
    label: 'Failed',
    className: 'bg-red-100 text-red-700',
    darkClassName: 'bg-red-900/50 text-red-300',
  },
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const tg = useTelegram()
  const config = STATUS_CONFIG[status]
  const className = tg.darkMode ? config.darkClassName : config.className

  return (
    <span class={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${className}`}>
      <span>{config.emoji}</span>
      <span>{config.label}</span>
    </span>
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

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)

  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
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
      const threadUrl = `https://t.me/c/${Math.abs(session.chatId)}/${session.threadId}`
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
    async (_sessionId: string, message: string) => {
      if (onSendReply) {
        await onSendReply(session.id, message)
        setShowReplyDialog(false)
      }
    },
    [session.id, onSendReply]
  )

  const isActive = session.status === 'running' || session.status === 'pending'
  const isClickable = Boolean(session.threadId && session.chatId)

  return (
    <>
      <div
        class={`rounded-lg p-4 mb-3 ${cardBg} ${isClickable ? 'cursor-pointer hover:opacity-90 transition-opacity active:scale-[0.98]' : ''}`}
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
          <a
            href={session.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            class={`text-xs underline mt-2 block hover:opacity-80 ${tg.darkMode ? 'text-blue-400' : 'text-blue-600'}`}
            onClick={(e) => e.stopPropagation()}
          >
            View PR
          </a>
        )}

        {session.childIds.length > 0 && (
          <div class={`mt-2 text-xs ${hintColor}`}>
            {session.childIds.length} child{session.childIds.length > 1 ? 'ren' : ''}
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

  const activeSessions = sessions.filter((s) => s.status === 'running' || s.status === 'pending')
  const completedSessions = sessions.filter((s) => s.status === 'completed' || s.status === 'failed')

  const sectionLabelColor = tg.darkMode ? 'text-gray-400' : 'text-gray-500'

  return (
    <div>
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
