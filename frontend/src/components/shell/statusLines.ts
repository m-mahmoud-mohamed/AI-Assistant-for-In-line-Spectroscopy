const WINDOW_LABEL: Record<string, string> = { minute: 'per minute', hour: 'per hour', day: 'per day', month: 'per month' }

/** Lines of the API status tooltip: connection, replay mode and the remaining request budget. */
export function statusLines(
  apiStatus: 'checking' | 'online' | 'offline',
  health?: { profile: string; replay: boolean; budget?: Record<string, number> },
): string[] {
  if (apiStatus === 'offline') return ["PRISM is unavailable. Retry the connection or contact your PRISM administrator."]
  if (apiStatus === 'checking') return ['Checking the PRISM connection…']
  const lines = ['PRISM connected']
  if (health) {
    lines.push(health.replay ? 'Offline replay' : 'Assessment service available')
    const budget = Object.entries(health.budget ?? {}).filter(([w]) => w in WINDOW_LABEL)
    lines.push(
      budget.length
        ? `Requests left: ${budget.map(([w, n]) => `${n.toLocaleString()} ${WINDOW_LABEL[w]}`).join(' · ')}`
        : 'Requests left: not reported',
    )
  }
  return lines
}
