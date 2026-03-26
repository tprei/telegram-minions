import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/preact'
import { SessionList, SessionCard, StatusBadge } from '../src/components/SessionList'
import type { MinionSession } from '../src/types'

const mockSession: MinionSession = {
  id: 'session-1',
  slug: 'bold-meadow',
  status: 'running',
  command: '/task Add feature',
  repo: 'https://github.com/org/repo',
  branch: 'feature-branch',
  threadId: 123,
  chatId: -1001234567890,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  childIds: [],
  needsAttention: false,
  attentionReasons: [],
  quickActions: [],
  mode: 'task',
  conversation: [],
}

const mockCompletedSession: MinionSession = {
  id: 'session-2',
  slug: 'calm-lake',
  status: 'completed',
  command: '/task Fix bug',
  repo: 'https://github.com/org/repo',
  prUrl: 'https://github.com/org/repo/pull/42',
  createdAt: new Date(Date.now() - 86400000).toISOString(),
  updatedAt: new Date(Date.now() - 86400000).toISOString(),
  childIds: ['session-3'],
  needsAttention: false,
  attentionReasons: [],
  quickActions: [],
  mode: 'task',
  conversation: [],
}

const mockFailedSession: MinionSession = {
  id: 'session-3',
  slug: 'keen-peak',
  status: 'failed',
  command: '/task Broken task',
  createdAt: new Date(Date.now() - 3600000).toISOString(),
  updatedAt: new Date(Date.now() - 3600000).toISOString(),
  childIds: [],
  needsAttention: false,
  attentionReasons: [],
  quickActions: [],
  mode: 'task',
  conversation: [],
}

const mockPendingSession: MinionSession = {
  id: 'session-4',
  slug: 'swift-river',
  status: 'pending',
  command: '/plan New feature',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  childIds: [],
  needsAttention: false,
  attentionReasons: [],
  quickActions: [],
  mode: 'task',
  conversation: [],
}

const mockPlanPendingSession: MinionSession = {
  id: 'session-5',
  slug: 'fair-fjord',
  status: 'pending',
  command: '/plan Design new API',
  threadId: 456,
  chatId: -1001234567890,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  childIds: [],
  needsAttention: false,
  attentionReasons: [],
  quickActions: [],
  mode: 'plan',
  conversation: [
    { role: 'user', text: 'Design a new API' },
    { role: 'assistant', text: 'Here is my plan...' },
  ],
}

const mockThinkPendingSession: MinionSession = {
  id: 'session-6',
  slug: 'keen-brook',
  status: 'pending',
  command: '/think Analyze architecture',
  threadId: 789,
  chatId: -1001234567890,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  childIds: [],
  needsAttention: false,
  attentionReasons: [],
  quickActions: [],
  mode: 'think',
  conversation: [
    { role: 'user', text: 'Analyze the architecture' },
    { role: 'assistant', text: 'The architecture looks like...' },
  ],
}

describe('StatusBadge', () => {
  beforeEach(() => {
    cleanup()
  })

  it('renders running status with lightning emoji', () => {
    render(<StatusBadge status="running" />)
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('renders pending status with speech bubble emoji', () => {
    render(<StatusBadge status="pending" />)
    expect(screen.getByText('Idle')).toBeTruthy()
  })

  it('renders completed status with checkmark emoji', () => {
    render(<StatusBadge status="completed" />)
    expect(screen.getByText('Done')).toBeTruthy()
  })

  it('renders failed status with x emoji', () => {
    render(<StatusBadge status="failed" />)
    expect(screen.getByText('Failed')).toBeTruthy()
  })
})

describe('SessionCard', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete (window as { Telegram?: unknown }).Telegram
  })

  it('displays session slug and status', () => {
    render(<SessionCard session={mockSession} />)
    expect(screen.getByText('bold-meadow')).toBeTruthy()
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('displays thread ID when available', () => {
    render(<SessionCard session={mockSession} />)
    expect(screen.getByText('#123')).toBeTruthy()
  })

  it('displays command text', () => {
    render(<SessionCard session={mockSession} />)
    expect(screen.getByText('/task Add feature')).toBeTruthy()
  })

  it('displays repo name (owner/repo format)', () => {
    render(<SessionCard session={mockSession} />)
    expect(screen.getByText('org/repo')).toBeTruthy()
  })

  it('displays branch name', () => {
    render(<SessionCard session={mockSession} />)
    expect(screen.getByText('feature-branch')).toBeTruthy()
  })

  it('displays PR link when available', () => {
    render(<SessionCard session={mockCompletedSession} />)
    expect(screen.getByText('org/repo#42')).toBeTruthy()
  })

  it('displays child count for sessions with children', () => {
    render(<SessionCard session={mockCompletedSession} />)
    expect(screen.getByText('1 child')).toBeTruthy()
  })

  it('calls onThreadClick when card is clicked', () => {
    const onThreadClick = vi.fn()
    render(<SessionCard session={mockSession} onThreadClick={onThreadClick} />)

    const card = screen.getByText('bold-meadow').closest('[role="button"]')
    if (card) {
      fireEvent.click(card)
      expect(onThreadClick).toHaveBeenCalledWith(mockSession)
    }
  })

  it('does not render as clickable when no thread info', () => {
    const sessionWithoutThread = { ...mockSession, threadId: undefined, chatId: undefined }
    render(<SessionCard session={sessionWithoutThread} />)

    const clickable = document.querySelector('[role="button"]')
    expect(clickable).toBeNull()
  })

  it('shows action buttons for active sessions', () => {
    render(<SessionCard session={mockSession} onSendReply={vi.fn()} />)
    expect(screen.getByText('Reply')).toBeTruthy()
  })

  it('shows stop button for running sessions', () => {
    render(<SessionCard session={mockSession} onStopMinion={vi.fn()} />)
    expect(screen.getByText('Stop')).toBeTruthy()
  })

  it('shows close button for active sessions', () => {
    render(<SessionCard session={mockSession} onCloseSession={vi.fn()} />)
    expect(screen.getByText('Close')).toBeTruthy()
  })

  it('does not show action buttons for completed sessions', () => {
    render(<SessionCard session={mockCompletedSession} onSendReply={vi.fn()} onStopMinion={vi.fn()} />)
    expect(screen.queryByText('Reply')).toBeNull()
    expect(screen.queryByText('Stop')).toBeNull()
  })
})

describe('SessionList', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('shows loading state when loading with no sessions', () => {
    render(<SessionList sessions={[]} isLoading={true} />)
    expect(screen.getByText('Loading sessions...')).toBeTruthy()
  })

  it('shows empty state when no sessions', () => {
    render(<SessionList sessions={[]} isLoading={false} />)
    expect(screen.getByText('No active minions')).toBeTruthy()
  })

  it('groups sessions into Active and Recent sections', () => {
    const sessions = [mockSession, mockPendingSession, mockCompletedSession]
    render(<SessionList sessions={sessions} isLoading={false} />)

    expect(screen.getByText('Active (2)')).toBeTruthy()
    expect(screen.getByText('Recent (1)')).toBeTruthy()
  })

  it('does not show Active section when no active sessions', () => {
    render(<SessionList sessions={[mockCompletedSession]} isLoading={false} />)
    expect(screen.queryByText(/Active/)).toBeNull()
    expect(screen.getByText(/Recent/)).toBeTruthy()
  })

  it('does not show Recent section when no completed sessions', () => {
    render(<SessionList sessions={[mockSession]} isLoading={false} />)
    expect(screen.getByText(/Active/)).toBeTruthy()
    expect(screen.queryByText(/Recent/)).toBeNull()
  })

  it('passes onThreadClick to session cards', () => {
    const onThreadClick = vi.fn()
    render(<SessionList sessions={[mockSession]} isLoading={false} onThreadClick={onThreadClick} />)

    const card = screen.getByText('bold-meadow').closest('[role="button"]')
    if (card) {
      fireEvent.click(card)
      expect(onThreadClick).toHaveBeenCalledWith(mockSession)
    }
  })

  it('passes action handlers to session cards', () => {
    const onSendReply = vi.fn()
    const onStopMinion = vi.fn()
    const onCloseSession = vi.fn()

    render(
      <SessionList
        sessions={[mockSession]}
        isLoading={false}
        onSendReply={onSendReply}
        onStopMinion={onStopMinion}
        onCloseSession={onCloseSession}
      />
    )

    expect(screen.getByText('Reply')).toBeTruthy()
    expect(screen.getByText('Stop')).toBeTruthy()
    expect(screen.getByText('Close')).toBeTruthy()
  })
})

describe('SessionCard plan action buttons', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    delete (window as { Telegram?: unknown }).Telegram
  })

  it('shows plan action buttons for plan session in pending status', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockPlanPendingSession} onPlanAction={onPlanAction} />)

    expect(screen.getByText('Read session')).toBeTruthy()
    expect(screen.getByText('Execute')).toBeTruthy()
    expect(screen.getByText('Split')).toBeTruthy()
    expect(screen.getByText('Stack')).toBeTruthy()
    expect(screen.getByText('DAG')).toBeTruthy()
  })

  it('shows plan action buttons for think session in pending status', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockThinkPendingSession} onPlanAction={onPlanAction} />)

    expect(screen.getByText('Read session')).toBeTruthy()
    expect(screen.getByText('Execute')).toBeTruthy()
  })

  it('does not show plan action buttons for task sessions', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockPendingSession} onPlanAction={onPlanAction} />)

    expect(screen.queryByText('Read session')).toBeNull()
    expect(screen.queryByText('Execute')).toBeNull()
  })

  it('does not show plan action buttons for running plan sessions', () => {
    const onPlanAction = vi.fn()
    const runningPlan = { ...mockPlanPendingSession, status: 'running' as const }
    render(<SessionCard session={runningPlan} onPlanAction={onPlanAction} />)

    expect(screen.queryByText('Read session')).toBeNull()
  })

  it('does not show plan action buttons when onPlanAction is not provided', () => {
    render(<SessionCard session={mockPlanPendingSession} />)

    expect(screen.queryByText('Read session')).toBeNull()
  })

  it('calls onPlanAction with correct action when Execute is clicked', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockPlanPendingSession} onPlanAction={onPlanAction} />)

    fireEvent.click(screen.getByText('Execute'))
    expect(onPlanAction).toHaveBeenCalledWith('session-5', 'execute')
  })

  it('calls onPlanAction with correct action when Split is clicked', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockPlanPendingSession} onPlanAction={onPlanAction} />)

    fireEvent.click(screen.getByText('Split'))
    expect(onPlanAction).toHaveBeenCalledWith('session-5', 'split')
  })

  it('calls onPlanAction with correct action when Stack is clicked', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockPlanPendingSession} onPlanAction={onPlanAction} />)

    fireEvent.click(screen.getByText('Stack'))
    expect(onPlanAction).toHaveBeenCalledWith('session-5', 'stack')
  })

  it('calls onPlanAction with correct action when DAG is clicked', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockPlanPendingSession} onPlanAction={onPlanAction} />)

    fireEvent.click(screen.getByText('DAG'))
    expect(onPlanAction).toHaveBeenCalledWith('session-5', 'dag')
  })

  it('opens readout modal when Read session is clicked', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockPlanPendingSession} onPlanAction={onPlanAction} />)

    fireEvent.click(screen.getByText('Read session'))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Design a new API')).toBeTruthy()
    expect(screen.getByText('Here is my plan...')).toBeTruthy()
  })

  it('closes readout modal when action is clicked in modal', () => {
    const onPlanAction = vi.fn()
    render(<SessionCard session={mockPlanPendingSession} onPlanAction={onPlanAction} />)

    fireEvent.click(screen.getByText('Read session'))
    expect(screen.getByRole('dialog')).toBeTruthy()

    const modalExecuteButtons = screen.getAllByText('Execute')
    const modalButton = modalExecuteButtons.find(
      (el) => el.closest('[role="dialog"]') !== null
    )
    if (modalButton) {
      fireEvent.click(modalButton)
    }

    expect(onPlanAction).toHaveBeenCalledWith('session-5', 'execute')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('disables plan action buttons when isActionLoading is true', () => {
    const onPlanAction = vi.fn()
    render(
      <SessionCard
        session={mockPlanPendingSession}
        onPlanAction={onPlanAction}
        isActionLoading={true}
      />
    )

    const executeBtn = screen.getByText('Execute').closest('button')
    expect(executeBtn?.disabled).toBe(true)

    const readBtn = screen.getByText('Read session').closest('button')
    expect(readBtn?.disabled).toBe(true)
  })
})
