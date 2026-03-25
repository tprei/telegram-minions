import { render } from 'preact'
import App from './App'
import './index.css'
import { initTelegramSDK } from './telegram'

// Initialize Telegram SDK
initTelegramSDK()

render(<App />, document.getElementById('app')!)
