import { useCallback, useEffect } from 'preact/hooks'
import { useTelegram } from '../hooks'

interface ConfirmDialogProps {
  isOpen: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: 'danger' | 'primary'
  isLoading?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  isLoading = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const tg = useTelegram()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel()
      } else if (e.key === 'Enter' && !isLoading) {
        onConfirm()
      }
    },
    [onCancel, onConfirm, isLoading]
  )

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown)
      return () => document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, handleKeyDown])

  if (!isOpen) return null

  const confirmButtonClass =
    confirmVariant === 'danger'
      ? tg.darkMode
        ? 'bg-red-600 text-white hover:bg-red-700'
        : 'bg-red-500 text-white hover:bg-red-600'
      : tg.darkMode
        ? 'bg-blue-600 text-white hover:bg-blue-700'
        : 'bg-blue-500 text-white hover:bg-blue-600'

  const overlayBg = tg.darkMode ? 'bg-black/70' : 'bg-black/50'
  const dialogBg = tg.darkMode ? 'bg-gray-800' : 'bg-white'
  const titleColor = tg.darkMode ? 'text-white' : 'text-gray-900'
  const messageColor = tg.darkMode ? 'text-gray-300' : 'text-gray-600'
  const cancelColor = tg.darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100'

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <div class={`absolute inset-0 ${overlayBg}`} onClick={onCancel} />
      <div
        class={`relative ${dialogBg} rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <h3 id="dialog-title" class={`text-lg font-semibold ${titleColor} mb-2`}>
          {title}
        </h3>
        <p class={`text-sm ${messageColor} mb-4`}>{message}</p>
        <div class="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isLoading}
            class={`px-4 py-2 text-sm font-medium rounded transition-colors disabled:opacity-50 ${cancelColor}`}
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            disabled={isLoading}
            class={`px-4 py-2 text-sm font-medium rounded transition-colors disabled:opacity-50 ${confirmButtonClass}`}
          >
            {isLoading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

interface ReplyDialogProps {
  isOpen: boolean
  sessionId: string
  isLoading?: boolean
  onSend: (sessionId: string, message: string) => void
  onCancel: () => void
}

export function ReplyDialog({ isOpen, sessionId, isLoading, onSend, onCancel }: ReplyDialogProps) {
  const tg = useTelegram()

  const handleSubmit = useCallback(
    (e: Event) => {
      e.preventDefault()
      const form = e.target as HTMLFormElement
      const input = form.elements.namedItem('message') as HTMLInputElement
      const message = input.value.trim()
      if (message) {
        onSend(sessionId, message)
      }
    },
    [sessionId, onSend]
  )

  if (!isOpen) return null

  const overlayBg = tg.darkMode ? 'bg-black/70' : 'bg-black/50'
  const dialogBg = tg.darkMode ? 'bg-gray-800' : 'bg-white'
  const titleColor = tg.darkMode ? 'text-white' : 'text-gray-900'
  const hintColor = tg.darkMode ? 'text-gray-400' : 'text-gray-500'
  const inputBg = tg.darkMode ? 'bg-gray-700 border-gray-600' : 'bg-gray-50 border-gray-300'
  const inputText = tg.darkMode ? 'text-white' : 'text-gray-900'
  const cancelColor = tg.darkMode ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100'
  const buttonBg = tg.isTelegram ? tg.theme.buttonColor : tg.darkMode ? 'bg-blue-600' : 'bg-blue-500'
  const buttonText = tg.isTelegram ? tg.theme.buttonTextColor : 'text-white'

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <div class={`absolute inset-0 ${overlayBg}`} onClick={onCancel} />
      <form
        onSubmit={handleSubmit}
        class={`relative ${dialogBg} rounded-lg p-4 max-w-sm w-full mx-4 shadow-xl`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reply-dialog-title"
      >
        <h3 id="reply-dialog-title" class={`text-lg font-semibold ${titleColor} mb-2`}>
          Send Reply
        </h3>
        <p class={`text-xs ${hintColor} mb-3`}>
          Your message will be sent to the minion's Telegram thread.
        </p>
        <textarea
          name="message"
          rows={3}
          placeholder="Enter your message..."
          disabled={isLoading}
          class={`w-full px-3 py-2 text-sm border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 ${inputBg} ${inputText}`}
          autoFocus
        />
        <div class="flex justify-end gap-2 mt-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={isLoading}
            class={`px-4 py-2 text-sm font-medium rounded transition-colors disabled:opacity-50 ${cancelColor}`}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            class="px-4 py-2 text-sm font-medium rounded transition-colors disabled:opacity-50"
            style={tg.isTelegram ? { backgroundColor: buttonBg, color: buttonText } : undefined}
          >
            {isLoading ? 'Sending...' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}
