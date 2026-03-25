import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/preact'
import { ConfirmDialog, ReplyDialog } from '../src/components/ConfirmDialog'

describe('ConfirmDialog', () => {
  const mockOnConfirm = vi.fn()
  const mockOnCancel = vi.fn()

  beforeEach(() => {
    mockOnConfirm.mockClear()
    mockOnCancel.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('should not render when isOpen is false', () => {
    render(
      <ConfirmDialog
        isOpen={false}
        title="Test Title"
        message="Test message"
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
      />
    )

    expect(screen.queryByText('Test Title')).toBe(null)
  })

  it('should render when isOpen is true', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Title"
        message="Test message"
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
      />
    )

    expect(screen.getByText('Test Title')).toBeTruthy()
    expect(screen.getByText('Test message')).toBeTruthy()
  })

  it('should call onCancel when cancel button is clicked', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Title"
        message="Test message"
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
      />
    )

    fireEvent.click(screen.getByText('Cancel'))
    expect(mockOnCancel).toHaveBeenCalledTimes(1)
  })

  it('should call onConfirm when confirm button is clicked', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Title"
        message="Test message"
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
      />
    )

    fireEvent.click(screen.getByText('Confirm'))
    expect(mockOnConfirm).toHaveBeenCalledTimes(1)
  })

  it('should show loading state', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Title"
        message="Test message"
        isLoading={true}
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
      />
    )

    expect(screen.getByText('Processing...')).toBeTruthy()
  })

  it('should disable buttons when loading', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Title"
        message="Test message"
        isLoading={true}
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
      />
    )

    const confirmButton = screen.getByText('Processing...')
    expect(confirmButton.hasAttribute('disabled')).toBe(true)
  })

  it('should use custom labels', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Title"
        message="Test message"
        confirmLabel="Delete"
        cancelLabel="Go Back"
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
      />
    )

    expect(screen.getByText('Delete')).toBeTruthy()
    expect(screen.getByText('Go Back')).toBeTruthy()
  })

  it('should call onCancel when clicking backdrop', () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Test Title"
        message="Test message"
        onConfirm={mockOnConfirm}
        onCancel={mockOnCancel}
      />
    )

    const backdrop = document.querySelector('.absolute.inset-0')
    if (backdrop) {
      fireEvent.click(backdrop)
      expect(mockOnCancel).toHaveBeenCalledTimes(1)
    }
  })
})

describe('ReplyDialog', () => {
  const mockOnSend = vi.fn()
  const mockOnCancel = vi.fn()

  beforeEach(() => {
    mockOnSend.mockClear()
    mockOnCancel.mockClear()
  })

  afterEach(() => {
    cleanup()
  })

  it('should not render when isOpen is false', () => {
    render(
      <ReplyDialog
        isOpen={false}
        sessionId="session-1"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
      />
    )

    expect(screen.queryByText('Send Reply')).toBe(null)
  })

  it('should render when isOpen is true', () => {
    render(
      <ReplyDialog
        isOpen={true}
        sessionId="session-1"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
      />
    )

    expect(screen.getByText('Send Reply')).toBeTruthy()
  })

  it('should call onCancel when cancel button is clicked', () => {
    render(
      <ReplyDialog
        isOpen={true}
        sessionId="session-1"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
      />
    )

    fireEvent.click(screen.getByText('Cancel'))
    expect(mockOnCancel).toHaveBeenCalledTimes(1)
  })

  it('should call onSend with message when form is submitted', () => {
    render(
      <ReplyDialog
        isOpen={true}
        sessionId="session-1"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
      />
    )

    const textarea = screen.getByPlaceholderText('Enter your message...')
    fireEvent.input(textarea, { target: { value: 'Hello minion!' } })

    const sendButton = screen.getByText('Send')
    fireEvent.click(sendButton)

    expect(mockOnSend).toHaveBeenCalledWith('session-1', 'Hello minion!')
  })

  it('should not call onSend when message is empty', () => {
    render(
      <ReplyDialog
        isOpen={true}
        sessionId="session-1"
        onSend={mockOnSend}
        onCancel={mockOnCancel}
      />
    )

    const sendButton = screen.getByText('Send')
    fireEvent.click(sendButton)

    expect(mockOnSend).not.toHaveBeenCalled()
  })

  it('should show loading state', () => {
    render(
      <ReplyDialog
        isOpen={true}
        sessionId="session-1"
        isLoading={true}
        onSend={mockOnSend}
        onCancel={mockOnCancel}
      />
    )

    expect(screen.getByText('Sending...')).toBeTruthy()
  })
})
