import type { ReactNode } from 'react'
import { Appear } from '../../thread/Appear'
import { DirectAnswer } from '../../report/DirectAnswer'
import { PremiseChecks } from '../../report/PremiseChecks'
import { QuestionsList } from '../../report/QuestionsList'
import { RecommendationItem } from '../../report/Recommendations'
import { UnknownGroups } from '../../report/UnknownGroups'
import { EngineCandidates } from '../EngineCandidates'
import { firstUnknowns } from '../model'
import { SeeAll, TabSection } from '../TabSection'
import type { TabProps } from './types'

const TOP = 3

/** A fresh report's reveal is done within 900 ms: the header, then the Overview blocks 50 ms apart (380 ms each), the answer's words within 880 ms. */
const STAGGER = 50

/**
 * The answer at a glance: the client's question, the direct answer, premise verdicts, the top recommendations, the
 * most important questions and unknowns. Each block links to the tab that holds the rest.
 * A fresh report blurs these blocks in once (header first); stored reports render at once. A block whose section the
 * report does not have yet shows its skeleton.
 */
export function OverviewTab({ assessment: a, report, model, reveal = false }: TabProps & { reveal?: boolean }) {
  const claim = { onCite: a.cite, citations: model.citations }
  const { pending } = model
  const question = (report.client_question ?? []).filter((q) => q.trim())
  const questions = model.questions
  const unknownGroups = firstUnknowns(model.unknownGroups, TOP)
  let n = 0
  const block = (node: ReactNode, className?: string) => (
    <Appear animate={reveal} delay={60 + n++ * STAGGER} duration={380} y={6} className={className}>
      {node}
    </Appear>
  )

  return (
    <div className="tab-stack">
      {question.length > 0 &&
        block(
          <TabSection title="Client's question">
            <div className="ov-question">
              {question.map((q, i) => (
                <p key={i} className="rs-p">
                  “{q}”
                </p>
              ))}
            </div>
          </TabSection>,
        )}

      {block(
        <TabSection title="Direct answer" pending={pending.answer} rows={2}>
          <DirectAnswer answer={report.direct_answer} {...claim} revealDelay={reveal ? 120 : undefined} />
        </TabSection>,
      )}

      {(pending.premises || report.premise_checks.length > 0) &&
        block(
          <TabSection title="Premise checks" pending={pending.premises} rows={2}>
            <PremiseChecks checks={report.premise_checks} {...claim} />
          </TabSection>,
        )}

      {(pending.recs || model.recs.length > 0) &&
        block(
          pending.recs && a.enginePreview ? (
            <TabSection title="Candidate methods" aside={<SeeAll onClick={() => a.setTab('methods')}>Method detail</SeeAll>}>
              <EngineCandidates engine={a.enginePreview} />
            </TabSection>
          ) : (
            <TabSection
              title="Recommendations"
              pending={pending.recs}
              rows={4}
              aside={<SeeAll onClick={() => a.setTab('methods')}>{model.recs.length > TOP ? `All ${model.recs.length} methods` : 'Method detail'}</SeeAll>}
            >
              <ul className="rc-grid">
                {model.recs.slice(0, TOP).map((rec, i) => (
                  <RecommendationItem key={i} rec={rec} streams={model.streams} variant="summary" onMore={() => a.setTab('methods')} {...claim} />
                ))}
              </ul>
            </TabSection>
          ),
        )}

      {(pending.questions || pending.requirements || questions.length > 0 || model.unknowns.length > 0) &&
        block(
          <div className="ov-pair">
            {(pending.questions || questions.length > 0) && (
              <TabSection title="Open questions" pending={pending.questions} aside={<SeeAll onClick={() => a.setTab('questions')}>{questions.length > TOP ? `See all ${questions.length} questions` : 'Question detail'}</SeeAll>}>
                <QuestionsList questions={questions} limit={TOP} compact />
              </TabSection>
            )}
            {(pending.requirements || model.unknowns.length > 0) && (
              <TabSection
                title="Key unknowns"
                pending={pending.requirements}
                aside={<SeeAll onClick={() => a.setTab('concept')}>{model.unknowns.length > TOP ? `See all ${model.unknowns.length}` : 'All unknowns'}</SeeAll>}
              >
                <UnknownGroups groups={unknownGroups} streamName={model.streamName} />
              </TabSection>
            )}
          </div>,
        )}

    </div>
  )
}
