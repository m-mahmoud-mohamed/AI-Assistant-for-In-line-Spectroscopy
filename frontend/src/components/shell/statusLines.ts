const WINDOW_LABEL: Record<string, string> = { minute: 'per minute', hour: 'per hour', day: 'per day', month: 'per month' }

/** Lines of the API status tooltip: connection, provider profile and the remaining request budget. */
export function statusLines(
  apiStatus: 'checking' | 'online' | 'offline',
  health?: { profile: string; replay: boolean; budget?: Record<string, number> },
): string[] {
  if (apiStatus === 'offline') return ["PRISM API not reachable — start it with `make api`"]
  if (apiStatus === 'checking') return ['Checking the PRISM API…']
  const lines = ['PRISM API connected']
  if (health) {
    lines.push(`Provider profile: ${health.profile}${health.replay ? ' (replay)' : ''}`)
    const budget = Object.entries(health.budget ?? {}).filter(([w]) => w in WINDOW_LABEL)
    lines.push(
      budget.length
        ? `Requests left: ${budget.map(([w, n]) => `${n.toLocaleString()} ${WINDOW_LABEL[w]}`).join(' · ')}`
        : 'Requests left: not reported',
    )
  }
  return lines
}
