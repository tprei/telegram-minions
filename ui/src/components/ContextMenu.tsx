import { useState, useCallback, useEffect, useRef } from 'preact/hooks'
import type { MinionSession, QuickAction } from '../types'
import { useTelegram, usePopup as useTelegramPopup } from '../hooks'
import { ConfirmDialog, ReplyDialog } from './ConfirmDialog'

export interface ContextMenuPosition {
  x: number
  y: number
}

export interface ContextMenuActions {
  onSendReply: (sessionId: string, message: string) => Promise<void>
  onStopMinion: (sessionId: string) => Promise<void>
  onCloseSession: (sessionId: string) => Promise<void>
  onOpenThread: (session: MinionSession) => void
  isActionLoading: boolean
}

interface ContextMenuProps {
  session: MinionSession
  position: ContextMenuPosition
  actions: ContextMenuActions
  onClose: () => void
}

interface MenuItemConfig {
  label: string
  emoji: string
  variant: 'default' | 'danger' | 'primary'
  onClick: () => void
  disabled?: boolean
}

const MENU_WIDTH = 200
const MENU_ITEM_HEIGHT = 40
const MENU_PADDING = 8
const MENU_DIVIDER_HEIGHT = 9

function clampPosition(
  x: number,
  y: number,
  menuHeight: number
): ContextMenuPosition {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return {
    x: Math.min(x, vw - MENU_WIDTH - 8),
    y: Math.min(y, vh - menuHeight - 8),
  }
}

export function ContextMenu({ session, position, actions, onClose }: ContextMenuProps) {
  const tg = useTelegram()
  const telegramPopup = useTelegramPopup()
  const [showReplyDialog, setShowReplyDialog] = useState(false)
  const [showStopConfirm, setShowStopConfirm] = useState(false)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const isActive = session.status === 'running' || session.status === 'pending'
  const isRunning = session.status === 'running'
  const hasThread = Boolean(session.threadId && session.chatId)

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  const handleOpenThread = useCallback(() => {
    actions.onOpenThread(session)
    onClose()
  }, [session, actions, onClose])

  const handleReplyClick = useCallback(() => {
    onClose()
    setShowReplyDialog(true)
  }, [onClose])

  const handleStopClick = useCallback(async () => {
    onClose()
    if (tg.isTelegram) {
      const confirmed = await telegramPopup.destructive(
        'Are you sure you want to stop this minion? Any in-progress work will be interrupted.',
        'Stop Minion',
        'Stop'
      )
      if (confirmed) {
        await actions.onStopMinion(session.id)
      }
    } else {
      setShowStopConfirm(true)
    }
  }, [session.id, actions, tg.isTelegram, telegramPopup, onClose])

  const handleCloseClick = useCallback(async () => {
    onClose()
    if (tg.isTelegram) {
      const confirmed = await telegramPopup.destructive(
        'Are you sure you want to close this session? This will terminate the minion and clean up resources.',
        'Close Session',
        'Close'
      )
      if (confirmed) {
        await actions.onCloseSession(session.id)
      }
    } else {
      setShowCloseConfirm(true)
    }
  }, [session.id, actions, tg.isTelegram, telegramPopup, onClose])

  const handleQuickAction = useCallback(
    (action: QuickAction) => {
      onClose()
      actions.onSendReply(session.id, action.message)
    },
    [session.id, actions, onClose]
  )

  const handleConfirmStop = useCallback(async () => {
    await actions.onStopMinion(session.id)
    setShowStopConfirm(false)
  }, [session.id, actions])

  const handleConfirmClose = useCallback(async () => {
    await actions.onCloseSession(session.id)
    setShowCloseConfirm(false)
  }, [session.id, actions])

  const handleSendReply = useCallback(
    async (sessionId: string, message: string) => {
      await actions.onSendReply(sessionId, message)
      setShowReplyDialog(false)
    },
    [actions]
  )

  const items: (MenuItemConfig | 'divider')[] = []

  if (hasThread) {
    items.push({
      label: 'Open in Telegram',
      emoji: '💬',
      variant: 'default',
      onClick: handleOpenThread,
    })
  }

  if (isActive) {
    items.push({
      label: 'Send Reply',
      emoji: '✉️',
      variant: 'primary',
      onClick: handleReplyClick,
    })
  }

  if (session.quickActions && session.quickActions.length > 0 && isActive) {
    if (items.length > 0) items.push('divider')
    for (const action of session.quickActions) {
      const quickActionEmoji: Record<string, string> = {
        make_pr: '🔀',
        retry: '🔄',
        resume: '▶️',
      }
      items.push({
        label: action.label,
        emoji: quickActionEmoji[action.type] || '⚡',
        variant: 'default',
        onClick: () => handleQuickAction(action),
        disabled: actions.isActionLoading,
      })
    }
  }

  if (isRunning || isActive) {
    if (items.length > 0) items.push('divider')
    if (isRunning) {
      items.push({
        label: 'Stop Minion',
        emoji: '⏹',
        variant: 'danger',
        onClick: handleStopClick,
        disabled: actions.isActionLoading,
      })
    }
    items.push({
      label: 'Close Session',
      emoji: '✕',
      variant: 'danger',
      onClick: handleCloseClick,
      disabled: actions.isActionLoading,
    })
  }

  const itemCount = items.filter((i) => i !== 'divider').length
  const dividerCount = items.filter((i) => i === 'divider').length
  const menuHeight = itemCount * MENU_ITEM_HEIGHT + dividerCount * MENU_DIVIDER_HEIGHT + MENU_PADDING * 2
  const clamped = clampPosition(position.x, position.y, menuHeight)

  const menuBg = tg.darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
  const hoverBg = tg.darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'
  const textColor = tg.darkMode ? 'text-gray-200' : 'text-gray-800'
  const dangerText = tg.darkMode ? 'text-red-400' : 'text-red-600'
  const primaryText = tg.darkMode ? 'text-blue-400' : 'text-blue-600'
  const dividerColor = tg.darkMode ? 'border-gray-700' : 'border-gray-200'

  return (
    <>
      {items.length > 0 && (
        <div
          ref={menuRef}
          class={`fixed z-50 rounded-lg border shadow-xl py-1 ${menuBg}`}
          style={{
            left: `${clamped.x}px`,
            top: `${clamped.y}px`,
            width: `${MENU_WIDTH}px`,
          }}
          role="menu"
          aria-label={`Actions for ${session.slug}`}
        >
          {items.map((item, idx) => {
            if (item === 'divider') {
              return <div key={`div-${idx}`} class={`border-t my-1 ${dividerColor}`} role="separator" />
            }
            const colorClass =
              item.variant === 'danger' ? dangerText : item.variant === 'primary' ? primaryText : textColor
            return (
              <button
                key={item.label}
                onClick={item.onClick}
                disabled={item.disabled}
                class={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors disabled:opacity-50 ${hoverBg} ${colorClass}`}
                role="menuitem"
              >
                <span class="w-5 text-center">{item.emoji}</span>
                <span>{item.label}</span>
              </button>
            )
          })}
        </div>
      )}

      <ConfirmDialog
        isOpen={showStopConfirm}
        title="Stop Minion"
        message="Are you sure you want to stop this minion? Any in-progress work will be interrupted."
        confirmLabel="Stop"
        confirmVariant="danger"
        isLoading={actions.isActionLoading}
        onConfirm={handleConfirmStop}
        onCancel={() => setShowStopConfirm(false)}
      />

      <ConfirmDialog
        isOpen={showCloseConfirm}
        title="Close Session"
        message="Are you sure you want to close this session? This will terminate the minion and clean up resources."
        confirmLabel="Close"
        confirmVariant="danger"
        isLoading={actions.isActionLoading}
        onConfirm={handleConfirmClose}
        onCancel={() => setShowCloseConfirm(false)}
      />

      <ReplyDialog
        isOpen={showReplyDialog}
        sessionId={session.id}
        isLoading={actions.isActionLoading}
        onSend={handleSendReply}
        onCancel={() => setShowReplyDialog(false)}
      />
    </>
  )
}

const LONG_PRESS_DURATION = 500

export function useLongPress(
  onLongPress: (position: ContextMenuPosition) => void,
  onContextMenu: (position: ContextMenuPosition) => void
): {
  onTouchStart: (e: TouchEvent) => void
  onTouchEnd: () => void
  onTouchMove: () => void
  onContextMenu: (e: MouseEvent) => void
} {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const touchPosRef = useRef<ContextMenuPosition | null>(null)
  const triggeredRef = useRef(false)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      triggeredRef.current = false
      const touch = e.touches[0]
      touchPosRef.current = { x: touch.clientX, y: touch.clientY }
      timerRef.current = setTimeout(() => {
        if (touchPosRef.current) {
          triggeredRef.current = true
          e.preventDefault()
          if (navigator.vibrate) {
            navigator.vibrate(50)
          }
          onLongPress(touchPosRef.current)
        }
      }, LONG_PRESS_DURATION)
    },
    [onLongPress]
  )

  const handleTouchEnd = useCallback(() => {
    clearTimer()
  }, [clearTimer])

  const handleTouchMove = useCallback(() => {
    clearTimer()
    touchPosRef.current = null
  }, [clearTimer])

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault()
      onContextMenu({ x: e.clientX, y: e.clientY })
    },
    [onContextMenu]
  )

  useEffect(() => {
    return clearTimer
  }, [clearTimer])

  return {
    onTouchStart: handleTouchStart,
    onTouchEnd: handleTouchEnd,
    onTouchMove: handleTouchMove,
    onContextMenu: handleContextMenu,
  }
}

export interface ContextMenuState {
  session: MinionSession | null
  position: ContextMenuPosition | null
}

export function useContextMenu(): {
  state: ContextMenuState
  open: (session: MinionSession, position: ContextMenuPosition) => void
  close: () => void
} {
  const [state, setState] = useState<ContextMenuState>({
    session: null,
    position: null,
  })

  const open = useCallback((session: MinionSession, position: ContextMenuPosition) => {
    setState({ session, position })
  }, [])

  const close = useCallback(() => {
    setState({ session: null, position: null })
  }, [])

  return { state, open, close }
}
