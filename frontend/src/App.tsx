import { useEffect, useMemo, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { CommandPalette } from './components/CommandPalette'
import { Composer } from './components/composer/Composer'
import { EmailDraftModal } from './components/EmailDraftModal'
import { History } from './components/history/History'
import { Home } from './components/home/Home'
import { CompareDialog } from './components/shell/CompareDialog'
import { Rail } from './components/shell/Rail'
import { TopBar } from './components/shell/TopBar'
import { useMediaQuery } from './components/workspace/useMediaQuery'
import { Workspace } from './components/workspace/Workspace'
import { SettingsPage } from './features/settings/SettingsPage'
import { SourcesPage } from './features/sources/SourcesPage'
import { useSplitRatio } from './hooks/useSplitRatio'
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
  const crumb = a.view === 'history' ? 'Assessments' : a.view === 'sources' ? 'Sources' : a.view === 'settings' ? 'Settings' : inThread ? a.title : ''
  // At least 1180 px: conversation and report side by side; narrower: one pane at a time.
  const wide = useMediaQuery('(min-width: 1024px)', true)
  const split = inThread && wide
  const splitRatio = useSplitRatio()

  return (
    <div className="app-ground">
      <div className="app-card" style={{ ['--split-ratio' as string]: splitRatio.ratio }}>
        <Rail
          view={a.view}
          apiStatus={a.apiStatus}
          onHome={() => a.newEnquiry()}
          onHistory={a.openHistory}
          onSources={a.openSources}
          onSettings={a.openSettings}
          onHelp={() => a.setPaletteOpen(true)}
        />
        <div className="app-col">
          <TopBar
            versions={a.versions}
            currentVersion={inThread ? a.currentVersion : null}
            previousVersion={inThread ? a.previousVersion : null}
            onSelectVersion={a.selectVersion}
            onCompare={() => a.setCompareOpen(true)}
            crumb={crumb}
          />
          <div className="app-body" data-mode={a.view} data-ws={inThread ? (split ? 'split' : 'stack') : undefined}>
            {inThread && <h1 className="sr-only">PRISM: in-line spectroscopy assessment</h1>}
            <main className="app-stage" aria-label={inThread ? 'Assessment workspace' : a.view === 'history' ? 'Assessment history' : 'New enquiry'}>
              {home.mounted && <Home onRetry={a.retryConnection} offline={a.offline} startError={a.startError} leaving={home.leaving} />}
              {inThread && <Workspace assessment={a} wide={wide} splitRatio={splitRatio} />}
              {a.view === 'history' && (
                <History
                  onSearch={() => a.setPaletteOpen(true)}
                  onRetry={a.retryConnection}
                  sessions={a.sessionList}
                  loading={a.sessionsLoading}
                  offline={a.offline}
                  selectedId={a.selectedId}
                  onOpen={a.openSession}
                  onNew={() => a.newEnquiry()}
                />
              )}
              {a.view === 'sources' && <SourcesPage />}
              {a.view === 'settings' && <SettingsPage />}
              {(a.view === 'home' || inThread) && (
                <Composer
                  key={a.selectedId ?? 'new'}
                  registerHandle={registerComposer}
                  value={a.draft}
                  onChange={a.setDraft}
                  onSubmit={a.submit}
                  placeholder={a.turnRunning ? 'The assistant is working…' : inThread ? 'Ask a follow-up question' : 'Paste a client enquiry…'}
                  deep={a.deep}
                  onDeepChange={a.setDeep}
                  web={a.web}
                  onWebChange={a.setWeb}
                  offline={a.offline}
                  busy={a.sending || a.starting}
                  running={a.turnRunning}
                  onStop={a.stopTurn}
                  docked={inThread}
                  hidden={inThread && !wide && a.pane !== 'conversation'}
                />
              )}
            </main>
          </div>
        </div>
      </div>

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
