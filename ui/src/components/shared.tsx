import type { AttentionReason, MinionSession, DagNode } from '../types'
import { useTelegram } from '../hooks'

export type StatusType = MinionSession['status'] | 'skipped'

export const STATUS_CONFIG: Record<StatusType, { emoji: string; label: string; className: string; darkClassName: string }> = {
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
  skipped: {
    emoji: '⏭️',
    label: 'Skipped',
    className: 'bg-stone-100 text-stone-700',
    darkClassName: 'bg-stone-800/50 text-stone-400',
  },
}

interface StatusBadgeProps {
  status: StatusType
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

export const ATTENTION_CONFIG: Record<AttentionReason, { emoji: string; label: string; className: string; darkClassName: string }> = {
  failed: {
    emoji: '🔴',
    label: 'Failed',
    className: 'bg-red-100 text-red-700',
    darkClassName: 'bg-red-900/50 text-red-300',
  },
  waiting_for_feedback: {
    emoji: '💬',
    label: 'Waiting for reply',
    className: 'bg-yellow-100 text-yellow-700',
    darkClassName: 'bg-yellow-900/50 text-yellow-300',
  },
  interrupted: {
    emoji: '⚠️',
    label: 'Interrupted',
    className: 'bg-orange-100 text-orange-700',
    darkClassName: 'bg-orange-900/50 text-orange-300',
  },
  ci_fix: {
    emoji: '🔧',
    label: 'CI fix in progress',
    className: 'bg-purple-100 text-purple-700',
    darkClassName: 'bg-purple-900/50 text-purple-300',
  },
  idle_long: {
    emoji: '⏳',
    label: 'Idle for a while',
    className: 'bg-gray-100 text-gray-600',
    darkClassName: 'bg-gray-700 text-gray-400',
  },
}

interface AttentionBadgeProps {
  reason: AttentionReason
  darkMode: boolean
}

export function AttentionBadge({ reason, darkMode }: AttentionBadgeProps) {
  const config = ATTENTION_CONFIG[reason]
  const className = darkMode ? config.darkClassName : config.className

  return (
    <span class={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>
      <span>{config.emoji}</span>
      <span>{config.label}</span>
    </span>
  )
}

type DagNodeStatus = DagNode['status']

export function getStatusColors(isDark: boolean): Record<DagNodeStatus, { bg: string; border: string; text: string }> {
  if (isDark) {
    return {
      pending: { bg: '#374151', border: '#6b7280', text: '#e5e7eb' },
      running: { bg: '#1e3a5f', border: '#3b82f6', text: '#93c5fd' },
      completed: { bg: '#064e3b', border: '#22c55e', text: '#86efac' },
      failed: { bg: '#7f1d1d', border: '#ef4444', text: '#fca5a5' },
      skipped: { bg: '#292524', border: '#78716c', text: '#a8a29e' },
    }
  }
  return {
    pending: { bg: '#f3f4f6', border: '#9ca3af', text: '#374151' },
    running: { bg: '#dbeafe', border: '#3b82f6', text: '#1e40af' },
    completed: { bg: '#dcfce7', border: '#22c55e', text: '#166534' },
    failed: { bg: '#fee2e2', border: '#ef4444', text: '#991b1b' },
    skipped: { bg: '#f5f5f4', border: '#a8a29e', text: '#57534e' },
  }
}

export function getAttentionBorder(session: MinionSession, darkMode: boolean): string {
  if (!session.needsAttention) return ''

  if (session.attentionReasons.includes('failed')) {
    return darkMode ? 'ring-2 ring-red-500/60' : 'ring-2 ring-red-400/60'
  }
  if (session.attentionReasons.includes('waiting_for_feedback')) {
    return darkMode ? 'ring-2 ring-yellow-500/60' : 'ring-2 ring-yellow-400/60'
  }
  if (session.attentionReasons.includes('interrupted')) {
    return darkMode ? 'ring-2 ring-orange-500/60' : 'ring-2 ring-orange-400/60'
  }
  return ''
}

export function formatRelativeTime(dateString: string): string {
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
