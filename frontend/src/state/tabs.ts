// The report workspace's tabs: ids, labels, and the URL-hash memory of the active one (`#tab=methods`).

export const TAB_IDS = ['overview', 'methods', 'spectral', 'concept', 'plan', 'questions', 'evidence', 'checks'] as const
export type TabId = (typeof TAB_IDS)[number]

export const TAB_LABEL: Record<TabId, string> = {
  overview: 'Overview',
  methods: 'Methods',
  spectral: 'Spectral',
  concept: 'Concept',
  plan: 'Plan',
  questions: 'Questions',
  evidence: 'Evidence',
  checks: 'Checks',
}

export const isTabId = (value: unknown): value is TabId => typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value)

/** The tab named in the URL hash (`#tab=methods`), if any. */
export function readHashTab(): TabId | null {
  if (typeof location === 'undefined') return null
  const match = /(?:^#|&)tab=([a-z]+)/.exec(location.hash)
  return match && isTabId(match[1]) ? match[1] : null
}

/** Reflect the active tab in the URL hash without adding a history entry; `null` clears it. */
export function writeHashTab(tab: TabId | null) {
  if (typeof history === 'undefined' || typeof location === 'undefined') return
  const hash = tab ? `#tab=${tab}` : ''
  if (location.hash === hash || (!hash && !location.hash)) return
  try {
    history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`)
  } catch {
    // a sandboxed frame may forbid history changes: the tab still works, it is just not in the URL
  }
}
