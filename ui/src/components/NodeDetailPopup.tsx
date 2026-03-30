import { useCallback, useEffect, useRef } from 'preact/hooks'
import type { MinionSession } from '../types'
import { useTelegram } from '../hooks'
import { StatusBadge, AttentionBadge, formatRelativeTime } from './shared'
import { PrLink } from './PrLink'

interface NodeDetailPopupProps {
  session: MinionSession
  onClose: () => void
}

function MetaRow({ label, children, isDark }: { label: string; children: preact.ComponentChildren; isDark: boolean }) {
  return (
    <div class="flex items-start gap-2 text-xs">
      <span class="shrink-0 w-16 font-medium" style={{ color: isDark ? '#9ca3af' : '#6b7280' }}>
        {label}
      </span>
      <span class="min-w-0 flex-1" style={{ color: isDark ? '#e5e7eb' : '#374151' }}>
        {children}
      </span>
    </div>
  )
}

export function NodeDetailPopup({ session, onClose }: NodeDetailPopupProps) {
  const tg = useTelegram()
  const isDark = tg.darkMode
  const popupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const hasThread = Boolean(session.threadId && session.chatId)

  const handleOpenThread = useCallback(() => {
    if (session.threadId && session.chatId) {
      const threadUrl = `https://t.me/c/${String(session.chatId).replace(/^-100/, '')}/${session.threadId}`
      tg.navigation.openTgLink(threadUrl)
    }
  }, [session, tg.navigation])

  const handleOpenPr = useCallback(() => {
    if (session.prUrl) {
      tg.navigation.openExternalLink(session.prUrl)
    }
  }, [session.prUrl, tg.navigation])

  const overlayBg = isDark ? 'bg-black/70' : 'bg-black/50'
  const dialogBg = isDark ? 'bg-gray-800' : 'bg-white'
  const titleColor = isDark ? 'text-white' : 'text-gray-900'
  const borderColor = isDark ? 'border-gray-700' : 'border-gray-200'
  const secondaryBg = isDark ? 'bg-gray-700/50' : 'bg-gray-50'
  const mutedText = isDark ? 'text-gray-400' : 'text-gray-500'

  const truncatedPrompt = session.command.length > 200
    ? session.command.slice(0, 200) + '...'
    : session.command

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center">
      <div class={`absolute inset-0 ${overlayBg}`} onClick={onClose} />
      <div
        ref={popupRef}
        class={`relative ${dialogBg} rounded-xl max-w-sm w-full mx-4 shadow-xl overflow-hidden`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-detail-title"
      >
        {/* Header */}
        <div class={`px-4 pt-4 pb-3 border-b ${borderColor}`}>
          <div class="flex items-center justify-between gap-2">
            <h3 id="node-detail-title" class={`text-base font-semibold ${titleColor} truncate`}>
              {session.slug}
            </h3>
            <button
              onClick={onClose}
              class={`shrink-0 w-7 h-7 flex items-center justify-center rounded-full transition-colors ${isDark ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
              aria-label="Close"
            >
              <span class="text-lg leading-none">&times;</span>
            </button>
          </div>
          <div class="flex items-center gap-2 mt-1.5">
            <StatusBadge status={session.status} />
            {session.needsAttention && session.attentionReasons.length > 0 && (
              <AttentionBadge reason={session.attentionReasons[0]} darkMode={isDark} />
            )}
          </div>
        </div>

        {/* Prompt */}
        {session.command && (
          <div class={`px-4 py-3 border-b ${borderColor}`}>
            <div class={`text-[11px] font-medium uppercase tracking-wide mb-1.5 ${mutedText}`}>Prompt</div>
            <div
              class={`text-xs leading-relaxed rounded-lg p-2.5 ${secondaryBg}`}
              style={{ color: isDark ? '#d1d5db' : '#4b5563' }}
            >
              {truncatedPrompt}
            </div>
          </div>
        )}

        {/* Metadata */}
        <div class={`px-4 py-3 border-b ${borderColor} flex flex-col gap-2`}>
          {session.repo && (
            <MetaRow label="Repo" isDark={isDark}>
              <span class="truncate block">{session.repo}</span>
            </MetaRow>
          )}
          {session.branch && (
            <MetaRow label="Branch" isDark={isDark}>
              <span class="truncate block font-mono text-[11px]">{session.branch}</span>
            </MetaRow>
          )}
          {session.prUrl && (
            <MetaRow label="PR" isDark={isDark}>
              <div onClick={(e: Event) => e.stopPropagation()}>
                <PrLink prUrl={session.prUrl} />
              </div>
            </MetaRow>
          )}
          {session.mode && (
            <MetaRow label="Mode" isDark={isDark}>
              {session.mode}
            </MetaRow>
          )}
          <MetaRow label="Created" isDark={isDark}>
            {formatRelativeTime(session.createdAt)}
          </MetaRow>
          <MetaRow label="Updated" isDark={isDark}>
            {formatRelativeTime(session.updatedAt)}
          </MetaRow>
        </div>

        {/* Actions */}
        <div class="px-4 py-3 flex gap-2">
          {hasThread && (
            <button
              onClick={handleOpenThread}
              class={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${isDark ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-blue-500 hover:bg-blue-600 text-white'}`}
            >
              <span>Go to Thread</span>
            </button>
          )}
          {session.prUrl && (
            <button
              onClick={handleOpenPr}
              class={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${isDark ? 'bg-gray-700 hover:bg-gray-600 text-gray-200' : 'bg-gray-100 hover:bg-gray-200 text-gray-800'}`}
            >
              <span>View PR</span>
            </button>
          )}
          {!hasThread && !session.prUrl && (
            <div class={`flex-1 text-center text-sm py-2 ${mutedText}`}>
              No actions available
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
