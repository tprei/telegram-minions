import { useCallback, useEffect, useState } from 'preact/hooks'
import {
  isTelegramMiniApp,
  telegramUser,
  isDarkMode,
  themeColors,
  viewportState,
  isMainButtonVisible,
  isBackButtonVisible,
  isMainButtonLoading,
  showMainButton,
  hideMainButton,
  showBackButton,
  hideBackButton,
  setMainButtonLoading,
  setMainButtonEnabled,
  showAlert,
  showConfirm,
  showDestructiveConfirm,
  closeMiniApp,
  expandMiniApp,
  openLink,
  openTelegramLink,
  type TelegramUser,
  type TelegramThemeColors,
  type ViewportState,
} from '../telegram'

/**
 * Hook to check if running inside Telegram Mini App
 */
export function useIsTelegram(): boolean {
  return isTelegramMiniApp.value
}

/**
 * Hook to get current Telegram user
 */
export function useTelegramUser(): TelegramUser | null {
  return telegramUser.value
}

/**
 * Hook to check if user is authenticated
 */
export function useIsAuthenticated(): boolean {
  return telegramUser.value !== null
}

/**
 * Hook to get theme colors from Telegram
 */
export function useThemeColors(): TelegramThemeColors {
  return themeColors.value
}

/**
 * Hook to check if dark mode is active
 */
export function useIsDarkMode(): boolean {
  return isDarkMode.value
}

/**
 * Hook to get viewport state
 */
export function useViewport(): ViewportState {
  return viewportState.value
}

/**
 * Hook for MainButton control
 */
export function useMainButton(
  text: string,
  onClick: () => void,
  deps: unknown[] = []
): {
  isVisible: boolean
  isLoading: boolean
  show: () => void
  hide: () => void
  setLoading: (loading: boolean) => void
  setEnabled: (enabled: boolean) => void
} {
  const [isLoading, setIsLoading] = useState(false)

  const show = useCallback(() => {
    showMainButton(text, onClick)
  }, [text, ...deps])

  const hide = useCallback(() => {
    hideMainButton()
  }, [])

  const setLoading = useCallback((loading: boolean) => {
    setIsLoading(loading)
    setMainButtonLoading(loading)
  }, [])

  const setEnabled = useCallback((enabled: boolean) => {
    setMainButtonEnabled(enabled)
  }, [])

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      hideMainButton()
    }
  }, [])

  return {
    isVisible: isMainButtonVisible.value,
    isLoading: isLoading || isMainButtonLoading.value,
    show,
    hide,
    setLoading,
    setEnabled,
  }
}

/**
 * Hook for BackButton control
 */
export function useBackButton(
  onClick: () => void,
  deps: unknown[] = []
): {
  isVisible: boolean
  show: () => void
  hide: () => void
} {
  const show = useCallback(() => {
    showBackButton(onClick)
  }, [...deps])

  const hide = useCallback(() => {
    hideBackButton()
  }, [])

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      hideBackButton()
    }
  }, [])

  return {
    isVisible: isBackButtonVisible.value,
    show,
    hide,
  }
}

/**
 * Hook for popup dialogs
 */
export function usePopup() {
  const alert = useCallback(async (message: string, title = 'Alert') => {
    await showAlert(message, title)
  }, [])

  const confirm = useCallback(async (message: string, title = 'Confirm'): Promise<boolean> => {
    return showConfirm(message, title)
  }, [])

  const destructive = useCallback(
    async (message: string, title = 'Confirm', confirmText = 'Delete'): Promise<boolean> => {
      return showDestructiveConfirm(message, title, confirmText)
    },
    []
  )

  return {
    alert,
    confirm,
    destructive,
  }
}

/**
 * Hook for Mini App navigation
 */
export function useNavigation() {
  const openExternalLink = useCallback((url: string) => {
    openLink(url)
  }, [])

  const openTgLink = useCallback((url: string) => {
    openTelegramLink(url)
  }, [])

  const close = useCallback(() => {
    closeMiniApp()
  }, [])

  const expand = useCallback(() => {
    expandMiniApp()
  }, [])

  return {
    openExternalLink,
    openTgLink,
    close,
    expand,
  }
}

/**
 * Combined hook for all Telegram features
 */
export function useTelegram() {
  const isTelegram = useIsTelegram()
  const user = useTelegramUser()
  const isAuthenticated = useIsAuthenticated()
  const theme = useThemeColors()
  const darkMode = useIsDarkMode()
  const viewport = useViewport()
  const popup = usePopup()
  const navigation = useNavigation()

  return {
    isTelegram,
    user,
    isAuthenticated,
    theme,
    darkMode,
    viewport,
    popup,
    navigation,
    mainButton: {
      isVisible: isMainButtonVisible.value,
      isLoading: isMainButtonLoading.value,
      show: showMainButton,
      hide: hideMainButton,
      setLoading: setMainButtonLoading,
      setEnabled: setMainButtonEnabled,
    },
    backButton: {
      isVisible: isBackButtonVisible.value,
      show: showBackButton,
      hide: hideBackButton,
    },
  }
}
