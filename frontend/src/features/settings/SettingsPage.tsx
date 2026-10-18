import { useEffect, useState } from 'react'
import { IntegrationsPage } from '../integrations/IntegrationsPage'
import { useAppearance, type Appearance } from './appearance'

export function SettingsPage() {
  const [section, setSection] = useState(() => location.hash === '#integrations' ? 'integrations' : 'appearance')
  const { appearance, setAppearance } = useAppearance()
  useEffect(() => {
    const sync = () => setSection(location.hash === '#integrations' ? 'integrations' : 'appearance')
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync) }
  }, [])
  return <section className="settings-page" aria-label="Settings">
    <h1>Settings</h1>
    <div className="settings-nav" role="group" aria-label="Settings section">
      {['appearance', 'integrations'].map((id) => <button className="btn" key={id} aria-pressed={section === id} onClick={() => {
        setSection(id)
        history.pushState(null, '', `/settings#${id}`)
      }}>{id === 'appearance' ? 'Appearance' : 'Integrations'}</button>)}
    </div>
    {section === 'appearance' ? <fieldset className="appearance-options">
      <legend>Appearance</legend>
      <p>Choose a theme, or follow your device’s appearance.</p>
      {(['light', 'dark', 'system'] as Appearance[]).map((value) => <label key={value}>
        <input type="radio" name="appearance" value={value} checked={appearance === value} onChange={() => setAppearance(value)} />
        {value[0].toUpperCase() + value.slice(1)}
      </label>)}
    </fieldset> : <IntegrationsPage />}
  </section>
}
