import { useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CommandPalette } from './components/CommandPalette'
import { Composer } from './components/composer/Composer'
import { EmailDraftModal } from './components/EmailDraftModal'
import { History } from './components/history/History'
import { Home } from './components/home/Home'
import { NodeDetail } from './components/NodeDetail'
import { CompareDialog } from './components/shell/CompareDialog'
import { GraphDrawer } from './components/shell/GraphDrawer'
import { Rail } from './components/shell/Rail'
import { TopBar } from './components/shell/TopBar'
import { TaskChips } from './components/workspace/TaskChips'
import { useMediaQuery } from './components/workspace/useMediaQuery'
import { Workspace } from './components/workspace/Workspace'
import { buildCommands } from './state/commands'
import { useAssessment } from './state/useAssessment'

/** Keeps `mounted` true for `ms` after `show` turns false so a leave animation can play. */
function useLeave(show: boolean, ms: number) {
  const [mounted, setMounted] = useState(show)
  if (show && !mounted) setMounted(true)
  useEffect(() => {
    if (show || !mounted) return
    const t = setTimeout(() => setMounted(false), ms)
    return () => clearTimeout(t)
  }, [show, mounted, ms])
  return { mounted: show || mounted, leaving: !show && mounted }
}

function Shell() {
  const a = useAssessment()
  const registerComposer = a.registerComposer
  const home = useLeave(a.view === 'home', 240)
  const commands = useMemo(() => buildCommands(a), [a])

  const inThread = a.view === 'thread'
  const crumb = a.view === 'history' ? 'History' : inThread ? a.title : ''
  const hasThread = !!a.selectedId || a.starting
  // At least 1180 px: conversation and report side by side; narrower: one pane at a time.
  const wide = useMediaQuery('(min-width: 1180px)', true)
  const split = inThread && wide

  return (
    <div className="app-ground">
      <div className="app-card">
        <Rail
          view={a.view}
          hasThread={hasThread}
          hasRun={!!a.activeRunId}
          hasReport={!!a.report}
          apiStatus={a.apiStatus}
          onHome={() => a.newEnquiry()}
          onThread={a.openThread}
          onHistory={a.openHistory}
          onPipeline={a.showGraph}
          onSources={a.openSources}
          onHelp={() => a.setPaletteOpen(true)}
        />
        <div className="app-col">
          <TopBar
            deep={a.deep}
            onDeepChange={a.setDeep}
            versions={a.versions}
            currentVersion={inThread ? a.currentVersion : null}
            previousVersion={inThread ? a.previousVersion : null}
            onSelectVersion={a.selectVersion}
            onCompare={() => a.setCompareOpen(true)}
            crumb={crumb}
            onCrumbClick={a.openHistory}
            onSearch={() => a.setPaletteOpen(true)}
            report={inThread ? a.report : null}
            runId={a.activeRunId}
            onEmailDraft={() => a.setEmailOpen(true)}
            onNewEnquiry={() => a.newEnquiry()}
          />
          <div className="app-body" data-mode={a.view} data-ws={inThread ? (split ? 'split' : 'stack') : undefined}>
            {inThread && <h1 className="sr-only">PRISM: in-line spectroscopy assessment</h1>}
            <main className="app-stage" aria-label={inThread ? 'Assessment workspace' : a.view === 'history' ? 'History' : 'New enquiry'}>
              {home.mounted && <Home offline={a.offline} startError={a.startError} leaving={home.leaving} />}
              {inThread && <Workspace assessment={a} wide={wide} />}
              {a.view === 'history' && (
                <History
                  sessions={a.sessionList}
                  loading={a.sessionsLoading}
                  offline={a.offline}
                  selectedId={a.selectedId}
                  onOpen={a.openSession}
                  onNew={() => a.newEnquiry()}
                />
              )}
              {a.view !== 'history' && (
                <Composer
                  registerHandle={registerComposer}
                  value={a.draft}
                  onChange={a.setDraft}
                  onSubmit={a.submit}
                  placeholder={inThread ? 'Ask a follow-up question' : 'Paste a client enquiry…'}
                  deep={a.deep}
                  onDeepChange={a.setDeep}
                  web={a.web}
                  onWebChange={a.setWeb}
                  offline={a.offline}
                  busy={a.sending || a.starting}
                  docked={inThread}
                  hidden={inThread && !wide && a.pane !== 'conversation'}
                  above={inThread && a.report && (wide || a.pane === 'conversation') ? <TaskChips tasks={a.tasks} onRun={a.runTask} /> : null}
                />
              )}
            </main>
          </div>
        </div>
      </div>

      <GraphDrawer
        open={a.graphOpen}
        state={a.run.state}
        selected={a.selectedStage}
        onSelect={a.setSelectedStage}
        onClose={() => a.setGraphOpen(false)}
      />
      {a.selectedStage && a.graphOpen && (
        <NodeDetail stage={a.selectedStage} state={a.run.state.stages[a.selectedStage]} onClose={() => a.setSelectedStage(null)} />
      )}
      <CommandPalette open={a.paletteOpen} commands={commands} onClose={() => a.setPaletteOpen(false)} />
      {a.report && (
        <EmailDraftModal open={a.emailOpen} sessionId={a.selectedId} runId={a.activeRunId} report={a.report} onClose={() => a.setEmailOpen(false)} />
      )}
      <CompareDialog
        open={a.compareOpen}
        sessionId={a.selectedId}
        from={a.previousVersion}
        to={a.currentVersion}
        onClose={() => a.setCompareOpen(false)}
      />
    </div>
  )
}

export default function App({ queryClient }: { queryClient?: QueryClient }) {
  const [client] = useState(() => queryClient ?? new QueryClient())
  return (
    <QueryClientProvider client={client}>
      <Shell />
    </QueryClientProvider>
  )
}
