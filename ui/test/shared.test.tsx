import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/preact'
import {
  StatusBadge,
  AttentionBadge,
  getStatusColors,
  getAttentionBorder,
  formatRelativeTime,
  STATUS_CONFIG,
  ATTENTION_CONFIG,
} from '../src/components/shared'
import type { MinionSession } from '../src/types'

function makeSession(overrides: Partial<MinionSession> = {}): MinionSession {
  return {
    id: 'session-1',
    slug: 'bold-meadow',
    status: 'running',
    command: '/task Add feature',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    childIds: [],
    needsAttention: false,
    attentionReasons: [],
    quickActions: [],
    mode: 'task',
    conversation: [],
    ...overrides,
  }
}

describe('StatusBadge', () => {
  beforeEach(() => {
    cleanup()
    delete (window as { Telegram?: unknown }).Telegram
  })

  it('renders running status', () => {
    render(<StatusBadge status="running" />)
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('renders pending status', () => {
    render(<StatusBadge status="pending" />)
    expect(screen.getByText('Idle')).toBeTruthy()
  })

  it('renders completed status', () => {
    render(<StatusBadge status="completed" />)
    expect(screen.getByText('Done')).toBeTruthy()
  })

  it('renders failed status', () => {
    render(<StatusBadge status="failed" />)
    expect(screen.getByText('Failed')).toBeTruthy()
  })

  it('renders skipped status', () => {
    render(<StatusBadge status="skipped" />)
    expect(screen.getByText('Skipped')).toBeTruthy()
  })

  it('renders emoji for each status', () => {
    for (const [status, config] of Object.entries(STATUS_CONFIG)) {
      cleanup()
      render(<StatusBadge status={status as keyof typeof STATUS_CONFIG} />)
      expect(screen.getByText(config.emoji)).toBeTruthy()
      expect(screen.getByText(config.label)).toBeTruthy()
    }
  })
})

describe('AttentionBadge', () => {
  beforeEach(() => {
    cleanup()
  })

  it('renders failed attention reason', () => {
    render(<AttentionBadge reason="failed" darkMode={false} />)
    expect(screen.getByText('Failed')).toBeTruthy()
  })

  it('renders waiting_for_feedback attention reason', () => {
    render(<AttentionBadge reason="waiting_for_feedback" darkMode={false} />)
    expect(screen.getByText('Waiting for reply')).toBeTruthy()
  })

  it('renders interrupted attention reason', () => {
    render(<AttentionBadge reason="interrupted" darkMode={false} />)
    expect(screen.getByText('Interrupted')).toBeTruthy()
  })

  it('renders ci_fix attention reason', () => {
    render(<AttentionBadge reason="ci_fix" darkMode={false} />)
    expect(screen.getByText('CI fix in progress')).toBeTruthy()
  })

  it('renders idle_long attention reason', () => {
    render(<AttentionBadge reason="idle_long" darkMode={false} />)
    expect(screen.getByText('Idle for a while')).toBeTruthy()
  })

  it('renders emoji for each attention reason', () => {
    for (const [reason, config] of Object.entries(ATTENTION_CONFIG)) {
      cleanup()
      render(<AttentionBadge reason={reason as keyof typeof ATTENTION_CONFIG} darkMode={false} />)
      expect(screen.getByText(config.emoji)).toBeTruthy()
    }
  })
})

describe('getStatusColors', () => {
  it('returns light mode colors', () => {
    const colors = getStatusColors(false)
    expect(colors.pending.bg).toBe('#f3f4f6')
    expect(colors.running.border).toBe('#3b82f6')
    expect(colors.completed.text).toBe('#166534')
    expect(colors.failed.bg).toBe('#fee2e2')
    expect(colors.skipped.border).toBe('#a8a29e')
  })

  it('returns dark mode colors', () => {
    const colors = getStatusColors(true)
    expect(colors.pending.bg).toBe('#374151')
    expect(colors.running.border).toBe('#3b82f6')
    expect(colors.completed.text).toBe('#86efac')
    expect(colors.failed.bg).toBe('#7f1d1d')
    expect(colors.skipped.border).toBe('#78716c')
  })

  it('covers all five statuses', () => {
    const colors = getStatusColors(false)
    expect(Object.keys(colors)).toEqual(['pending', 'running', 'completed', 'failed', 'skipped'])
  })

  it('each status has bg, border, and text', () => {
    for (const isDark of [true, false]) {
      const colors = getStatusColors(isDark)
      for (const status of Object.values(colors)) {
        expect(status).toHaveProperty('bg')
        expect(status).toHaveProperty('border')
        expect(status).toHaveProperty('text')
      }
    }
  })
})

describe('getAttentionBorder', () => {
  it('returns empty string when not needing attention', () => {
    const session = makeSession({ needsAttention: false })
    expect(getAttentionBorder(session, false)).toBe('')
  })

  it('returns red ring for failed attention', () => {
    const session = makeSession({ needsAttention: true, attentionReasons: ['failed'] })
    expect(getAttentionBorder(session, false)).toBe('ring-2 ring-red-400/60')
    expect(getAttentionBorder(session, true)).toBe('ring-2 ring-red-500/60')
  })

  it('returns yellow ring for waiting_for_feedback attention', () => {
    const session = makeSession({ needsAttention: true, attentionReasons: ['waiting_for_feedback'] })
    expect(getAttentionBorder(session, false)).toBe('ring-2 ring-yellow-400/60')
    expect(getAttentionBorder(session, true)).toBe('ring-2 ring-yellow-500/60')
  })

  it('returns orange ring for interrupted attention', () => {
    const session = makeSession({ needsAttention: true, attentionReasons: ['interrupted'] })
    expect(getAttentionBorder(session, false)).toBe('ring-2 ring-orange-400/60')
    expect(getAttentionBorder(session, true)).toBe('ring-2 ring-orange-500/60')
  })

  it('returns empty string for ci_fix and idle_long attention', () => {
    const session = makeSession({ needsAttention: true, attentionReasons: ['ci_fix'] })
    expect(getAttentionBorder(session, false)).toBe('')
  })

  it('prioritizes failed over waiting_for_feedback', () => {
    const session = makeSession({ needsAttention: true, attentionReasons: ['waiting_for_feedback', 'failed'] })
    expect(getAttentionBorder(session, false)).toBe('ring-2 ring-red-400/60')
  })
})

describe('formatRelativeTime', () => {
  it('returns "just now" for recent timestamps', () => {
    const now = new Date().toISOString()
    expect(formatRelativeTime(now)).toBe('just now')
  })

  it('returns minutes ago for timestamps within the hour', () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60000).toISOString()
    expect(formatRelativeTime(fiveMinutesAgo)).toBe('5m ago')
  })

  it('returns hours ago for timestamps within the day', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString()
    expect(formatRelativeTime(twoHoursAgo)).toBe('2h ago')
  })

  it('returns days ago for timestamps within the week', () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString()
    expect(formatRelativeTime(threeDaysAgo)).toBe('3d ago')
  })

  it('returns locale date string for timestamps older than a week', () => {
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000)
    const result = formatRelativeTime(twoWeeksAgo.toISOString())
    expect(result).toBe(twoWeeksAgo.toLocaleDateString())
  })
})
