import { useEffect, useState } from 'react'
import { storage } from '../../state/navigation'

export type Appearance = 'light' | 'dark' | 'system'
const read = (): Appearance => {
  const value = storage.get('prism:appearance')
  return value === 'light' || value === 'dark' ? value : 'system'
}
export function applyAppearance(value: Appearance) {
  const dark = value === 'dark' || (value === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.appearance = value
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#17171c' : '#ffffff')
}
export function useAppearance() {
  const [appearance, setValue] = useState<Appearance>(read)
  useEffect(() => {
    applyAppearance(appearance)
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    const change = () => applyAppearance(appearance)
    media?.addEventListener('change', change)
    const sync = () => setValue(read())
    window.addEventListener('storage', sync)
    window.addEventListener('prism:appearance', sync)
    return () => {
      media?.removeEventListener('change', change)
      window.removeEventListener('storage', sync)
      window.removeEventListener('prism:appearance', sync)
    }
  }, [appearance])
  const setAppearance = (value: Appearance) => {
    storage.set('prism:appearance', value)
    applyAppearance(value)
    setValue(value)
    window.dispatchEvent(new Event('prism:appearance'))
  }
  return { appearance, setAppearance }
}
