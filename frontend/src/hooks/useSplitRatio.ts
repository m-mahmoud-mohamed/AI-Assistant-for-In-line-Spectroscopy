import { useCallback, useState } from 'react'
import { storage } from '../state/navigation'

export const DEFAULT_SPLIT_RATIO = 0.42
export function useSplitRatio() {
  const [ratio, setState] = useState(() => {
    const stored = Number(storage.get('prism:split-ratio'))
    return stored >= 0.25 && stored <= 0.65 ? stored : DEFAULT_SPLIT_RATIO
  })
  const setRatio = useCallback((value: number) => {
    const next = Math.min(0.65, Math.max(0.25, value))
    setState(next)
    storage.set('prism:split-ratio', String(next))
  }, [])
  return { ratio, setRatio }
}
