import React from "react";
import type {
  Agent,
  AppState,
  Channel,
  ComputerEntity,
  ConfirmationRequest,
  ExternalBotConfig,
  Message,
  ScheduledTask,
  SectionId,
  Task
} from "../types";
import { api } from "./api";
import {
  formatChatTitle,
  resolveChannel,
  resolveChatSubtitle
} from "../features";
import { ChatView as ChatViewComponent } from "../components/chat-view";
import {
  collectMentions as collectChatMentions,
  getMentionMembers as getChatMentionMembers
} from "../components/mentions";
import { MessageRow as MessageRowComponent } from "../components/message-list";
import {
  AllTasksView as AllTasksViewComponent,
  TasksView as TasksViewComponent
} from "../components/task-views";
import { ScheduledTasksView as ScheduledTasksViewComponent } from "../components/scheduled-tasks";
import { IntegrationsView as IntegrationsViewComponent } from "../components/integrations";
import { MembersView as MembersViewComponent } from "../components/members";
import { ComputersView as ComputersViewComponent } from "../components/computers";

export interface MainViewProps {
  state: AppState;
  section: SectionId;
  channel: string;
  messages: Message[];
  message: string;
  setMessage: (message: string) => void;
  asTask: boolean;
  setAsTask: (asTask: boolean) => void;
  sendMessage: (mentions?: any[]) => Promise<void>;
  chatTab: "chat" | "tasks";
  setChatTab: (tab: "chat" | "tasks") => void;
  openThread: (messageId: string) => void;
  createTask: (body: Record<string, unknown>) => Promise<void>;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openTaskThread: (task: Task) => void;
  setChannel: (channel: string) => void;
  setSection: (section: SectionId) => void;
  selectedAgent: Agent | null;
  openCreateAgent: () => void;
  openAgentDm: (agent: Agent) => Promise<void>;
  updateAgent: (agentId: string, patch: { name?: string; description?: string; model?: string | null }) => Promise<void>;
  deleteAgent: (agent: Agent) => Promise<void>;
  toggleAgent: (agent: Agent) => Promise<void>;
  selectedComputer: ComputerEntity | null;
  openConnectComputer: () => Promise<void>;
  deleteComputer: (computer: ComputerEntity) => Promise<void>;
  scheduledAgentId: string;
  selectScheduledAgent: (agentId: string) => void;
  updateScheduledTask: (task: ScheduledTask, patch: Record<string, unknown>) => Promise<void>;
  deleteScheduledTask: (task: ScheduledTask) => Promise<void>;
  refresh: (channelTarget?: string) => Promise<void>;
  selectedBotProvider: string | null;
  setSelectedBotProvider: (provider: string | null) => void;
  confirmDangerousAction: (request: ConfirmationRequest) => void;
}

export function MainView({
  state,
  section,
  channel,
  messages,
  message,
  setMessage,
  asTask,
  setAsTask,
  sendMessage,
  chatTab,
  setChatTab,
  openThread,
  createTask,
  updateTask,
  openTaskThread,
  setChannel,
  setSection,
  selectedAgent,
  openCreateAgent,
  openAgentDm,
  updateAgent,
  deleteAgent,
  toggleAgent,
  selectedComputer,
  openConnectComputer,
  deleteComputer,
  scheduledAgentId,
  selectScheduledAgent,
  updateScheduledTask,
  deleteScheduledTask,
  refresh,
  selectedBotProvider,
  setSelectedBotProvider,
  confirmDangerousAction
}: MainViewProps) {
  return (
    <main className="main">
      {section === "chat" && (
        <ChatViewComponent
          state={state}
          channel={channel}
          messages={messages}
          message={message}
          setMessage={setMessage}
          asTask={asTask}
          setAsTask={setAsTask}
          sendMessage={sendMessage}
          tab={chatTab}
          setTab={setChatTab}
          fetchOlderMessages={api.fetchMessages}
          formatTitle={formatChatTitle}
          resolveSubtitle={resolveChatSubtitle}
          getMentionMembers={getChatMentionMembers}
          collectMentions={collectChatMentions}
          renderMessage={item => <MessageRowComponent message={item} state={state} openThread={openThread} />}
          tasksView={
            <TasksViewComponent
              state={state}
              channel={channel}
              createTask={createTask}
              updateTask={updateTask}
              openTaskThread={openTaskThread}
            />
          }
        />
      )}
      {section === "tasks" && (
        <AllTasksViewComponent
          state={state}
          fetchTasks={api.fetchTasks}
          updateTask={updateTask}
          openTaskThread={openTaskThread}
          formatChatTitle={formatChatTitle}
          resolveChannel={resolveChannel}
          setChannel={setChannel}
          setSection={setSection}
        />
      )}
      {section === "members" && (
        <MembersViewComponent
          state={state}
          selectedAgent={selectedAgent}
          openCreateAgent={openCreateAgent}
          openAgentDm={openAgentDm}
          updateAgent={updateAgent}
          deleteAgent={deleteAgent}
          toggleAgent={toggleAgent}
        />
      )}
      {section === "computers" && (
        <ComputersViewComponent
          state={state}
          selectedComputer={selectedComputer}
          openConnectComputer={openConnectComputer}
          toggleAgent={toggleAgent}
          deleteComputer={deleteComputer}
        />
      )}
      {section === "scheduled" && (
        <ScheduledTasksViewComponent
          state={state}
          selectedAgentId={scheduledAgentId}
          selectAgent={selectScheduledAgent}
          updateScheduledTask={updateScheduledTask}
          deleteScheduledTask={deleteScheduledTask}
        />
      )}
      {section === "integrations" && (
        <IntegrationsViewComponent
          state={state}
          refresh={refresh}
          selectedBotProvider={selectedBotProvider}
          setSelectedBotProvider={setSelectedBotProvider}
          confirmDangerousAction={confirmDangerousAction}
          saveBotConfig={body => api.post<ExternalBotConfig>("/api/external/bot-configs", body)}
          deleteBotConfig={provider => api.del(`/api/external/bot-configs/${encodeURIComponent(provider)}`)}
        />
      )}
    </main>
  );
}
