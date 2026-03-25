import { signal, computed, effect } from '@preact/signals'
import WebApp from '@twa-dev/sdk'

// Extend Window interface for Telegram WebApp
declare global {
  interface Window {
    Telegram?: {
      WebApp: typeof WebApp
    }
  }
}

// Types
export interface TelegramUser {
  id: number
  firstName: string
  lastName?: string
  username?: string
}

export interface TelegramThemeColors {
  bgColor: string
  textColor: string
  hintColor: string
  linkColor: string
  buttonColor: string
  buttonTextColor: string
  secondaryBgColor: string
}

export interface ViewportState {
  width: number
  height: number
  isExpanded: boolean
  stableHeight: number
}

// State signals
export const isTelegramMiniApp = signal(false)
export const telegramUser = signal<TelegramUser | null>(null)
export const isDarkMode = signal(false)
export const viewportState = signal<ViewportState>({
  width: 0,
  height: 0,
  isExpanded: false,
  stableHeight: 0,
})
export const themeColors = signal<TelegramThemeColors>({
  bgColor: '#ffffff',
  textColor: '#000000',
  hintColor: '#999999',
  linkColor: '#2481cc',
  buttonColor: '#2481cc',
  buttonTextColor: '#ffffff',
  secondaryBgColor: '#f1f1f1',
})
export const isMainButtonVisible = signal(false)
export const isBackButtonVisible = signal(false)
export const isMainButtonLoading = signal(false)

// Derived state
export const hasUser = computed(() => telegramUser.value !== null)

// MainButton callbacks
let mainButtonCallback: (() => void) | null = null

// BackButton callbacks
let backButtonCallback: (() => void) | null = null

// SDK initialized flag
let sdkInitialized = false

function updateTheme() {
  const theme = WebApp.themeParams
  const bg = theme.bg_color ?? '#ffffff'
  const isDark = bg.toLowerCase() !== '#ffffff' && bg.toLowerCase() !== '#fff'

  isDarkMode.value = isDark

  themeColors.value = {
    bgColor: theme.bg_color ?? '#ffffff',
    textColor: theme.text_color ?? '#000000',
    hintColor: theme.hint_color ?? '#999999',
    linkColor: theme.link_color ?? '#2481cc',
    buttonColor: theme.button_color ?? '#2481cc',
    buttonTextColor: theme.button_text_color ?? '#ffffff',
    secondaryBgColor: theme.secondary_bg_color ?? '#f1f1f1',
  }
}

function updateViewport() {
  viewportState.value = {
    width: window.innerWidth,
    height: window.innerHeight,
    isExpanded: WebApp.isExpanded,
    stableHeight: WebApp.viewportStableHeight,
  }
}

/**
 * Initialize Telegram Mini App SDK
 * Should be called once at app startup
 */
export function initTelegramSDK(): boolean {
  if (sdkInitialized) {
    return isTelegramMiniApp.value
  }

  sdkInitialized = true

  // Check if we're running inside Telegram
  const isInTelegram = Boolean(window.Telegram?.WebApp?.platform)
  if (!isInTelegram) {
    console.log('[telegram] Not running inside Telegram Mini App')
    return false
  }

  try {
    // Mark as running in Telegram
    isTelegramMiniApp.value = true

    // Signal that we're ready
    WebApp.ready()

    // Expand to full height
    WebApp.expand()

    // Parse user data
    const initDataUnsafe = WebApp.initDataUnsafe
    if (initDataUnsafe?.user) {
      const user = initDataUnsafe.user
      telegramUser.value = {
        id: user.id,
        firstName: user.first_name ?? '',
        lastName: user.last_name,
        username: user.username,
      }
    }

    // Initialize theme
    updateTheme()

    // Initialize viewport
    updateViewport()

    // Listen for theme changes
    WebApp.onEvent('themeChanged', updateTheme)

    // Listen for viewport changes
    WebApp.onEvent('viewportChanged', updateViewport)

    console.log('[telegram] SDK initialized successfully')
    return true
  } catch (error) {
    console.error('[telegram] Failed to initialize SDK:', error)
    return false
  }
}

/**
 * Show the main button with a text and click handler
 */
export function showMainButton(text: string, onClick: () => void): void {
  if (!isTelegramMiniApp.value) return

  WebApp.MainButton.setText(text)
  WebApp.MainButton.show()
  isMainButtonVisible.value = true

  // Remove old callback if exists
  if (mainButtonCallback) {
    WebApp.MainButton.offClick(mainButtonCallback)
  }

  // Set new callback
  mainButtonCallback = onClick
  WebApp.MainButton.onClick(mainButtonCallback)
}

/**
 * Hide the main button
 */
export function hideMainButton(): void {
  if (!isTelegramMiniApp.value) return

  WebApp.MainButton.hide()
  isMainButtonVisible.value = false

  if (mainButtonCallback) {
    WebApp.MainButton.offClick(mainButtonCallback)
    mainButtonCallback = null
  }
}

/**
 * Set main button loading state (shows progress indicator)
 */
export function setMainButtonLoading(loading: boolean): void {
  if (!isTelegramMiniApp.value) return

  if (loading) {
    WebApp.MainButton.showProgress()
  } else {
    WebApp.MainButton.hideProgress()
  }
  isMainButtonLoading.value = loading
}

/**
 * Enable or disable the main button
 */
export function setMainButtonEnabled(enabled: boolean): void {
  if (!isTelegramMiniApp.value) return

  if (enabled) {
    WebApp.MainButton.enable()
  } else {
    WebApp.MainButton.disable()
  }
}

/**
 * Show the back button with a click handler
 */
export function showBackButton(onClick: () => void): void {
  if (!isTelegramMiniApp.value) return

  WebApp.BackButton.show()
  isBackButtonVisible.value = true

  // Remove old callback if exists
  if (backButtonCallback) {
    WebApp.BackButton.offClick(backButtonCallback)
  }

  // Set new callback
  backButtonCallback = onClick
  WebApp.BackButton.onClick(backButtonCallback)
}

/**
 * Hide the back button
 */
export function hideBackButton(): void {
  if (!isTelegramMiniApp.value) return

  WebApp.BackButton.hide()
  isBackButtonVisible.value = false

  if (backButtonCallback) {
    WebApp.BackButton.offClick(backButtonCallback)
    backButtonCallback = null
  }
}

/**
 * Show a native Telegram popup dialog
 */
export interface PopupOptions {
  title: string
  message: string
  buttons: Array<{
    id: string
    type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive'
    text?: string
  }>
}

export function showPopup(options: PopupOptions): Promise<string> {
  return new Promise((resolve) => {
    if (!isTelegramMiniApp.value) {
      // Fallback for non-Telegram environment
      const confirmed = confirm(`${options.title}\n\n${options.message}`)
      resolve(confirmed ? 'ok' : 'cancel')
      return
    }
    WebApp.showPopup(
      {
        title: options.title,
        message: options.message,
        buttons: options.buttons.map((btn) => ({
        id: btn.id,
        type: btn.type ?? 'default',
        text: btn.text ?? '',
        })),
      },
      (buttonId) => {
        resolve(buttonId ?? '')
      }
    )
  })
}

/**
 * Show a simple alert dialog
 */
export function showAlert(message: string, title = 'Alert'): Promise<void> {
  return new Promise((resolve) => {
    if (!isTelegramMiniApp.value) {
      alert(`${title}\n\n${message}`)
      resolve()
      return
    }

    WebApp.showAlert(message, () => resolve())
  })
}

/**
 * Show a confirm dialog with OK/Cancel buttons
 */
export function showConfirm(message: string, title = 'Confirm'): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isTelegramMiniApp.value) {
      resolve(confirm(`${title}\n\n${message}`))
      return
    }

    WebApp.showPopup(
      {
        title,
        message,
        buttons: [
          { id: 'cancel', type: 'cancel' },
          { id: 'ok', type: 'ok' },
        ],
      },
      (buttonId) => {
        resolve(buttonId === 'ok')
      }
    )
  })
}

/**
 * Show a destructive confirm dialog (for dangerous actions)
 */
export function showDestructiveConfirm(
  message: string,
  title = 'Confirm',
  confirmText = 'Delete'
): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isTelegramMiniApp.value) {
      resolve(confirm(`${title}\n\n${message}`))
      return
    }

    WebApp.showPopup(
      {
        title,
        message,
        buttons: [
          { id: 'cancel', type: 'cancel' },
          { id: 'destructive', type: 'destructive', text: confirmText },
        ],
      },
      (buttonId) => {
        resolve(buttonId === 'destructive')
      }
    )
  })
}

/**
 * Close the Mini App
 */
export function closeMiniApp(): void {
  if (isTelegramMiniApp.value) {
    WebApp.close()
  }
}

/**
 * Expand the Mini App to full height
 */
export function expandMiniApp(): void {
  if (isTelegramMiniApp.value) {
    WebApp.expand()
  }
}

/**
 * Open a link in Telegram's in-app browser
 */
export function openLink(url: string): void {
  if (isTelegramMiniApp.value) {
    WebApp.openLink?.(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/**
 * Open a Telegram link (t.me)
 */
export function openTelegramLink(url: string): void {
  if (isTelegramMiniApp.value) {
    WebApp.openTelegramLink?.(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}

/**
 * Apply theme colors to CSS custom properties
 */
export function applyThemeToCss(): void {
  const colors = themeColors.value
  const root = document.documentElement

  root.style.setProperty('--tg-theme-bg-color', colors.bgColor)
  root.style.setProperty('--tg-theme-text-color', colors.textColor)
  root.style.setProperty('--tg-theme-hint-color', colors.hintColor)
  root.style.setProperty('--tg-theme-link-color', colors.linkColor)
  root.style.setProperty('--tg-theme-button-color', colors.buttonColor)
  root.style.setProperty('--tg-theme-button-text-color', colors.buttonTextColor)
  root.style.setProperty('--tg-theme-secondary-bg-color', colors.secondaryBgColor)

  // Set dark mode class for Tailwind
  if (isDarkMode.value) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

// Auto-apply theme changes
effect(() => {
  if (isTelegramMiniApp.value) {
    applyThemeToCss()
  }
})
