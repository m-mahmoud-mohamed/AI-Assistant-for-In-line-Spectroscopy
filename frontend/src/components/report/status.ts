import { AlertTriangle, Ban, ClipboardCheck, type LucideIcon } from 'lucide-react'
import type { DecisionStatus } from '../../types'

export const STATUS: Record<DecisionStatus, { label: string; icon: LucideIcon; tone: 'ok' | 'warn' | 'bad'; detail: string }> = {
  PROVISIONAL: {
    label: 'Provisional',
    icon: ClipboardCheck,
    tone: 'ok',
    detail: 'Based on the stated facts and cited AFS sources. Confirm the open questions before committing.',
  },
  INSUFFICIENT_INFORMATION: {
    label: 'Insufficient information',
    icon: AlertTriangle,
    tone: 'warn',
    detail: 'Key facts are missing. Answer the clarification questions before a method can be chosen.',
  },
  OUTSIDE_SUPPORTED_SCOPE: {
    label: 'Outside supported scope',
    icon: Ban,
    tone: 'bad',
    detail: 'The request goes beyond what the AFS sources support. Any concept shown is for screening only.',
  },
}

/** The status explanation as a sentence, for places where there is no hover (print, touch). */
export const statusDetail = (status: DecisionStatus): string => STATUS[status].detail
