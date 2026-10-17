import type { RecRole, Recommendation } from '../../types'

export const ROLE_ORDER: RecRole[] = ['PRIMARY', 'COMPARISON', 'CONDITIONAL', 'SCREENING', 'NOT_RECOMMENDED']

/** Recommendations, primary first (the stored order breaks ties). */
export const sortedRecommendations = (recs: Recommendation[]): Recommendation[] =>
  recs
    .map((r, i) => ({ r, i }))
    .sort((a, b) => ROLE_ORDER.indexOf(a.r.role) - ROLE_ORDER.indexOf(b.r.role) || a.i - b.i)
    .map(({ r }) => r)
