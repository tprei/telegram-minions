import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, cleanup, act } from '@testing-library/preact'
import { ContextMenu, useLongPress, useContextMenu } from '../src/components/ContextMenu'
import type { ContextMenuActions } from '../src/components/ContextMenu'
import type { MinionSession } from '../src/types'
import { renderHook } from '@testing-library/preact'

const mockRunningSession: MinionSession = {
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
  threadId: 456,
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

const mockSessionWithQuickActions: MinionSession = {
  ...mockRunningSession,
  id: 'session-3',
  slug: 'swift-river',
  quickActions: [
    { type: 'make_pr', label: 'Make PR', message: '/make_pr' },
    { type: 'retry', label: 'Retry', message: '/retry' },
  ],
}

const mockPendingSession: MinionSession = {
  ...mockRunningSession,
  id: 'session-4',
  slug: 'quiet-hill',
  status: 'pending',
}

function createMockActions(overrides: Partial<ContextMenuActions> = {}): ContextMenuActions {
  return {
    onSendReply: vi.fn().mockResolvedValue(undefined),
    onStopMinion: vi.fn().mockResolvedValue(undefined),
    onCloseSession: vi.fn().mockResolvedValue(undefined),
    onOpenThread: vi.fn(),
    isActionLoading: false,
    ...overrides,
  }
}

describe('ContextMenu', () => {
  let mockActions: ContextMenuActions
  let mockOnClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockActions = createMockActions()
    mockOnClose = vi.fn()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders menu items for a running session', () => {
    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    expect(screen.getByText('Open in Telegram')).toBeTruthy()
    expect(screen.getByText('Send Reply')).toBeTruthy()
    expect(screen.getByText('Stop Minion')).toBeTruthy()
    expect(screen.getByText('Close Session')).toBeTruthy()
  })

  it('renders only Open in Telegram and Close for completed sessions', () => {
    render(
      <ContextMenu
        session={mockCompletedSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    expect(screen.getByText('Open in Telegram')).toBeTruthy()
    expect(screen.queryByText('Send Reply')).toBeNull()
    expect(screen.queryByText('Stop Minion')).toBeNull()
    expect(screen.queryByText('Close Session')).toBeNull()
  })

  it('renders quick action items when session has quick actions', () => {
    render(
      <ContextMenu
        session={mockSessionWithQuickActions}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    expect(screen.getByText('Make PR')).toBeTruthy()
    expect(screen.getByText('Retry')).toBeTruthy()
  })

  it('calls onOpenThread and onClose when Open in Telegram is clicked', () => {
    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    fireEvent.click(screen.getByText('Open in Telegram'))
    expect(mockActions.onOpenThread).toHaveBeenCalledWith(mockRunningSession)
    expect(mockOnClose).toHaveBeenCalled()
  })

  it('opens reply dialog when Send Reply is clicked', () => {
    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    fireEvent.click(screen.getByText('Send Reply'))
    expect(mockOnClose).toHaveBeenCalled()
    expect(screen.getByText('Send Reply', { selector: 'h3' })).toBeTruthy()
  })

  it('executes quick action and closes menu', () => {
    render(
      <ContextMenu
        session={mockSessionWithQuickActions}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    fireEvent.click(screen.getByText('Make PR'))
    expect(mockActions.onSendReply).toHaveBeenCalledWith('session-3', '/make_pr')
    expect(mockOnClose).toHaveBeenCalled()
  })

  it('closes when clicking outside the menu', () => {
    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    fireEvent.mouseDown(document.body)
    expect(mockOnClose).toHaveBeenCalled()
  })

  it('closes when Escape key is pressed', () => {
    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(mockOnClose).toHaveBeenCalled()
  })

  it('renders menu with correct ARIA attributes', () => {
    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    const menu = screen.getByRole('menu')
    expect(menu).toBeTruthy()
    expect(menu.getAttribute('aria-label')).toBe('Actions for bold-meadow')

    const menuItems = screen.getAllByRole('menuitem')
    expect(menuItems.length).toBeGreaterThan(0)
  })

  it('shows stop confirm dialog for non-Telegram environment', async () => {
    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    fireEvent.click(screen.getByText('Stop Minion'))
    expect(screen.getByText('Are you sure you want to stop this minion? Any in-progress work will be interrupted.')).toBeTruthy()
  })

  it('shows close confirm dialog for non-Telegram environment', async () => {
    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    fireEvent.click(screen.getByText('Close Session'))
    expect(screen.getByText('Are you sure you want to close this session? This will terminate the minion and clean up resources.')).toBeTruthy()
  })

  it('does not show Stop for pending (non-running) sessions', () => {
    render(
      <ContextMenu
        session={mockPendingSession}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    expect(screen.queryByText('Stop Minion')).toBeNull()
    expect(screen.getByText('Close Session')).toBeTruthy()
  })

  it('clamps position to viewport bounds', () => {
    Object.defineProperty(window, 'innerWidth', { value: 400, writable: true })
    Object.defineProperty(window, 'innerHeight', { value: 600, writable: true })

    render(
      <ContextMenu
        session={mockRunningSession}
        position={{ x: 350, y: 550 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    const menu = screen.getByRole('menu')
    const left = parseInt(menu.style.left)
    const top = parseInt(menu.style.top)
    expect(left).toBeLessThanOrEqual(400 - 200)
    expect(top).toBeLessThanOrEqual(600)
  })

  it('disables action buttons when isActionLoading is true', () => {
    const loadingActions = createMockActions({ isActionLoading: true })

    render(
      <ContextMenu
        session={mockSessionWithQuickActions}
        position={{ x: 100, y: 100 }}
        actions={loadingActions}
        onClose={mockOnClose}
      />
    )

    const makeprButton = screen.getByText('Make PR').closest('button')
    expect(makeprButton?.hasAttribute('disabled')).toBe(true)
  })

  it('renders dividers between menu sections', () => {
    render(
      <ContextMenu
        session={mockSessionWithQuickActions}
        position={{ x: 100, y: 100 }}
        actions={mockActions}
        onClose={mockOnClose}
      />
    )

    const separators = screen.getAllByRole('separator')
    expect(separators.length).toBeGreaterThan(0)
  })
})

describe('useLongPress', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('calls onContextMenu on right-click', () => {
    const onLongPress = vi.fn()
    const onContextMenu = vi.fn()

    const { result } = renderHook(() => useLongPress(onLongPress, onContextMenu))

    const event = new MouseEvent('contextmenu', { clientX: 150, clientY: 200 })
    Object.defineProperty(event, 'preventDefault', { value: vi.fn() })
    result.current.onContextMenu(event as MouseEvent)

    expect(onContextMenu).toHaveBeenCalledWith({ x: 150, y: 200 })
    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('calls onLongPress after holding touch for 500ms', () => {
    vi.useFakeTimers()
    const onLongPress = vi.fn()
    const onContextMenu = vi.fn()

    const { result } = renderHook(() => useLongPress(onLongPress, onContextMenu))

    const touchEvent = {
      touches: [{ clientX: 100, clientY: 200 }],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent

    result.current.onTouchStart(touchEvent)

    vi.advanceTimersByTime(500)
    expect(onLongPress).toHaveBeenCalledWith({ x: 100, y: 200 })
  })

  it('does not call onLongPress if touch is released early', () => {
    vi.useFakeTimers()
    const onLongPress = vi.fn()
    const onContextMenu = vi.fn()

    const { result } = renderHook(() => useLongPress(onLongPress, onContextMenu))

    const touchEvent = {
      touches: [{ clientX: 100, clientY: 200 }],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent

    result.current.onTouchStart(touchEvent)
    vi.advanceTimersByTime(200)
    result.current.onTouchEnd()
    vi.advanceTimersByTime(300)

    expect(onLongPress).not.toHaveBeenCalled()
  })

  it('cancels long press on touch move', () => {
    vi.useFakeTimers()
    const onLongPress = vi.fn()
    const onContextMenu = vi.fn()

    const { result } = renderHook(() => useLongPress(onLongPress, onContextMenu))

    const touchEvent = {
      touches: [{ clientX: 100, clientY: 200 }],
      preventDefault: vi.fn(),
    } as unknown as TouchEvent

    result.current.onTouchStart(touchEvent)
    vi.advanceTimersByTime(200)
    result.current.onTouchMove()
    vi.advanceTimersByTime(300)

    expect(onLongPress).not.toHaveBeenCalled()
  })
})

describe('useContextMenu', () => {
  afterEach(() => {
    cleanup()
  })

  it('starts with null state', () => {
    const { result } = renderHook(() => useContextMenu())
    expect(result.current.state.session).toBeNull()
    expect(result.current.state.position).toBeNull()
  })

  it('opens with session and position', () => {
    const { result } = renderHook(() => useContextMenu())

    act(() => {
      result.current.open(mockRunningSession, { x: 100, y: 200 })
    })

    expect(result.current.state.session).toBe(mockRunningSession)
    expect(result.current.state.position).toEqual({ x: 100, y: 200 })
  })

  it('closes and resets state', () => {
    const { result } = renderHook(() => useContextMenu())

    act(() => {
      result.current.open(mockRunningSession, { x: 100, y: 200 })
    })

    act(() => {
      result.current.close()
    })

    expect(result.current.state.session).toBeNull()
    expect(result.current.state.position).toBeNull()
  })
})
