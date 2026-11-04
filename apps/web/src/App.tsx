import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useIsMobile } from '@/hooks/use-mobile';

import { ChatPanel } from './components/Chat/ChatPanel.tsx';
import { CompileBar } from './components/CompileBar.tsx';
import { EditorPane } from './components/Editor/EditorPane.tsx';
import { EntriesTable } from './components/EntriesTable.tsx';
import { FileTree } from './components/FileTree.tsx';
import { PdfViewer } from './components/PdfViewer.tsx';
import { OpenFolderForm, RecentProjects } from './components/Project/ProjectPicker.tsx';
import { SettingsDialog } from './components/Settings/SettingsDialog.tsx';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from '@/components/ui/empty';
import { useProjectStore } from './store/project-store.ts';

/** Resizable panes: file rail | source over entries | PDF | agent chat. */
function DesktopLayout() {
  return (
    <div className="flex min-h-0 flex-1">
      <ResizablePanelGroup orientation="horizontal" className="min-w-0 flex-1">
        <ResizablePanel id="files" defaultSize="15%" minSize={180} maxSize="35%">
          <FileTree />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="source" defaultSize="34%" minSize="25%">
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel id="editor" defaultSize="72%" minSize="30%">
              <EditorPane />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel id="entries" defaultSize="28%" minSize={96}>
              <EntriesTable />
            </ResizablePanel>
          </ResizablePanelGroup>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="pdf" defaultSize="27%" minSize="15%">
          <PdfViewer />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="chat" defaultSize="24%" minSize={280}>
          <ChatPanel />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

/** One pane at a time on narrow screens; the file tree opens as a drawer from the bar. */
function MobileLayout() {
  return (
    <>
      <FileTree />
      <Tabs defaultValue="source" className="min-h-0 flex-1 gap-0">
        <TabsList variant="line" className="h-9 w-full shrink-0 rounded-none border-b px-2">
          <TabsTrigger value="source">Source</TabsTrigger>
          <TabsTrigger value="pdf">PDF</TabsTrigger>
          <TabsTrigger value="entries">Entries</TabsTrigger>
          <TabsTrigger value="agent">Agent</TabsTrigger>
        </TabsList>
        <TabsContent value="source" className="min-h-0">
          <EditorPane />
        </TabsContent>
        <TabsContent value="pdf" className="min-h-0">
          <PdfViewer />
        </TabsContent>
        <TabsContent value="entries" className="min-h-0">
          <EntriesTable />
        </TabsContent>
        <TabsContent value="agent" className="min-h-0">
          <ChatPanel />
        </TabsContent>
      </Tabs>
    </>
  );
}

/** Before any project is open (SPEC 4.4): ask for one. */
function NoProject() {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>Open a project</EmptyTitle>
        <EmptyDescription>
          Type the absolute path of a folder with your LaTeX files, or pick a recent one.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full max-w-lg items-stretch">
        <OpenFolderForm />
        <RecentProjects />
      </EmptyContent>
    </Empty>
  );
}

export function App() {
  const isMobile = useIsMobile();
  const loaded = useProjectStore((s) => s.loaded);
  const hasProject = useProjectStore((s) => s.root !== null);
  return (
    <TooltipProvider>
      <SidebarProvider className="h-svh min-h-0 flex-col overflow-hidden">
        <CompileBar />
        {!loaded ? null : !hasProject ? (
          <NoProject />
        ) : isMobile ? (
          <MobileLayout />
        ) : (
          <DesktopLayout />
        )}
        <SettingsDialog />
      </SidebarProvider>
    </TooltipProvider>
  );
}
