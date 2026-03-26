import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/preact'
import { SessionReadoutModal } from '../src/components/SessionReadoutModal'
import type { MinionSession, PlanActionType } from '../src/types'

function makeSession(overrides: Partial<MinionSession> = {}): MinionSession {
  return {
    id: 'session-1',
    slug: 'bold-meadow',
    status: 'running',
    command: '/plan Add feature',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    childIds: [],
    needsAttention: true,
    attentionReasons: ['waiting_for_feedback'],
    quickActions: [],
    mode: 'plan',
    conversation: [
      { role: 'user', text: 'Let us work on feature A' },
      { role: 'assistant', text: 'Here is my proposed plan for feature A.' },
    ],
    ...overrides,
  }
}

describe('SessionReadoutModal', () => {
  const mockOnAction = vi.fn()
  const mockOnClose = vi.fn()

  beforeEach(() => {
    mockOnAction.mockClear()
    mockOnClose.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders session slug as title', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    expect(screen.getByText('bold-meadow')).toBeTruthy()
  })

  it('renders session mode label', () => {
    render(
      <SessionReadoutModal
        session={makeSession({ mode: 'think' })}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    expect(screen.getByText('think session')).toBeTruthy()
  })

  it('renders conversation messages', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    expect(screen.getByText('Let us work on feature A')).toBeTruthy()
    expect(screen.getByText('Here is my proposed plan for feature A.')).toBeTruthy()
  })

  it('labels user and assistant messages', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    expect(screen.getByText('You')).toBeTruthy()
    expect(screen.getByText('Assistant')).toBeTruthy()
  })

  it('shows placeholder when conversation is empty', () => {
    render(
      <SessionReadoutModal
        session={makeSession({ conversation: [] })}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    expect(screen.getByText('No messages yet')).toBeTruthy()
  })

  it('renders all four action buttons', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    expect(screen.getByText('Execute')).toBeTruthy()
    expect(screen.getByText('Split')).toBeTruthy()
    expect(screen.getByText('Stack')).toBeTruthy()
    expect(screen.getByText('DAG')).toBeTruthy()
  })

  it('calls onAction with correct action type when buttons are clicked', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    const actions: PlanActionType[] = ['execute', 'split', 'stack', 'dag']
    const labels = ['Execute', 'Split', 'Stack', 'DAG']

    labels.forEach((label, i) => {
      fireEvent.click(screen.getByText(label))
      expect(mockOnAction).toHaveBeenLastCalledWith(actions[i])
    })

    expect(mockOnAction).toHaveBeenCalledTimes(4)
  })

  it('disables action buttons when isActionLoading is true', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={true}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    const executeButton = screen.getByText('Execute').closest('button')!
    expect(executeButton.hasAttribute('disabled')).toBe(true)

    const splitButton = screen.getByText('Split').closest('button')!
    expect(splitButton.hasAttribute('disabled')).toBe(true)
  })

  it('calls onClose when backdrop is clicked', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    const backdrop = document.querySelector('.absolute.inset-0')
    if (backdrop) {
      fireEvent.click(backdrop)
      expect(mockOnClose).toHaveBeenCalledTimes(1)
    }
  })

  it('calls onClose when Escape key is pressed', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockOnClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when close button is clicked', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    const closeButton = screen.getByLabelText('Close')
    fireEvent.click(closeButton)
    expect(mockOnClose).toHaveBeenCalledTimes(1)
  })

  it('has dialog role and aria attributes', () => {
    render(
      <SessionReadoutModal
        session={makeSession()}
        isActionLoading={false}
        onAction={mockOnAction}
        onClose={mockOnClose}
      />,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-labelledby')).toBe('readout-title')
  })
})
