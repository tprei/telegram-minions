import { render } from 'preact'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import { initTelegramSDK } from './telegram'

// Initialize Telegram SDK
initTelegramSDK()

render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
  document.getElementById('app')!
)
