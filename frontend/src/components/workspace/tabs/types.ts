import type { Assessment } from '../../../state/useAssessment'
import type { ReportViewData, RuleFindings } from '../../../types'
import type { ReportModel } from '../model'

/** What every report tab receives. */
export interface TabProps {
  assessment: Assessment
  report: ReportViewData
  rules?: RuleFindings
  model: ReportModel
}
