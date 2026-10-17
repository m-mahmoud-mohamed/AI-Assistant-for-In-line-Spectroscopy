import { Beaker, Briefcase, FlaskConical, Globe, Factory, Microscope, type LucideIcon } from 'lucide-react'
import type { Scope } from '../../types'

export const SCOPE_INFO: Record<Scope, { label: string; icon: LucideIcon }> = {
  method_general: { label: 'Method (general)', icon: Microscope },
  process_application: { label: 'Process application', icon: Factory },
  lab_study: { label: 'Lab study', icon: FlaskConical },
  in_vitro_poc: { label: 'In-vitro proof of concept', icon: Beaker },
  business_context: { label: 'Business context', icon: Briefcase },
  external: { label: 'External', icon: Globe },
}
