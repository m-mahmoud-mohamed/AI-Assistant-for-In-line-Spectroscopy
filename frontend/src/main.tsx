import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

async function boot() {
  // Development only: `?demo=assistant` replays a scripted assistant turn against a stubbed backend (the branch is
  // removed from production builds).
  if (import.meta.env.DEV && new URLSearchParams(location.search).get('demo') === 'assistant') {
    const { installAssistantDemo } = await import('./demo/assistantDemo')
    installAssistantDemo()
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void boot()
