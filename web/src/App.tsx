import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Computer,
  Copy,
  ExternalLink,
  Hash,
  Kanban,
  List,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Users,
  X
} from "lucide-react";
import UrlChangeReporter from "./UrlChangeReporter";
import "./styles.css";

// ---------- types ----------

type SectionId = "chat" | "tasks" | "members" | "computers" | "scheduled" | "integrations";
const NEW_BOT_PROVIDER = "__new_bot__";

interface Human {
  id: string;
  name: string;
  handle?: string;
  role?: string;
}

interface Agent {
  id: string;
  name: string;
  handle?: string;
  status: string;
  desiredStatus?: string;
  runtime: string;
  model?: string;
  reasoning?: string;
  workspacePath?: string;
  computerId?: string;
  lastRuntimeStatus?: {
    error?: string;
    [key: string]: unknown;
  };
}

interface Channel {
  id: string;
  name: string;
  target: string;
  kind?: string;
  description?: string;
  memberIds?: string[];
  messageCount?: number;
}

interface Message {
  id: string;
  target: string;
  authorId: string;
  text: string;
  type?: string;
  createdAt: string;
  threadId?: string | null;
  taskId?: string;
  replyCount?: number;
  depth?: number;
}

interface Task {
  id: string;
  number?: number;
  title: string;
  description?: string;
  status: string;
  target: string;
  messageId: string;
  threadTarget?: string;
  createdBy?: string;
  assigneeId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  replyCount?: number;
}

interface ScheduledTask {
  id: string;
  target: string;
  agentId: string;
  prompt: string;
  intervalMs: number | null;
  cronExpression?: string | null;
  timezone?: string | null;
  status: string;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastMessageId?: string | null;
  runCount: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface RuntimeInfo {
  id: string;
  name: string;
  installed: boolean;
}

interface ComputerEntity {
  id: string;
  name: string;
  status: string;
  connectionId?: string;
  connectToken?: string;
  daemonVersion?: string;
  fingerprint: { os: string; arch: string };
  runtimes: RuntimeInfo[];
}

interface ExternalBotConfig {
  provider: string;
  alias?: string | null;
  appId: string;
  appSecret?: string | null;
  domain?: string | null;
  enabled: boolean;
  status?: string | null;
  statusMessage?: string | null;
  lastConnectedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ExternalBotBinding {
  id: string;
  provider: string;
  tenantKey: string;
  chatId: string;
  chatType?: string | null;
  defaultTarget?: string | null;
  status: string;
}

interface AppState {
  humans: Human[];
  agents: Agent[];
  channels: Channel[];
  messages: Message[];
  tasks: Task[];
  scheduledTasks: ScheduledTask[];
  computers: ComputerEntity[];
  externalBotConfigs: ExternalBotConfig[];
  externalBotBindings: ExternalBotBinding[];
  events: unknown[];
}

interface ConnectInvite {
  id: string;
  command: string;
}

interface MentionMember {
  id: string;
  kind: "human" | "agent";
  name: string;
  handle: string;
  status: string;
}

interface MentionMatch {
  start: number;
  end: number;
  query: string;
}

// ---------- api ----------

const api = {
  async fetchTasks(filter: {
    target?: string;
    status?: string;
    assigneeId?: string;
    createdBy?: string;
    q?: string;
  } = {}): Promise<Task[]> {
    const params = new URLSearchParams();
    if (filter.target) params.set("target", filter.target);
    if (filter.status) params.set("status", filter.status);
    if (filter.assigneeId) params.set("assigneeId", filter.assigneeId);
    if (filter.createdBy) params.set("createdBy", filter.createdBy);
    if (filter.q) params.set("q", filter.q);
    const qs = params.toString();
    return fetch(`/api/tasks${qs ? `?${qs}` : ""}`).then(r => r.json());
  },
  async fetchMessages(channelTarget: string, before?: string, limit = 10): Promise<Message[]> {
    const selectedChannel = resolveChannel(
      await fetch("/api/channels").then(r => r.json()),
      channelTarget
    );
    if (!selectedChannel) return [];
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set("before", before);
    return fetch(`/api/messages/channel/${encodeURIComponent(selectedChannel.id)}?${params}`).then(r => r.json());
  },
  async getState(channelTarget = "#all"): Promise<AppState> {
    const [humans, agents, channels, tasks, scheduledTasks, computers, externalBotConfigs, externalBotBindings] = await Promise.all([
      fetch("/api/humans").then(r => r.json()),
      fetch("/api/agents").then(r => r.json()),
      fetch("/api/channels").then(r => r.json()),
      api.fetchTasks(),
      fetch("/api/scheduled-tasks").then(r => r.json()),
      fetch("/api/computers").then(r => r.json()),
      fetch("/api/external/bot-configs").then(r => r.json()),
      fetch("/api/external/bot-bindings").then(r => r.json())
    ]);
    const selectedChannel = resolveChannel(channels, channelTarget);
    const messages = selectedChannel
      ? await fetch(`/api/messages/channel/${encodeURIComponent(selectedChannel.id)}?limit=10`).then(r => r.json())
      : [];
    return { humans, agents, channels, messages, tasks, scheduledTasks, computers, externalBotConfigs, externalBotBindings, events: [] };
  },
  async post<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error);
    return res.json();
  },
  async patch<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(path, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error((await res.json()).error);
    return res.json();
  },
  async del<T = any>(path: string): Promise<T> {
    const res = await fetch(path, { method: "DELETE" });
    if (!res.ok) throw new Error((await res.json()).error);
    return res.json();
  }
};

// ---------- root ----------

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const initialRoute = useMemo(() => parseLocation(window.location), []);
  const [section, setSection] = useState<SectionId>(initialRoute.section);
  const [channel, setChannel] = useState(initialRoute.channel);
  const [chatTab, setChatTab] = useState<"chat" | "tasks">(initialRoute.chatTab);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialRoute.agentId);
  const [selectedComputerId, setSelectedComputerId] = useState<string | null>(initialRoute.computerId);
  const [scheduledAgentId, setScheduledAgentId] = useState("");
  const [selectedBotProvider, setSelectedBotProvider] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [asTask, setAsTask] = useState(false);
  const [agentName, setAgentName] = useState("codex");
  const [agentDescription, setAgentDescription] = useState("");
  const [runtime, setRuntime] = useState("");
  const [agentComputerId, setAgentComputerId] = useState("");
  const [agentModel, setAgentModel] = useState("");
  const [connectInvite, setConnectInvite] = useState<ConnectInvite | null>(null);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [renameChannel, setRenameChannel] = useState<Channel | null>(null);
  const [renameHuman, setRenameHuman] = useState<Human | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [channelsCollapsed, setChannelsCollapsed] = useState(false);
  const [threadRootId, setThreadRootIdState] = useState<string | null>(initialRoute.threadId);
  const [taskThreadRoot, setTaskThreadRoot] = useState<Message | null>(null);
  const [threadMessages, setThreadMessages] = useState<Message[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 272;
    const saved = Number(window.localStorage.getItem("iteam-sidebar-width"));
    return Number.isFinite(saved) && saved >= 200 && saved <= 600 ? saved : 272;
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!resizingSidebar) return;
    function onMove(event: MouseEvent) {
      const left = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const next = Math.min(600, Math.max(200, event.clientX - left));
      setSidebarWidth(next);
    }
    function onUp() {
      setResizingSidebar(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [resizingSidebar]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("iteam-sidebar-width", String(sidebarWidth));
  }, [sidebarWidth]);

  // ---- URL routing ----
  const setThreadRootId = (id: string | null) => setThreadRootIdState(id);

  // sync state -> URL
  useEffect(() => {
    if (!state) return;
    const next = buildPath(
      { section, channel, chatTab, agentId: selectedAgentId, computerId: selectedComputerId, threadId: threadRootId },
      state
    );
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", next);
    }
  }, [section, channel, chatTab, selectedAgentId, selectedComputerId, threadRootId, state]);

  // sync URL -> state on popstate (back/forward)
  useEffect(() => {
    function onPop() {
      const route = parseLocation(window.location);
      setSection(route.section);
      setChannel(route.channel);
      setChatTab(route.chatTab);
      if (route.agentId) setSelectedAgentId(route.agentId);
      if (route.computerId) setSelectedComputerId(route.computerId);
      setThreadRootIdState(route.threadId);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refresh(channelTarget = channel) {
    setState(await api.getState(channelTarget));
  }

  // Debounced refresh for SSE events to avoid rapid duplicate requests
  function debouncedRefresh(channelTarget = channel) {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => refresh(channelTarget), 200);
  }

  useEffect(() => {
    refresh(channel);
    const events = new EventSource("/api/events");
    events.addEventListener("state:changed", () => debouncedRefresh(channel));
    events.addEventListener("agent:activity", () => debouncedRefresh(channel));
    events.addEventListener("agent:started", () => debouncedRefresh(channel));
    events.addEventListener("agent:stopped", () => debouncedRefresh(channel));
    return () => {
      events.close();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [channel]);

  useEffect(() => {
    if (state?.agents?.length && !selectedAgentId) setSelectedAgentId(state.agents[0].id);
    if (state?.computers?.length && !selectedComputerId) setSelectedComputerId(state.computers[0].id);
    if (state?.computers?.length && !agentComputerId) setAgentComputerId(state.computers[0].id);
  }, [state, selectedAgentId, selectedComputerId, agentComputerId]);

  useEffect(() => {
    if (!scheduledAgentId || !state) return;
    const selectionExists = scheduledAgentId === "__missing__"
      ? state.scheduledTasks.some(task => !state.agents.some(agent => agent.id === task.agentId))
      : state.agents.some(agent => agent.id === scheduledAgentId) &&
        state.scheduledTasks.some(task => task.agentId === scheduledAgentId);
    if (!selectionExists) {
      setScheduledAgentId("");
    }
  }, [scheduledAgentId, state]);

  useEffect(() => {
    if (!state || selectedBotProvider === NEW_BOT_PROVIDER) return;
    const larkConfigs = state.externalBotConfigs.filter(config => config.provider.startsWith("lark") || config.provider.startsWith("feishu"));
    if (selectedBotProvider && !larkConfigs.some(config => config.provider === selectedBotProvider)) {
      setSelectedBotProvider(null);
    }
  }, [state, selectedBotProvider]);

  // resolve dm:<handle> in URL into dm:<agentId> once state arrives
  useEffect(() => {
    if (!state) return;
    if (!channel.startsWith("dm:")) return;
    const ref = channel.slice(3);
    if (state.agents.some(a => a.id === ref)) return;
    const agent = state.agents.find(a => a.handle === ref || slugHandle(a.name) === ref);
    if (agent) setChannel(`dm:${agent.id}`);
  }, [state, channel]);

  const selectedAgent = state?.agents.find(a => a.id === selectedAgentId) || null;
  const selectedComputer = state?.computers.find(c => c.id === selectedComputerId) || null;
  const channelMessages = useMemo(() => state?.messages || [], [state]);
  const threadRoot = (
    taskThreadRoot && taskThreadRoot.id === threadRootId
      ? taskThreadRoot
      : state?.messages.find(m => m.id === threadRootId)
  ) || null;
  const threadTarget = threadRoot ? `${threadRoot.target}:${threadRoot.id}` : null;

  function openThread(messageId: string) {
    setTaskThreadRoot(null);
    setThreadRootId(messageId);
  }

  function openTaskThread(task: Task) {
    setTaskThreadRoot(taskToRootMessage(task));
    setThreadRootId(task.messageId);
  }

  async function loadThreadMessages(target: string) {
    const messages = await fetch(`/api/messages?target=${encodeURIComponent(target)}&limit=50`).then(r => r.json());
    setThreadMessages(messages);
  }

  // Depend on `state` so the open thread re-fetches whenever the SSE-driven
  // channel refresh produces a new state. Thread replies live under a
  // different target than the parent channel and `listMessagesByChannel`
  // filters them out (`!message.threadId`), so they never arrive via the
  // channel-level refresh on their own.
  useEffect(() => {
    if (!threadTarget) {
      setThreadMessages([]);
      return;
    }
    let alive = true;
    fetch(`/api/messages?target=${encodeURIComponent(threadTarget)}&limit=50`)
      .then(r => r.json())
      .then(messages => {
        if (alive) setThreadMessages(messages);
      });
    return () => {
      alive = false;
    };
  }, [threadTarget, state]);

  async function sendMessage(mentions: any[] = []) {
    if (!message.trim()) return;
    if (asTask) {
      await api.post("/api/tasks", {
        target: channel,
        title: message,
        assigneeId: selectedAgentId || null
      });
    } else {
      await api.post("/api/messages", {
        target: channel,
        text: message,
        authorId: "human-local",
        mentions,
        defaultAgentId: selectedAgentId || null
      });
    }
    setMessage("");
    setAsTask(false);
    refresh(channel);
  }

  async function sendThreadMessage(target: string, text: string, mentions: any[] = []) {
    if (!target || !text.trim()) return;
    // Threads continue a conversation with a specific agent. Prefer the
    // thread root's author when it's an agent; otherwise fall back to the
    // sidebar default. Without this, an un-@mentioned reply in a thread
    // rooted by agent A would still get delivered to whichever agent the
    // sidebar happens to have selected.
    const rootAuthorIsAgent =
      threadRoot && state?.agents.some(a => a.id === threadRoot.authorId);
    const threadDefaultAgentId = rootAuthorIsAgent
      ? threadRoot!.authorId
      : selectedAgentId || null;
    await api.post("/api/messages", {
      target,
      text,
      authorId: "human-local",
      mentions,
      defaultAgentId: threadDefaultAgentId
    });
    await loadThreadMessages(target);
    refresh(channel);
  }

  async function createTask(body: Record<string, unknown>) {
    const task = await api.post<Task>("/api/tasks", { target: channel, ...body });
    setTaskThreadRoot(taskToRootMessage(task));
    setThreadRootId(task.messageId);
    refresh();
  }

  async function updateTask(task: Task, patch: Record<string, unknown>) {
    await api.patch(`/api/tasks/${task.id}`, patch);
    refresh();
  }

  async function updateScheduledTask(task: ScheduledTask, patch: Record<string, unknown>) {
    await api.patch(`/api/scheduled-tasks/${task.id}`, patch);
    refresh();
  }

  async function deleteScheduledTask(task: ScheduledTask) {
    if (!window.confirm(`Delete scheduled task for ${task.target}?`)) return;
    await api.del(`/api/scheduled-tasks/${task.id}`);
    refresh();
  }

  async function createAgent() {
    const agent = await api.post<Agent>("/api/agents", {
      name: agentName.trim(),
      description: agentDescription,
      runtime: runtime.trim(),
      model: agentModel,
      computerId: agentComputerId
    });
    setSelectedAgentId(agent.id);
    setRuntime("");
    setCreateAgentOpen(false);
    refresh();
  }

  async function openConnectComputer() {
    const invite = await api.post<ConnectInvite>("/api/computers/connect-command", {});
    setConnectInvite(invite);
    refresh();
  }

  async function toggleAgent(agent: Agent) {
    await api.post(`/api/agents/${agent.id}/${isAgentStopped(agent) ? "start" : "stop"}`);
    refresh();
  }

  async function deleteComputer(computer: ComputerEntity) {
    if (!window.confirm(`Delete ${computer.name}? This removes all agents on this computer.`)) return;
    await api.del(`/api/computers/${encodeURIComponent(computer.id)}`);
    if (selectedComputerId === computer.id) setSelectedComputerId(null);
    refresh();
  }

  async function updateAgent(agentId: string, patch: { name?: string; description?: string; model?: string | null }) {
    await api.patch(`/api/agents/${agentId}`, patch);
    refresh();
  }

  async function updateHuman(humanId: string, name: string) {
    await api.patch(`/api/humans/${encodeURIComponent(humanId)}`, { name });
    setRenameHuman(null);
    refresh();
  }

  async function createChannel(body: { name: string; description?: string }) {
    const created = await api.post<Channel>("/api/channels", body);
    setChannel(created.target);
    setSection("chat");
    setCreateChannelOpen(false);
    refresh(created.target);
  }

  async function updateChannel(channelId: string, body: { name?: string; description?: string }) {
    const updated = await api.patch<Channel>(`/api/channels/${encodeURIComponent(channelId)}`, body);
    setChannel(updated.target);
    setRenameChannel(null);
    refresh(updated.target);
  }

  async function openAgentDm(agent: Agent) {
    const dm = await api.post<Channel>(`/api/direct-messages/agents/${encodeURIComponent(agent.id)}`);
    setSelectedAgentId(agent.id);
    setChannel(dm.target);
    setSection("chat");
    refresh(dm.target);
  }

  const connectedInvite =
    connectInvite && state ? state.computers.find(c => c.connectionId === connectInvite.id) || null : null;

  if (!state) {
    return (
      <div className="boot">
        <span className="brand-spike" aria-hidden />
        <span className="boot-text">Booting iTeam.</span>
      </div>
    );
  }

  return (
    <div
      className={`app ${sidebarCollapsed ? "is-sidebar-collapsed" : ""} ${resizingSidebar ? "is-sidebar-resizing" : ""}`}
      style={{ ["--sidebar-width" as any]: `${sidebarWidth}px` }}
    >
      <UrlChangeReporter />
      <nav className="rail" aria-label="Primary">
        <div className="brand">
          <span className="brand-spike" aria-hidden />
          <span className="brand-word">iTeam</span>
        </div>
        <div className="rail-nav">
          <RailButton
            active={section === "chat" || section === "tasks"}
            label="Chat"
            icon={<MessageSquare size={18} />}
            onClick={() => setSection("chat")}
          />
          <RailButton
            active={section === "members"}
            label="Members"
            icon={<Users size={18} />}
            onClick={() => setSection("members")}
          />
          <RailButton
            active={section === "computers"}
            label="Computers"
            icon={<Computer size={18} />}
            onClick={() => setSection("computers")}
          />
          <RailButton
            active={section === "scheduled"}
            label="Scheduled"
            icon={<List size={18} />}
            onClick={() => setSection("scheduled")}
          />
          <RailButton
            active={section === "integrations"}
            label="Bots"
            icon={<Bot size={18} />}
            onClick={() => setSection("integrations")}
          />
        </div>
        <div className="rail-foot">
          <button className="ghost-btn" title="Refresh" onClick={() => refresh()}>
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
        </div>
      </nav>

      <aside className="sidebar" aria-label={titleFor(section)} ref={sidebarRef}>
        <button
          className="sidebar-toggle"
          title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setSidebarCollapsed(value => !value)}
        >
          {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
        <header className="sidebar-head">
          <p className="eyebrow">Workspace</p>
          <h2>{titleFor(section)}</h2>
        </header>
        {(section === "chat" || section === "tasks") && (
          <ChatSidebar
            state={state}
            section={section}
            setSection={setSection}
            channel={channel}
            setChannel={setChannel}
            channelsCollapsed={channelsCollapsed}
            setChannelsCollapsed={setChannelsCollapsed}
            openCreateChannel={() => setCreateChannelOpen(true)}
            openRenameChannel={setRenameChannel}
            openAgentDm={openAgentDm}
            setSelectedAgentId={setSelectedAgentId}
          />
        )}
        {section === "computers" && (
          <ComputersSidebar
            state={state}
            selectedComputerId={selectedComputerId}
            setSelectedComputerId={setSelectedComputerId}
            openConnectComputer={openConnectComputer}
          />
        )}
        {section === "scheduled" && (
          <ScheduledSidebar
            state={state}
            selectedAgentId={scheduledAgentId}
            selectAgent={setScheduledAgentId}
          />
        )}
        {section === "members" && (
          <MembersSidebar
            state={state}
            selectedAgentId={selectedAgentId}
            setSelectedAgentId={setSelectedAgentId}
            openCreateAgent={() => setCreateAgentOpen(true)}
            openRenameHuman={setRenameHuman}
          />
        )}
        {section === "integrations" && (
          <IntegrationsSidebar
            state={state}
            selectedBotProvider={selectedBotProvider}
            setSelectedBotProvider={setSelectedBotProvider}
          />
        )}
        {!sidebarCollapsed && (
          <div
            className="sidebar-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onMouseDown={event => {
              event.preventDefault();
              setResizingSidebar(true);
            }}
            onDoubleClick={() => setSidebarWidth(272)}
          />
        )}
      </aside>

      <main className="main">
        {section === "chat" && (
          <ChatView
            state={state}
            channel={channel}
            messages={channelMessages}
            message={message}
            setMessage={setMessage}
            asTask={asTask}
            setAsTask={setAsTask}
            sendMessage={sendMessage}
            createTask={createTask}
            updateTask={updateTask}
            openThread={openThread}
            openTaskThread={openTaskThread}
            tab={chatTab}
            setTab={setChatTab}
          />
        )}
        {section === "tasks" && (
          <AllTasksView
            state={state}
            updateTask={updateTask}
            openTaskThread={openTaskThread}
            setChannel={setChannel}
            setSection={setSection}
          />
        )}
        {section === "members" && (
          <MembersView
            state={state}
            selectedAgent={selectedAgent}
            openCreateAgent={() => setCreateAgentOpen(true)}
            openAgentDm={openAgentDm}
            updateAgent={updateAgent}
            refresh={refresh}
          />
        )}
        {section === "computers" && (
          <ComputersView
            state={state}
            selectedComputer={selectedComputer}
            openConnectComputer={openConnectComputer}
            toggleAgent={toggleAgent}
            deleteComputer={deleteComputer}
          />
        )}
        {section === "scheduled" && (
          <ScheduledTasksView
            state={state}
            selectedAgentId={scheduledAgentId}
            selectAgent={setScheduledAgentId}
            updateScheduledTask={updateScheduledTask}
            deleteScheduledTask={deleteScheduledTask}
          />
        )}
        {section === "integrations" && (
          <IntegrationsView
            state={state}
            refresh={refresh}
            selectedBotProvider={selectedBotProvider}
            setSelectedBotProvider={setSelectedBotProvider}
          />
        )}
      </main>

      {connectInvite && (
        <ConnectComputerModal
          invite={connectInvite}
          connectedComputer={connectedInvite}
          onClose={() => setConnectInvite(null)}
        />
      )}
      {createAgentOpen && (
        <CreateAgentModal
          state={state}
          agentName={agentName}
          setAgentName={setAgentName}
          agentDescription={agentDescription}
          setAgentDescription={setAgentDescription}
          runtime={runtime}
          setRuntime={setRuntime}
          agentComputerId={agentComputerId}
          setAgentComputerId={setAgentComputerId}
          agentModel={agentModel}
          setAgentModel={setAgentModel}
          createAgent={createAgent}
          onClose={() => setCreateAgentOpen(false)}
        />
      )}
      {createChannelOpen && (
        <CreateChannelModal
          onCreate={createChannel}
          onClose={() => setCreateChannelOpen(false)}
        />
      )}
      {renameChannel && (
        <RenameChannelModal
          channel={renameChannel}
          onRename={updateChannel}
          onClose={() => setRenameChannel(null)}
        />
      )}
      {renameHuman && (
        <RenameHumanModal
          human={renameHuman}
          onRename={updateHuman}
          onClose={() => setRenameHuman(null)}
        />
      )}
      {threadRoot && (
        <ThreadPanel
          state={state}
          root={threadRoot}
          messages={threadMessages}
          onClose={() => {
            setThreadRootId(null);
            setTaskThreadRoot(null);
          }}
          onViewChannel={() => {
            setSection("chat");
            setChatTab("chat");
            if (threadRoot) setChannel(threadRoot.target);
            setThreadRootId(null);
            setTaskThreadRoot(null);
            requestAnimationFrame(() => {
              if (!threadRoot) return;
              const el = document.querySelector(
                `[data-message-id="${threadRoot.id}"]`
              ) as HTMLElement | null;
              if (el) {
                el.scrollIntoView({ behavior: "smooth", block: "center" });
                el.classList.add("msg-flash");
                setTimeout(() => el.classList.remove("msg-flash"), 1600);
              }
            });
          }}
          onSend={sendThreadMessage}
        />
      )}
    </div>
  );
}

// ---------- shared bits ----------

function RailButton({
  active,
  label,
  icon,
  onClick
}: {
  active?: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button className={`rail-btn ${active ? "is-active" : ""}`} title={label} aria-label={label} onClick={onClick}>
      <span className="rail-btn-icon">{icon}</span>
      <span className="rail-btn-label">{label}</span>
      {active && <span className="rail-btn-mark" aria-hidden />}
    </button>
  );
}

function titleFor(section: SectionId): string {
  return ({ chat: "Channels", tasks: "Channels", members: "Members", computers: "Computers", scheduled: "Scheduled", integrations: "Bots" } as const)[section];
}

function ChatSidebar({
  state,
  section,
  setSection,
  channel,
  setChannel,
  channelsCollapsed,
  setChannelsCollapsed,
  openCreateChannel,
  openRenameChannel,
  openAgentDm,
  setSelectedAgentId
}: {
  state: AppState;
  section: SectionId;
  setSection: (section: SectionId) => void;
  channel: string;
  setChannel: (c: string) => void;
  channelsCollapsed: boolean;
  setChannelsCollapsed: (value: boolean) => void;
  openCreateChannel: () => void;
  openRenameChannel: (channel: Channel) => void;
  openAgentDm: (agent: Agent) => void;
  setSelectedAgentId: (id: string) => void;
}) {
  const publicChannels = state.channels.filter(channel => channel.kind !== "dm");
  const dmChannels = state.channels.filter(channel => channel.kind === "dm");
  return (
    <>
      <SectionLabel
        action={
          <span className="side-actions">
            <button
              className="side-add"
              title={channelsCollapsed ? "Expand channels" : "Collapse channels"}
              onClick={() => setChannelsCollapsed(!channelsCollapsed)}
            >
              {channelsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
            <button className="side-add" onClick={openCreateChannel} title="Create channel">
              <Plus size={14} />
            </button>
          </span>
        }
      >
        Channels · {publicChannels.length}
      </SectionLabel>
      <button
        className={`side-row channel-row ${section === "tasks" ? "is-selected" : ""}`}
        onClick={() => setSection("tasks")}
      >
        <Kanban size={15} />
        <span>Task</span>
        <small>{state.tasks.length}</small>
      </button>
      {!channelsCollapsed && (
        <div className="side-collapsible">
          {publicChannels.map(c => {
            const protectedChannel = isProtectedChannel(c);
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                className={`side-row channel-row ${section === "chat" && channel === c.target ? "is-selected" : ""}`}
                onClick={() => {
                  setChannel(c.target);
                  setSection("chat");
                }}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") {
                    setChannel(c.target);
                    setSection("chat");
                  }
                }}
              >
                <Hash size={15} />
                <span>{c.name}</span>
                {!protectedChannel && (
                  <button
                    className="row-icon-btn"
                    title="Rename channel"
                    onClick={event => {
                      event.stopPropagation();
                      openRenameChannel(c);
                    }}
                  >
                    <Pencil size={13} />
                  </button>
                )}
                <small>{channelMessageCount(state, c, channel)}</small>
              </div>
            );
          })}
        </div>
      )}
      <SectionLabel>Direct messages</SectionLabel>
      {dmChannels.length ? (
        <div className="side-collapsible">
          {dmChannels.map(dm => {
            const agent = agentForDm(state, dm);
            return (
              <button
                key={dm.id}
                className={`side-row member ${section === "chat" && channel === dm.target ? "is-selected" : ""}`}
                onClick={() => {
                  if (agent) setSelectedAgentId(agent.id);
                  setChannel(dm.target);
                  setSection("chat");
                }}
              >
                <Avatar name={agent?.name || dm.name} agent />
                <span>{agent?.name || dm.name}</span>
                <small>@{agent?.handle || slugHandle(dm.name)}</small>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="side-empty">No DMs yet — start one from a member's profile.</p>
      )}
      {state.agents.some(agent => !dmChannels.some(dm => dm.memberIds?.includes(agent.id))) && (
        <div className="dm-start-list">
          {state.agents
            .filter(agent => !dmChannels.some(dm => dm.memberIds?.includes(agent.id)))
            .map(agent => (
              <button key={agent.id} className="side-row member ghost" onClick={() => openAgentDm(agent)}>
                <Avatar name={agent.name} agent />
                <span>{agent.name}</span>
                <small>start</small>
              </button>
            ))}
        </div>
      )}
    </>
  );
}

function MembersSidebar({
  state,
  selectedAgentId,
  setSelectedAgentId,
  openCreateAgent,
  openRenameHuman
}: {
  state: AppState;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string) => void;
  openCreateAgent: () => void;
  openRenameHuman: (human: Human) => void;
}) {
  const agentGroups = groupAgentsByComputer(state);

  return (
    <>
      <SectionLabel
        action={
          <button className="side-add" onClick={openCreateAgent} title="Create agent">
            <Plus size={14} />
          </button>
        }
      >
        Agents · {state.agents.length}
      </SectionLabel>
      {agentGroups.map(group => (
        <div className="side-agent-group" key={group.id}>
          <div className="side-agent-group-head">
            <Computer size={12} />
            <span>{group.name}</span>
            <small className={`status-dot ${group.status}`}>{group.agents.length}</small>
          </div>
          {group.agents.map(a => (
            <button
              key={a.id}
              className={`side-row member ${selectedAgentId === a.id ? "is-selected" : ""}`}
              onClick={() => setSelectedAgentId(a.id)}
            >
              <Avatar name={a.name} agent />
              <span>{a.name}</span>
              <small>{a.status}</small>
            </button>
          ))}
        </div>
      ))}
      {!state.agents.length && (
        <button className="empty-cta" onClick={openCreateAgent}>
          <Plus size={14} /> Create your first agent
        </button>
      )}
      <SectionLabel>Humans · {state.humans.length}</SectionLabel>
      {state.humans.map(h => (
        <div className="side-row member" key={h.id}>
          <Avatar name={h.name} />
          <span>{h.name}</span>
          <small>you</small>
          <button
            className="row-icon-btn human-rename"
            title={`Rename ${h.name}`}
            aria-label={`Rename ${h.name}`}
            onClick={() => openRenameHuman(h)}
          >
            <Pencil size={13} />
          </button>
        </div>
      ))}
    </>
  );
}

function ComputersSidebar({
  state,
  selectedComputerId,
  setSelectedComputerId,
  openConnectComputer
}: {
  state: AppState;
  selectedComputerId: string | null;
  setSelectedComputerId: (id: string) => void;
  openConnectComputer: () => void;
}) {
  return (
    <>
      <SectionLabel
        action={
          <button className="side-add" onClick={openConnectComputer} title="Connect computer">
            <Plus size={14} />
          </button>
        }
      >
        Computers · {state.computers.length}
      </SectionLabel>
      {state.computers.map(c => (
        <button
          key={c.id}
          className={`side-row computer ${selectedComputerId === c.id ? "is-selected" : ""}`}
          onClick={() => setSelectedComputerId(c.id)}
        >
          <span className="computer-tile">
            <Computer size={18} />
          </span>
          <span>{c.name}</span>
          <small className={`status-dot ${c.status}`}>{c.status}</small>
        </button>
      ))}
      {!state.computers.length && (
        <button className="empty-cta" onClick={openConnectComputer}>
          <Plus size={14} /> Connect a computer
        </button>
      )}
    </>
  );
}

function ScheduledSidebar({
  state,
  selectedAgentId,
  selectAgent
}: {
  state: AppState;
  selectedAgentId: string;
  selectAgent: (agentId: string) => void;
}) {
  const active = state.scheduledTasks.filter(task => task.status === "active").length;
  const assignedAgents = state.agents
    .map(agent => ({
      agent,
      tasks: state.scheduledTasks.filter(task => task.agentId === agent.id)
    }))
    .filter(group => group.tasks.length > 0);
  const missingAgentTasks = state.scheduledTasks.filter(
    task => !state.agents.some(agent => agent.id === task.agentId)
  );

  return (
    <>
      <SectionLabel>Agents with schedules · {assignedAgents.length}</SectionLabel>
      {!!state.scheduledTasks.length && (
        <button
          className={`side-row schedule-agent-row ${selectedAgentId === "" ? "is-selected" : ""}`}
          onClick={() => selectAgent("")}
        >
          <span className="computer-tile">
            <List size={16} />
          </span>
          <span>All schedules</span>
          <span className="schedule-agent-count">{state.scheduledTasks.length}</span>
        </button>
      )}
      {assignedAgents.map(({ agent, tasks }) => {
        const activeTasks = tasks.filter(task => task.status === "active").length;
        return (
          <button
            key={agent.id}
            className={`side-row schedule-agent-row ${selectedAgentId === agent.id ? "is-selected" : ""}`}
            onClick={() => selectAgent(agent.id)}
          >
            <Avatar name={agent.name} agent />
            <span>
              <strong>@{agent.handle || agent.name}</strong>
              <small>{activeTasks} active</small>
            </span>
            <span className="schedule-agent-count">{tasks.length}</span>
          </button>
        );
      })}
      {!!missingAgentTasks.length && (
        <button
          className={`side-row schedule-agent-row ${selectedAgentId === "__missing__" ? "is-selected" : ""}`}
          onClick={() => selectAgent("__missing__")}
        >
          <span className="computer-tile">
            <Bot size={16} />
          </span>
          <span>
            <strong>Missing agent</strong>
            <small>Assignment unavailable</small>
          </span>
          <span className="schedule-agent-count">{missingAgentTasks.length}</span>
        </button>
      )}
      {!state.scheduledTasks.length && (
        <p className="side-empty">No schedules yet — ask an agent “每隔 10 分钟…”, and it can declare one.</p>
      )}
      <SectionLabel>Summary</SectionLabel>
      <div className="side-row member">
        <span>{active} active</span>
        <small>{state.scheduledTasks.length - active} paused</small>
      </div>
    </>
  );
}

function SectionLabel({
  children,
  action
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="side-section-label">
      <span>{children}</span>
      {action}
    </div>
  );
}

// ---------- chat ----------

function ChatView({
  state,
  channel,
  messages,
  message,
  setMessage,
  asTask,
  setAsTask,
  sendMessage,
  createTask,
  updateTask,
  openThread,
  openTaskThread,
  tab,
  setTab
}: {
  state: AppState;
  channel: string;
  messages: Message[];
  message: string;
  setMessage: (s: string) => void;
  asTask: boolean;
  setAsTask: (b: boolean) => void;
  sendMessage: (mentions?: any[]) => void;
  createTask: (body: Record<string, unknown>) => Promise<void>;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openThread: (id: string) => void;
  openTaskThread: (task: Task) => void;
  tab: "chat" | "tasks";
  setTab: (tab: "chat" | "tasks") => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const oldestIdRef = useRef<string | null>(null);
  const mentionMembers = useMemo(() => getMentionMembers(state, channel), [state, channel]);
  const mentionOptions = useMemo(() => {
    if (!mentionMatch) return [];
    const query = mentionMatch.query.toLowerCase();
    return mentionMembers
      .filter(member =>
        member.handle.toLowerCase().includes(query) || member.name.toLowerCase().includes(query)
      )
      .slice(0, 8);
  }, [mentionMatch, mentionMembers]);

  // Reset pagination when channel changes
  useEffect(() => {
    setOlderMessages([]);
    setHasMore(true);
    oldestIdRef.current = null;
  }, [channel]);

  const previousScrollHeightRef = useRef(0);
  const previousScrollTopRef = useRef(0);

  async function loadOlder() {
    if (!hasMore || loadingOlder) return;
    const cursor = oldestIdRef.current || (messages.length > 0 ? messages[0].id : null);
    if (!cursor) { setHasMore(false); return; }
    setLoadingOlder(true);

    if (listRef.current) {
      previousScrollHeightRef.current = listRef.current.scrollHeight;
      previousScrollTopRef.current = listRef.current.scrollTop;
    }

    try {
      const older = await api.fetchMessages(channel, cursor);
      if (older.length === 0) {
        setHasMore(false);
      } else {
        oldestIdRef.current = older[0].id;
        setOlderMessages(prev => {
          const existing = new Set(prev.map(m => m.id));
          const unique = older.filter(m => !existing.has(m.id));
          return [...unique, ...prev];
        });
      }
    } catch {
      // ignore
    } finally {
      setLoadingOlder(false);
    }
  }

  // Keep a ref to loadOlder so the scroll handler always calls the latest version
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;

  // Use IntersectionObserver on the top element to trigger load
  const topObserverRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = topObserverRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) {
          loadOlderRef.current();
        }
      },
      { root: listRef.current, rootMargin: "100px 0px 0px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [tab]);

  const allMessages = useMemo(() => {
    const existing = new Set(messages.map(m => m.id));
    const uniqueOlder = olderMessages.filter(m => !existing.has(m.id));
    return [...uniqueOlder, ...messages];
  }, [olderMessages, messages]);

  // Restore scroll position after loading older messages
  useLayoutEffect(() => {
    if (listRef.current && previousScrollHeightRef.current > 0) {
      const newScrollHeight = listRef.current.scrollHeight;
      const heightDifference = newScrollHeight - previousScrollHeightRef.current;
      if (heightDifference > 0) {
        listRef.current.scrollTop = previousScrollTopRef.current + heightDifference;
      }
      previousScrollHeightRef.current = 0;
    }
  }, [allMessages]);

  function refreshMention(target: HTMLTextAreaElement | null = textareaRef.current) {
    if (!target) return;
    const match = findMentionMatch(target.value, target.selectionStart || 0);
    setMentionMatch(match);
    setMentionIndex(0);
  }

  function insertMention(member: MentionMember) {
    if (!mentionMatch) return;
    const before = message.slice(0, mentionMatch.start);
    const after = message.slice(mentionMatch.end);
    const next = `${before}@${member.handle} ${after}`;
    const cursor = before.length + member.handle.length + 2;
    setMessage(next);
    setMentionMatch(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionMatch && mentionOptions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex(i => (i + 1) % mentionOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(i => (i - 1 + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(mentionOptions[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionMatch(null);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      sendMessage(collectMentions(message, mentionMembers));
    }
  }

  function handleSend() {
    sendMessage(collectMentions(message, mentionMembers));
  }

  return (
    <section className="pane chat-pane" ref={listRef}>
      <Topbar
        eyebrow={channel.startsWith("dm:") ? "Direct message" : "Channel"}
        title={formatChatTitle(state, channel)}
        subtitle={resolveChatSubtitle(state, channel)}
      />
      <div className="pane-tabs">
        <button className={tab === "chat" ? "is-active" : ""} onClick={() => setTab("chat")}>
          <MessageSquare size={14} /> Chat
        </button>
        <button className={tab === "tasks" ? "is-active" : ""} onClick={() => setTab("tasks")}>
          <Kanban size={14} /> Tasks
        </button>
      </div>
      {tab === "chat" ? (
        <>
          <div className="message-list">
            <div ref={topObserverRef} style={{ height: 1, flexShrink: 0 }} />
            {loadingOlder && <div className="message-loading">Loading older messages...</div>}
            {!hasMore && allMessages.length > 0 && (
              <div className="message-loading">Beginning of channel</div>
            )}
            {allMessages.length === 0 && (
              <div className="message-empty">
                <span className="brand-spike" aria-hidden />
                <h3>Quiet here.</h3>
                <p>Drop a thought, summon an agent with @, or kick off a task.</p>
              </div>
            )}
            {allMessages.map(m => (
              <MessageRow key={m.id} message={m} state={state} openThread={openThread} />
            ))}
          </div>
          <div className="composer">
            {mentionMatch && (
              <MentionMenu options={mentionOptions} activeIndex={mentionIndex} onPick={insertMention} />
            )}
            <textarea
              ref={textareaRef}
              value={message}
              onChange={e => {
                setMessage(e.target.value);
                refreshMention(e.target);
              }}
              onClick={e => refreshMention(e.target as HTMLTextAreaElement)}
              onKeyUp={e => {
                if (mentionMatch && isMentionNavigationKey(e.key)) return;
                refreshMention(e.target as HTMLTextAreaElement);
              }}
              placeholder={`Message ${channel}`}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="composer-bar">
              <label className="task-toggle">
                <input type="checkbox" checked={asTask} onChange={e => setAsTask(e.target.checked)} />
                <span>Send as task</span>
              </label>
              <span className="composer-hint">⌘ ⏎ to send</span>
              <button className="btn btn-primary" onClick={handleSend}>
                <Send size={15} /> <span>Send</span>
              </button>
            </div>
          </div>
        </>
      ) : (
        <TasksView
          state={state}
          channel={channel}
          createTask={createTask}
          updateTask={updateTask}
          openTaskThread={openTaskThread}
        />
      )}
    </section>
  );
}

function MentionMenu({
  options,
  activeIndex,
  onPick
}: {
  options: MentionMember[];
  activeIndex: number;
  onPick: (m: MentionMember) => void;
}) {
  return (
    <div className="mention-menu">
      {options.length === 0 && <div className="mention-empty">No matching members</div>}
      {options.map((member, index) => (
        <button
          key={`${member.kind}-${member.id}`}
          className={`mention-option ${index === activeIndex ? "is-active" : ""}`}
          onMouseDown={event => {
            event.preventDefault();
            onPick(member);
          }}
        >
          <Avatar name={member.name} agent={member.kind === "agent"} />
          <span>{member.name}</span>
          <small>@{member.handle}</small>
        </button>
      ))}
    </div>
  );
}

function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="tt-anchor"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && <span className="tt-bubble" role="tooltip">{label}</span>}
    </span>
  );
}

function MessageRow({
  message,
  state,
  openThread
}: {
  message: Message;
  state: AppState;
  openThread?: (id: string) => void;
}) {
  const agent = state.agents.find(a => a.id === message.authorId);
  const human = state.humans.find(h => h.id === message.authorId);
  const ingressBot = resolveIngressBotAuthor(state, message.authorId);
  const author = agent || human || ingressBot || { name: message.authorId, role: "system" };
  const task = state.tasks.find(t => t.id === message.taskId || t.messageId === message.id);
  const replyCount = countThreadReplies(state, message);
  return (
    <article className={`msg ${message.type || "chat"}`} data-message-id={message.id}>
      <Avatar name={author.name} agent={!!agent} />
      <div className="msg-body">
        <header>
          <strong>{author.name}</strong>
          {message.depth !== undefined && message.depth > 0 && (
            <span className="depth-badge" title={`第 ${message.depth + 1} 轮`}>R{message.depth + 1}</span>
          )}
          <Tooltip label={new Date(message.createdAt).toLocaleString()}>
            <small>{new Date(message.createdAt).toLocaleTimeString()}</small>
          </Tooltip>
        </header>
        <MessageContent text={message.text} agent={!!agent} />
        <div className="msg-actions">
          {task && (
            <button className="chip chip-task" onClick={() => openThread?.(message.id)}>
              <span className={`status-pip ${task.status}`} />#{task.number} · {task.status}
            </button>
          )}
          <button
            className={`chip chip-reply ${replyCount ? "has-replies" : ""}`}
            onClick={() => openThread?.(message.id)}
          >
            <MessageSquare size={13} /> {replyCount ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Reply"}
          </button>
        </div>
      </div>
    </article>
  );
}

function resolveIngressBotAuthor(state: AppState, authorId: string): { name: string; role: string } | null {
  if (!authorId.startsWith("ingress:")) return null;
  const provider = authorId.slice("ingress:".length);
  const config = state.externalBotConfigs.find(config => config.provider === provider);
  if (!config) return null;
  return {
    name: config.alias || config.appId || config.provider,
    role: "external-bot"
  };
}

// ---------- tasks ----------

function TasksView({
  state,
  channel,
  createTask,
  updateTask,
  openTaskThread
}: {
  state: AppState;
  channel: string;
  createTask: (body: Record<string, unknown>) => Promise<void>;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openTaskThread: (task: Task) => void;
}) {
  const [view, setView] = useState<"board" | "list">("board");
  const [creator, setCreator] = useState("");
  const [assignee, setAssignee] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const tasks = state.tasks.filter(
    task =>
      task.target === channel &&
      (!creator || task.createdBy === creator) &&
      (!assignee || task.assigneeId === assignee)
  );
  const statuses = taskStatuses();

  async function createFromModal(body: Record<string, unknown>) {
    await createTask(body);
    setCreateOpen(false);
  }

  return (
    <section className="tasks-pane chat-tasks-pane">
      <div className="task-toolbar">
        <label className="select-shell">
          <span>Creator</span>
          <select value={creator} onChange={e => setCreator(e.target.value)}>
            <option value="">Anyone</option>
            {state.humans.map(h => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
            {state.agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="select-shell">
          <span>Assignee</span>
          <select value={assignee} onChange={e => setAssignee(e.target.value)}>
            <option value="">Anyone</option>
            {state.agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <span className="toolbar-spacer" />
        <div className="seg">
          <button className={view === "board" ? "is-active" : ""} onClick={() => setView("board")}>
            <Kanban size={14} /> Board
          </button>
          <button className={view === "list" ? "is-active" : ""} onClick={() => setView("list")}>
            <List size={14} /> List
          </button>
        </div>
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
          <Plus size={14} /> New task
        </button>
      </div>
      {view === "board" ? (
        <div className="task-board">
          {statuses.map(status => {
            const columnTasks = tasks.filter(t => t.status === status.id);
            return (
              <section className="task-column" key={status.id}>
                <header>
                  <span className={`status-pill ${status.id}`}>{status.label}</span>
                  <small>{columnTasks.length}</small>
                </header>
                <div className="task-column-body">
                  {columnTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      state={state}
                      updateTask={updateTask}
                      openTaskThread={openTaskThread}
                    />
                  ))}
                  {columnTasks.length === 0 && (
                    <div className="task-empty">No {status.label.toLowerCase()} tasks.</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="task-list">
          {tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              state={state}
              updateTask={updateTask}
              openTaskThread={openTaskThread}
              list
            />
          ))}
          {tasks.length === 0 && <div className="empty">No tasks yet.</div>}
        </div>
      )}
      {createOpen && (
        <CreateTaskModal
          state={state}
          onCreate={createFromModal}
          onClose={() => setCreateOpen(false)}
        />
      )}
    </section>
  );
}

function AllTasksView({
  state,
  updateTask,
  openTaskThread,
  setChannel,
  setSection
}: {
  state: AppState;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openTaskThread: (task: Task) => void;
  setChannel: (channel: string) => void;
  setSection: (section: SectionId) => void;
}) {
  const [view, setView] = useState<"board" | "list">("board");
  const [target, setTarget] = useState("");
  const [status, setStatus] = useState("open");
  const [assignee, setAssignee] = useState("");
  const [creator, setCreator] = useState("");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Task[]>(state.tasks);
  const [loading, setLoading] = useState(false);
  const statuses = taskStatuses();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.fetchTasks({
      target,
      status,
      assigneeId: assignee,
      createdBy: creator,
      q: query.trim()
    }).then(next => {
      if (alive) setTasks(next);
    }).catch(() => {
      if (alive) setTasks([]);
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [target, status, assignee, creator, query, state.tasks]);

  return (
    <section className="pane tasks-page">
      <Topbar
        eyebrow="Tasks"
        title="All Tasks"
        subtitle="A cross-channel task view for every task in this workspace."
      />
      <div className="task-toolbar">
        <label className="select-shell">
          <span>Channel</span>
          <select value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">Any channel</option>
            {state.channels.map(channel => (
              <option key={channel.id} value={channel.target}>
                {channel.kind === "dm" ? formatChatTitle(state, channel.target) : `#${channel.name}`}
              </option>
            ))}
          </select>
        </label>
        <label className="select-shell">
          <span>Status</span>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="open">Open</option>
            <option value="all">Any status</option>
            {statuses.map(status => (
              <option key={status.id} value={status.id}>
                {status.label}
              </option>
            ))}
          </select>
        </label>
        <label className="select-shell">
          <span>Assignee</span>
          <select value={assignee} onChange={e => setAssignee(e.target.value)}>
            <option value="">Anyone</option>
            {state.agents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="select-shell">
          <span>Creator</span>
          <select value={creator} onChange={e => setCreator(e.target.value)}>
            <option value="">Anyone</option>
            {state.humans.map(human => (
              <option key={human.id} value={human.id}>
                {human.name}
              </option>
            ))}
            {state.agents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="select-shell">
          <span>Search</span>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Title or description" />
        </label>
        <span className="toolbar-spacer" />
        <div className="seg">
          <button className={view === "board" ? "is-active" : ""} onClick={() => setView("board")}>
            <Kanban size={14} /> Board
          </button>
          <button className={view === "list" ? "is-active" : ""} onClick={() => setView("list")}>
            <List size={14} /> List
          </button>
        </div>
      </div>
      {loading && <div className="message-loading">Loading tasks...</div>}
      {view === "board" ? (
        <div className="task-board">
          {statuses.map(status => {
            const columnTasks = tasks.filter(task => task.status === status.id);
            return (
              <section className="task-column" key={status.id}>
                <header>
                  <span className={`status-pill ${status.id}`}>{status.label}</span>
                  <small>{columnTasks.length}</small>
                </header>
                <div className="task-column-body">
                  {columnTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      state={state}
                      updateTask={updateTask}
                      openTaskThread={openTaskThread}
                      showChannel
                    />
                  ))}
                  {columnTasks.length === 0 && (
                    <div className="task-empty">No {status.label.toLowerCase()} tasks.</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="task-list">
          {tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              state={state}
              updateTask={updateTask}
              openTaskThread={openTaskThread}
              showChannel
              list
            />
          ))}
          {tasks.length === 0 && <div className="empty">No tasks yet.</div>}
        </div>
      )}
      <div className="task-page-foot">
        {target && (
          <button
            className="btn btn-ghost"
            onClick={() => {
              setChannel(target);
              setSection("chat");
            }}
          >
            <MessageSquare size={14} /> View selected channel
          </button>
        )}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  state,
  updateTask,
  openTaskThread,
  list = false,
  showChannel = false
}: {
  task: Task;
  state: AppState;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openTaskThread: (task: Task) => void;
  list?: boolean;
  showChannel?: boolean;
}) {
  const assignee = state.agents.find(a => a.id === task.assigneeId);
  const replies = typeof task.replyCount === "number"
    ? task.replyCount
    : countThreadReplies(state, { target: task.target, id: task.messageId } as Message);
  const channel = resolveChannel(state.channels, task.target);
  return (
    <article className={`task-card ${list ? "list" : ""}`} onClick={() => openTaskThread(task)}>
      <small className="task-num">#{task.number || task.id}</small>
      <div>
        {showChannel && <small className="task-channel">{channel?.kind === "dm" ? formatChatTitle(state, task.target) : (channel ? `#${channel.name}` : task.target)}</small>}
        <h3>{task.title}</h3>
      </div>
      {task.description && <p>{task.description}</p>}
      <div className="task-meta">
        <span>{assignee ? `@${assignee.handle || assignee.name}` : "Unassigned"}</span>
        <span>{replies} replies</span>
      </div>
      <select
        className="task-status"
        value={task.status}
        onClick={event => event.stopPropagation()}
        onChange={event => updateTask(task, { status: event.target.value })}
      >
        {taskStatuses().map(s => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
    </article>
  );
}

function CreateTaskModal({
  state,
  onCreate,
  onClose
}: {
  state: AppState;
  onCreate: (body: Record<string, unknown>) => Promise<void> | void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState(state.agents[0]?.id || "");
  const valid = !!title.trim();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <button className="modal-close" title="Close" onClick={onClose}>
          <X />
        </button>
        <p className="eyebrow">New work</p>
        <h1>Make it a task.</h1>
        <p className="modal-lede">
          Tasks live alongside the chat — every reply, every status flip, captured in one thread.
        </p>
        <label className="field">
          <span>
            Title <em>required</em>
          </span>
          <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Write a task..." />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Optional details, acceptance criteria, links..."
          />
        </label>
        <label className="field">
          <span>Assignee</span>
          <select value={assigneeId} onChange={e => setAssigneeId(e.target.value)}>
            <option value="">Unassigned</option>
            {state.agents.map(a => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => onCreate({ title, description, assigneeId: assigneeId || null })}
          >
            Create task
          </button>
        </footer>
      </section>
    </div>
  );
}

// ---------- scheduled tasks ----------

function ScheduledTasksView({
  state,
  selectedAgentId,
  selectAgent,
  updateScheduledTask,
  deleteScheduledTask
}: {
  state: AppState;
  selectedAgentId: string;
  selectAgent: (agentId: string) => void;
  updateScheduledTask: (task: ScheduledTask, patch: Record<string, unknown>) => Promise<void>;
  deleteScheduledTask: (task: ScheduledTask) => Promise<void>;
}) {
  const [status, setStatus] = useState("");
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const selectedAgent = state.agents.find(agent => agent.id === selectedAgentId);
  const selectedTasks = state.scheduledTasks.filter(task =>
    !selectedAgentId ||
    (selectedAgentId === "__missing__"
      ? !state.agents.some(agent => agent.id === task.agentId)
      : task.agentId === selectedAgentId)
  );
  const tasks = state.scheduledTasks
    .filter(task => !status || task.status === status)
    .filter(task =>
      !selectedAgentId ||
      (selectedAgentId === "__missing__"
        ? !state.agents.some(agent => agent.id === task.agentId)
        : task.agentId === selectedAgentId)
    )
    .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  const activeCount = selectedTasks.filter(task => task.status === "active").length;
  const pageTitle = selectedAgent
    ? `@${selectedAgent.handle || selectedAgent.name} schedules`
    : selectedAgentId === "__missing__"
      ? "Missing agent schedules"
      : "Scheduled Tasks";

  return (
    <section className="pane">
      <Topbar
        eyebrow="Automation"
        title={pageTitle}
        subtitle={
          selectedAgent
            ? `Schedules assigned to ${selectedAgent.name}.`
            : "Server-owned timers that wake agents by creating delivery messages on schedule."
        }
      />
      <div className="schedule-summary">
        <article>
          <span>{selectedTasks.length}</span>
          <small>{selectedAgentId ? "Assigned schedules" : "Total schedules"}</small>
        </article>
        <article>
          <span>{activeCount}</span>
          <small>Active</small>
        </article>
        <article>
          <span>{selectedTasks.length - activeCount}</span>
          <small>Paused</small>
        </article>
      </div>
      <div className="task-toolbar schedule-toolbar">
        <label className="select-shell">
          <span>Status</span>
          <select value={status} onChange={e => setStatus(e.target.value)}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>
        <label className="select-shell">
          <span>Agent</span>
          <select value={selectedAgentId} onChange={e => selectAgent(e.target.value)}>
            <option value="">Any agent</option>
            {state.agents
              .filter(agent => state.scheduledTasks.some(task => task.agentId === agent.id))
              .map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
              ))}
            {state.scheduledTasks.some(task => !state.agents.some(agent => agent.id === task.agentId)) && (
              <option value="__missing__">Missing agent</option>
            )}
          </select>
        </label>
      </div>
      <div className="schedule-list">
        {tasks.map(task => {
          const agent = state.agents.find(a => a.id === task.agentId);
          return (
            <article className="schedule-card" key={task.id}>
              <header>
                <div>
                  <p className="eyebrow">{task.target}</p>
                  <h2>{agent ? `@${agent.handle || agent.name}` : task.agentId}</h2>
                </div>
                <span className={`status-pill ${task.status === "active" ? "done" : "closed"}`}>
                  {task.status}
                </span>
              </header>
              <p className="schedule-prompt">{task.prompt}</p>
              <dl className="schedule-details">
                <div>
                  <dt>Schedule</dt>
                  <dd>
                    {task.cronExpression
                      ? <span className="mono">{task.cronExpression} ({task.timezone || "UTC"})</span>
                      : formatDuration(task.intervalMs || 0)}
                  </dd>
                </div>
                <div>
                  <dt>Next run</dt>
                  <dd>{formatDateTime(task.nextRunAt)}</dd>
                </div>
                <div>
                  <dt>Last run</dt>
                  <dd>{task.lastRunAt ? formatDateTime(task.lastRunAt) : "Never"}</dd>
                </div>
                <div>
                  <dt>Runs</dt>
                  <dd>{task.runCount}</dd>
                </div>
                <div>
                  <dt>Last message</dt>
                  <dd className="mono">{task.lastMessageId || "—"}</dd>
                </div>
                <div>
                  <dt>ID</dt>
                  <dd className="mono">{task.id}</dd>
                </div>
              </dl>
              <footer>
                <button className="btn btn-ghost" onClick={() => setEditingTask(task)}>
                  <Pencil size={13} /> Edit
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => updateScheduledTask(task, { status: task.status === "active" ? "paused" : "active" })}
                >
                  {task.status === "active" ? <Square size={13} /> : <Play size={13} />}
                  {task.status === "active" ? " Pause" : " Resume"}
                </button>
                <button className="btn btn-ghost btn-danger" onClick={() => deleteScheduledTask(task)}>
                  <Trash2 size={13} /> Delete
                </button>
              </footer>
            </article>
          );
        })}
        {tasks.length === 0 && (
          <div className="empty">
            <h3>No scheduled tasks.</h3>
            <p>
              {selectedAgent
                ? `No schedules are assigned to ${selectedAgent.name}.`
                : "Ask an agent “每隔 10 分钟汇报…”. If the agent declares a schedule, iTeam will run it."}
            </p>
          </div>
        )}
      </div>
      {editingTask && (
        <EditScheduledTaskModal
          state={state}
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={async patch => {
            await updateScheduledTask(editingTask, patch);
            setEditingTask(null);
          }}
        />
      )}
    </section>
  );
}

function EditScheduledTaskModal({
  state,
  task,
  onSave,
  onClose
}: {
  state: AppState;
  task: ScheduledTask;
  onSave: (patch: Record<string, unknown>) => Promise<void> | void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState(task.target);
  const [agentId, setAgentId] = useState(task.agentId);
  const [status, setStatus] = useState(task.status);
  const [scheduleType, setScheduleType] = useState(task.cronExpression ? "cron" : "interval");
  const [intervalMinutes, setIntervalMinutes] = useState(String(Math.max(1, Math.round((task.intervalMs || 60_000) / 60_000))));
  const [cronExpression, setCronExpression] = useState(task.cronExpression || "0 9-19 * * 1-5");
  const [timezone, setTimezone] = useState(task.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [nextRunAt, setNextRunAt] = useState(toDateTimeLocal(task.nextRunAt));
  const [prompt, setPrompt] = useState(task.prompt);
  const [error, setError] = useState("");
  const intervalMs = Number(intervalMinutes) * 60_000;
  const validSchedule = scheduleType === "cron"
    ? !!cronExpression.trim() && !!timezone.trim()
    : Number.isFinite(intervalMs) && intervalMs >= 1000 && !!nextRunAt;
  const valid = !!target.trim() && !!agentId && !!prompt.trim() && validSchedule;

  async function save() {
    setError("");
    if (!valid) {
      setError("Target, agent, schedule, and prompt are required.");
      return;
    }
    try {
      const schedulePatch = scheduleType === "cron"
        ? { cronExpression: cronExpression.trim(), timezone: timezone.trim() }
        : { intervalMs: Math.floor(intervalMs), nextRunAt: new Date(nextRunAt).toISOString() };
      await onSave({
        target: target.trim(),
        agentId,
        status,
        ...schedulePatch,
        prompt: prompt.trim()
      });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
      >
        <button className="modal-close" title="Close" onClick={onClose}>
          <X />
        </button>
        <p className="eyebrow">Schedule</p>
        <h1>Edit scheduled task.</h1>
        <p className="modal-lede">
          Changes are saved to the server timer. Future runs will use the edited prompt and cadence.
        </p>
        <div className="field-row">
          <label className="field">
            <span>Target</span>
            <input value={target} onChange={e => setTarget(e.target.value)} placeholder="#all or dm:agent_id" />
          </label>
          <label className="field">
            <span>Agent</span>
            <select value={agentId} onChange={e => setAgentId(e.target.value)}>
              {state.agents.map(agent => (
                <option key={agent.id} value={agent.id}>
                  @{agent.handle || agent.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Status</span>
            <select value={status} onChange={e => setStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <label className="field">
            <span>Schedule type</span>
            <select value={scheduleType} onChange={e => setScheduleType(e.target.value)}>
              <option value="interval">Interval</option>
              <option value="cron">Cron</option>
            </select>
          </label>
        </div>
        {scheduleType === "cron" ? (
          <div className="field-row">
            <label className="field">
              <span>Cron expression</span>
              <input
                className="mono"
                value={cronExpression}
                onChange={e => setCronExpression(e.target.value)}
                placeholder="0 9-19 * * 1-5"
              />
              <small>Standard 5-field cron: minute hour day month weekday.</small>
            </label>
            <label className="field">
              <span>Timezone</span>
              <input
                value={timezone}
                onChange={e => setTimezone(e.target.value)}
                placeholder="Asia/Shanghai"
              />
            </label>
          </div>
        ) : (
          <div className="field-row">
            <label className="field">
              <span>Interval minutes</span>
              <input
                type="number"
                min="1"
                step="1"
                value={intervalMinutes}
                onChange={e => setIntervalMinutes(e.target.value)}
              />
            </label>
            <label className="field">
              <span>Next run</span>
              <input type="datetime-local" value={nextRunAt} onChange={e => setNextRunAt(e.target.value)} />
            </label>
          </div>
        )}
        <label className="field">
          <span>Prompt</span>
          <textarea value={prompt} onChange={e => setPrompt(e.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={save}>
            Save changes
          </button>
        </footer>
      </section>
    </div>
  );
}

function CreateChannelModal({
  onCreate,
  onClose
}: {
  onCreate: (body: { name: string; description?: string }) => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = !!name.trim();

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({ name, description });
    } catch (err) {
      setError((err as Error).message || "Failed to create channel");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-channel-title"
        onClick={e => e.stopPropagation()}
      >
        <button className="modal-close" title="Close" onClick={onClose}>
          <X />
        </button>
        <p className="eyebrow">New channel</p>
        <h1 id="create-channel-title">Create a channel.</h1>
        <p className="modal-lede">
          Channels are real local records. Messages, tasks, and threads stay scoped to the selected channel.
        </p>
        {error && <p className="form-error">{error}</p>}
        <label className="field">
          <span>
            Name <em>required</em>
          </span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. planning"
            autoFocus
            onKeyDown={e => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Optional context for this channel..."
          />
        </label>
        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Creating..." : "Create channel"}
          </button>
        </footer>
      </section>
    </div>
  );
}

// ---------- members ----------

function MembersView({
  state,
  selectedAgent,
  openCreateAgent,
  openAgentDm,
  updateAgent,
  refresh
}: {
  state: AppState;
  selectedAgent: Agent | null;
  openCreateAgent: () => void;
  openAgentDm: (agent: Agent) => void;
  updateAgent: (agentId: string, patch: { name?: string; description?: string; model?: string | null }) => Promise<void>;
  refresh: () => void;
}) {
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [modelValue, setModelValue] = useState("");
  const [modelError, setModelError] = useState("");
  const [modelBusy, setModelBusy] = useState(false);
  const agentGroups = useMemo(() => groupAgentsByComputer(state), [state.agents, state.computers]);
  const selectedComputer = selectedAgent
    ? state.computers.find(computer => computer.id === selectedAgent.computerId)
    : null;

  useEffect(() => {
    setRenameValue(selectedAgent?.name || "");
    setRenameError("");
    setRenameBusy(false);
    setModelValue(selectedAgent?.model || "");
    setModelError("");
    setModelBusy(false);
  }, [selectedAgent?.id, selectedAgent?.name, selectedAgent?.model]);

  async function toggle(agent: Agent) {
    await api.post(`/api/agents/${agent.id}/${isAgentStopped(agent) ? "start" : "stop"}`);
    refresh();
  }

  async function saveName(agent: Agent) {
    const name = renameValue.trim();
    if (!name || name === agent.name || renameBusy) return;
    setRenameBusy(true);
    setRenameError("");
    try {
      await updateAgent(agent.id, { name });
    } catch (err) {
      setRenameError((err as Error).message || "Failed to rename agent");
    } finally {
      setRenameBusy(false);
    }
  }

  async function saveModel(agent: Agent) {
    const model = modelValue.trim() || null;
    if (model === agent.model || modelBusy) return;
    setModelBusy(true);
    setModelError("");
    try {
      await updateAgent(agent.id, { model });
    } catch (err) {
      setModelError((err as Error).message || "Failed to update model");
    } finally {
      setModelBusy(false);
    }
  }

  return (
    <section className="pane">
      <Topbar
        eyebrow="Members"
        title={selectedAgent?.name || "Agents"}
        subtitle="Profiles, runtime configuration, and local workspaces."
      />
      <div className="member-grid">
        <aside className="panel panel-cream">
          <p className="eyebrow">Roster</p>
          <h2>Agents on call.</h2>
          <p className="panel-note">
            Spin up an agent on a connected computer. The daemon launches the real runtime on its next
            heartbeat.
          </p>
          <button className="btn btn-primary wide" onClick={openCreateAgent}>
            <Plus size={15} /> Create agent
          </button>
          <div className="agent-computer-groups">
            {agentGroups.map(group => (
              <section className="agent-computer-group" key={group.id}>
                <header>
                  <span className="agent-computer-icon">
                    <Computer size={14} />
                  </span>
                  <div>
                    <strong>{group.name}</strong>
                    <small>{group.status}</small>
                  </div>
                  <span>{group.agents.length}</span>
                </header>
                <ul className="agent-mini-list">
                  {group.agents.map(a => (
                    <li key={a.id}>
                      <Avatar name={a.name} agent />
                      <span>
                        <strong>{a.name}</strong>
                        <small>{a.runtime}</small>
                      </span>
                      <small>{a.status}</small>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {!state.agents.length && <p className="agent-groups-empty">No agents yet.</p>}
          </div>
        </aside>
        <article className="panel panel-dark profile">
          {selectedAgent ? (
            <>
              <div className="profile-head">
                <Avatar name={selectedAgent.name} agent large />
                <div>
                  <p className="eyebrow on-dark">Agent profile</p>
                  <h1>
                    {selectedAgent.name} <small>{selectedAgent.status}</small>
                  </h1>
                </div>
              </div>
              <label className="profile-rename">
                <span>Display name</span>
                <div>
                  <input
                    value={renameValue}
                    onChange={event => setRenameValue(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Enter") saveName(selectedAgent);
                    }}
                  />
                  <button
                    className="btn btn-secondary-on-dark"
                    disabled={!renameValue.trim() || renameValue.trim() === selectedAgent.name || renameBusy}
                    onClick={() => saveName(selectedAgent)}
                  >
                    {renameBusy ? "Saving..." : "Save"}
                  </button>
                </div>
                {renameError && <small>{renameError}</small>}
              </label>
              {agentRuntimeError(selectedAgent) && (
                <p className="profile-warning">Launch error: {agentRuntimeError(selectedAgent)}</p>
              )}
              <dl className="profile-dl">
                <div>
                  <dt>Runtime</dt>
                  <dd>{selectedAgent.runtime}</dd>
                </div>
                <div>
                  <dt>Computer</dt>
                  <dd>{selectedComputer?.name || "Unassigned"}</dd>
                </div>
              <label className="profile-rename">
                <span>Model</span>
                <div>
                  <input
                    value={modelValue}
                    onChange={event => setModelValue(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Enter") saveModel(selectedAgent);
                    }}
                    placeholder="empty = use env var"
                  />
                  <button
                    className="btn btn-secondary-on-dark"
                    disabled={modelValue.trim() === (selectedAgent.model || "") || modelBusy}
                    onClick={() => saveModel(selectedAgent)}
                  >
                    {modelBusy ? "Saving..." : "Save"}
                  </button>
                </div>
                {modelError && <small>{modelError}</small>}
              </label>
                <div>
                  <dt>Reasoning</dt>
                  <dd>{selectedAgent.reasoning || "default"}</dd>
                </div>
                <div>
                  <dt>Workspace</dt>
                  <dd className="mono">{selectedAgent.workspacePath || "—"}</dd>
                </div>
              </dl>
              <div className="profile-actions">
                <button className="btn btn-secondary-on-dark" onClick={() => openAgentDm(selectedAgent)}>
                  <MessageSquare size={14} /> Message
                </button>
                <button className="btn btn-secondary-on-dark" onClick={() => toggle(selectedAgent)}>
                  {isAgentStopped(selectedAgent) ? <Play size={14} /> : <Square size={14} />}
                  {isAgentStopped(selectedAgent) ? " Start agent" : " Stop agent"}
                </button>
              </div>
            </>
          ) : (
            <div className="empty on-dark">
              <Bot size={32} />
              <p>Select an agent — or create a new one — to see its profile.</p>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

function IntegrationsSidebar({
  state,
  selectedBotProvider,
  setSelectedBotProvider
}: {
  state: AppState;
  selectedBotProvider: string | null;
  setSelectedBotProvider: (provider: string | null) => void;
}) {
  const larkConfigs = state.externalBotConfigs.filter(config => config.provider.startsWith("lark") || config.provider.startsWith("feishu"));
  const activeProvider = selectedBotProvider || larkConfigs[0]?.provider || NEW_BOT_PROVIDER;
  return (
    <div className="side-section">
      <SectionLabel
        action={
          <button className="side-add" onClick={() => setSelectedBotProvider(NEW_BOT_PROVIDER)} title="Add bot">
            <Plus size={14} />
          </button>
        }
      >
        Bot integrations
      </SectionLabel>
      <button className="side-row is-selected">
        <Bot size={16} />
        <span>Lark / Feishu</span>
        <small>{larkConfigs.filter(config => config.enabled).length || "setup"}</small>
      </button>
      {larkConfigs.map(config => (
        <button
          className={`side-row member ${activeProvider === config.provider ? "is-selected" : ""}`}
          key={config.provider}
          onClick={() => setSelectedBotProvider(config.provider)}
        >
          <span>{config.alias || config.appId}</span>
          <small>{botStatusLabel(config)}</small>
        </button>
      ))}
    </div>
  );
}

function IntegrationsView({
  state,
  refresh,
  selectedBotProvider,
  setSelectedBotProvider
}: {
  state: AppState;
  refresh: () => void;
  selectedBotProvider: string | null;
  setSelectedBotProvider: (provider: string | null) => void;
}) {
  const larkConfigs = state.externalBotConfigs.filter(config => config.provider.startsWith("lark") || config.provider.startsWith("feishu"));
  const activeProvider = selectedBotProvider || larkConfigs[0]?.provider || NEW_BOT_PROVIDER;
  const existing = activeProvider === NEW_BOT_PROVIDER ? null : larkConfigs.find(config => config.provider === activeProvider) || null;
  const boundChats = existing ? state.externalBotBindings.filter(binding => binding.provider === existing.provider) : [];
  const [alias, setAlias] = useState(existing?.alias || "");
  const [appId, setAppId] = useState(existing?.appId || "");
  const [appSecret, setAppSecret] = useState("");
  const [domain, setDomain] = useState(existing?.domain || "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setAlias(existing?.alias || "");
    setAppId(existing?.appId || "");
    setDomain(existing?.domain || "");
    setEnabled(existing?.enabled ?? true);
    setAppSecret("");
  }, [existing?.alias, existing?.appId, existing?.domain, existing?.enabled, activeProvider]);

  async function save() {
    if (!appId.trim()) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api.post<ExternalBotConfig>("/api/external/bot-configs", {
        provider: existing?.provider || "lark",
        alias: alias.trim() || null,
        appId: appId.trim(),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        domain: domain.trim() || null,
        enabled
      });
      setSelectedBotProvider(saved.provider);
      await refresh();
    } catch (err) {
      setError((err as Error).message || "Failed to save bot config");
    } finally {
      setSaving(false);
    }
  }

  async function deleteBot() {
    if (!existing) return;
    const label = existing.alias || existing.appId;
    if (!window.confirm(`Delete bot ${label}? This also removes its bound chats.`)) return;
    setSaving(true);
    setError("");
    try {
      await api.del(`/api/external/bot-configs/${encodeURIComponent(existing.provider)}`);
      setSelectedBotProvider(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message || "Failed to delete bot config");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="pane">
      <Topbar
        eyebrow="Integrations"
        title="Lark / Feishu bot"
        subtitle="Use a self-built app bot over long-connection events to talk with iTeam agents."
      />
      <div className="bots-layout">
        <aside className="panel panel-cream bots-guidance">
          <p className="eyebrow">How users talk to agents</p>
          <div className="integration-summary-card">
            <Bot size={16} />
            <div>
              <strong>{existing ? (existing.alias || existing.appId) : "New bot"}</strong>
              <small title={existing?.provider}>{existing ? existing.appId : `${larkConfigs.length} configured apps`}</small>
            </div>
            {existing && <span className={`status-pill ${botStatusClass(existing)}`}>{botStatusLabel(existing)}</span>}
          </div>
          <div className="bot-command-help">
            <p className="panel-note">After adding the bot to a chat, these messages are supported:</p>
            <ul className="bot-command-list">
              <li><code>/all @codex 帮我看一下这个问题</code></li>
              <li><code>/task /all @codex 帮我看一下这个问题</code></li>
              <li><code>/all 帮我看一下这个问题</code></li>
              <li><code>/iteam bind #all</code></li>
              <li><code>@codex 帮我看一下这个问题</code></li>
            </ul>
            <p className="panel-note">No channel + one agent mention routes to that agent's iTeam DM, not #all.</p>
          </div>
        </aside>
        <article className="panel panel-dark profile">
          <div className="profile-head">
            <Avatar name={alias || existing?.alias || "Lark"} agent large />
            <div>
              <p className="eyebrow on-dark">Bot app</p>
              <h1>
                {alias || existing?.alias || "Feishu bot"} <small>{existing ? (existing.enabled ? "configured" : "disabled") : "new"}</small>
              </h1>
            </div>
          </div>
          {existing && (
            <div className="bot-status-card">
              <span className={`status-pill ${botStatusClass(existing)}`}>{botStatusLabel(existing)}</span>
              <div>
                <strong>{botStatusTitle(existing)}</strong>
                <small>{existing.statusMessage || botStatusHint(existing)}</small>
              </div>
            </div>
          )}
          <label className="profile-rename">
            <span>Bot name / alias</span>
            <div>
              <input value={alias} onChange={event => setAlias(event.target.value)} placeholder="Production Feishu bot" />
            </div>
          </label>
          <label className="profile-rename">
            <span>App ID</span>
            <div>
              <input value={appId} onChange={event => setAppId(event.target.value)} placeholder="cli_xxx" disabled={!!existing} />
            </div>
          </label>
          <label className="profile-rename">
            <span>App Secret</span>
            <div>
              <input
                type="password"
                value={appSecret}
                onChange={event => setAppSecret(event.target.value)}
                placeholder={existing?.appSecret ? "leave blank to keep existing secret" : "app secret"}
              />
            </div>
          </label>
          <label className="profile-rename">
            <span>Domain (optional)</span>
            <div>
              <input value={domain} onChange={event => setDomain(event.target.value)} placeholder="open.feishu.cn / open.larksuite.com" />
            </div>
          </label>
          <label className="check-row on-dark">
            <input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
            <span>Enable long-connection bot on daemon restart</span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="profile-actions">
            <button className="btn btn-secondary-on-dark" disabled={!appId.trim() || saving} onClick={save}>
              {saving ? "Saving..." : "Save bot config"}
            </button>
            <a className="btn btn-secondary-on-dark" href="https://open.larkoffice.com/page/launcher?from=backend_oneclick" target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Create app
            </a>
            {existing && (
              <button className="btn btn-danger-on-dark" disabled={saving} onClick={deleteBot}>
                <Trash2 size={14} /> Delete bot
              </button>
            )}
          </div>
          <p className="profile-warning">
            Saving credentials now starts or reconnects the long-connection client automatically. If pairing stays pending, check App ID, App Secret, permissions, and event subscription.
          </p>
          <SectionLabel>Bound chats · {boundChats.length}</SectionLabel>
          <div className="bound-chat-list">
            {boundChats.map(binding => (
              <div className="bound-chat-row" key={binding.id}>
                <MessageSquare size={16} />
                <div>
                  <strong>{binding.defaultTarget || "No default channel"}</strong>
                  <small>{binding.chatId}</small>
                </div>
                <span className={`status-pill ${binding.status === "active" ? "done" : "closed"}`}>{binding.status}</span>
              </div>
            ))}
            {!existing && (
              <p className="empty-note on-dark">Save this bot before binding Feishu chats.</p>
            )}
            {existing && !boundChats.length && (
              <p className="empty-note on-dark">No Feishu chat bound yet — use /iteam bind #all in this bot chat.</p>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}

function botStatusLabel(config: ExternalBotConfig): string {
  const status = config.enabled ? (config.status || "pending") : "disabled";
  return status === "connected" ? "paired" : status;
}

function botStatusClass(config: ExternalBotConfig): string {
  const status = config.enabled ? (config.status || "pending") : "disabled";
  if (status === "connected") return "done";
  if (status === "error" || status === "invalid") return "error";
  if (status === "pending") return "todo";
  return "closed";
}

function botStatusTitle(config: ExternalBotConfig): string {
  const status = config.enabled ? (config.status || "pending") : "disabled";
  if (status === "connected") return "Feishu long connection paired.";
  if (status === "invalid") return "Not paired: invalid app id.";
  if (status === "error") return "Not paired: connection failed.";
  if (status === "disabled") return "Bot is disabled.";
  return "Waiting for daemon restart / connection.";
}

function botStatusHint(config: ExternalBotConfig): string {
  const status = config.enabled ? (config.status || "pending") : "disabled";
  if (status === "connected" && config.lastConnectedAt) return `Last paired at ${new Date(config.lastConnectedAt).toLocaleString()}.`;
  if (status === "invalid") return "Use the real Feishu/Lark App ID, usually cli_xxx.";
  if (status === "error") return "Check App Secret, permissions, and long-connection availability, then restart the daemon.";
  if (status === "disabled") return "Enable this bot and restart the daemon to pair.";
  return "Save credentials, then restart the iTeam daemon so it can pair with Feishu/Lark.";
}

function CreateAgentModal({
  state,
  agentName,
  setAgentName,
  agentDescription,
  setAgentDescription,
  runtime,
  setRuntime,
  agentComputerId,
  setAgentComputerId,
  agentModel,
  setAgentModel,
  createAgent,
  onClose
}: {
  state: AppState;
  agentName: string;
  setAgentName: (s: string) => void;
  agentDescription: string;
  setAgentDescription: (s: string) => void;
  runtime: string;
  setRuntime: (s: string) => void;
  agentComputerId: string;
  setAgentComputerId: (s: string) => void;
  agentModel: string;
  setAgentModel: (s: string) => void;
  createAgent: () => Promise<void> | void;
  onClose: () => void;
}) {
  const computer = state.computers.find(c => c.id === agentComputerId);
  const runtimes = (computer?.runtimes || []).filter(
    r => r.installed && r.id !== "mock"
  );
  const runtimeValue = runtime.trim();
  const valid = Boolean(agentComputerId && agentName.trim() && runtimeValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [runtimePickerOpen, setRuntimePickerOpen] = useState(false);
  const previousRuntimeComputerId = useRef<string | null>(null);

  useEffect(() => {
    if (!agentComputerId && state.computers[0]) setAgentComputerId(state.computers[0].id);
  }, [agentComputerId, state.computers, setAgentComputerId]);

  useEffect(() => {
    if (!agentComputerId || previousRuntimeComputerId.current === agentComputerId) return;
    previousRuntimeComputerId.current = agentComputerId;
    const available = (computer?.runtimes || []).filter(
      r => r.installed && r.id !== "mock"
    );
    if (available.length && (!runtime.trim() || !available.some(r => r.id === runtime))) {
      setRuntime(preferredCreateRuntime(available));
    }
  }, [agentComputerId, computer, runtime, setRuntime]);

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await createAgent();
    } catch (err) {
      setError((err as Error).message || "Failed to create agent");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    setAgentModel(defaultModel(runtime));
  }, [runtime, setAgentModel]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-agent-title"
        onClick={e => e.stopPropagation()}
      >
        <button className="modal-close" title="Close" onClick={onClose}>
          <X />
        </button>
        <p className="eyebrow">New collaborator</p>
        <h1 id="create-agent-title">Create an agent.</h1>
        <p className="modal-lede">
          Choose a computer, name your teammate, and pick the runtime that should think on its behalf.
        </p>

        <label className="field">
          <span>
            Computer <em>required</em>
          </span>
          <select value={agentComputerId} onChange={e => setAgentComputerId(e.target.value)}>
            <option value="">Select…</option>
            {state.computers.map(c => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>
            Name <em>required</em>
          </span>
          <input value={agentName} onChange={e => setAgentName(e.target.value)} placeholder="e.g. Alice" />
        </label>

        <label className="field">
          <span>
            Description <small>optional</small>
          </span>
          <textarea
            value={agentDescription}
            onChange={e => setAgentDescription(e.target.value)}
            maxLength={3000}
            placeholder="Leave blank for a general-purpose agent, or describe a role..."
          />
          <div className="char-count">{agentDescription.length}/3000</div>
        </label>

        <div className="field-row">
          <div className="field runtime-combobox-field">
            <span>
              Runtime <small>type or pick</small>
            </span>
            <div className="runtime-combobox">
              <input
                value={runtime}
                onChange={e => {
                  setRuntime(e.target.value);
                  setRuntimePickerOpen(false);
                }}
                onFocus={() => setRuntimePickerOpen(true)}
                placeholder="codex, trae, or configured profile id"
                role="combobox"
                aria-expanded={runtimePickerOpen}
                aria-controls="runtime-options"
                autoComplete="off"
              />
              <button
                className="runtime-combobox-toggle"
                type="button"
                aria-label="Show runtime options"
                onClick={() => setRuntimePickerOpen(open => !open)}
              >
                <ChevronDown size={16} />
              </button>
              {runtimePickerOpen && runtimes.length > 0 && (
                <div className="runtime-options" id="runtime-options" role="listbox">
                  {runtimes.map(r => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={r.id === runtimeValue}
                      className={r.id === runtimeValue ? "is-selected" : ""}
                      key={r.id}
                      onClick={() => {
                        setRuntime(r.id);
                        setRuntimePickerOpen(false);
                      }}
                    >
                      <span>{runtimeLabel(r.id, r.name)}</span>
                      <code>{r.id}</code>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <label className="field">
            <span>Model</span>
            <input
              list="model-options"
              type="text"
              value={agentModel}
              onChange={e => setAgentModel(e.target.value)}
              placeholder="empty = use env var"
            />
            <datalist id="model-options">
              {modelsFor(runtime).map(model => (
                <option value={model} key={model} />
              ))}
            </datalist>
          </label>
        </div>

        {!state.computers.length && (
          <p className="form-error">Connect a computer before creating agents.</p>
        )}
        {computer && !runtimes.length && (
          <p className="form-error">No installed agent runtime was reported by this computer. You can still type a custom profile id; launch will fail later if the daemon cannot run it.</p>
        )}
        {computer && runtimes.length > 0 && !runtimes.some(r => r.id === runtimeValue) && runtimeValue && (
          <p className="char-count">Custom runtime id. Make sure the daemon can run it, usually via ITEAM_ACP_RUNTIMES or ITEAM_RUNTIME_PROFILES.</p>
        )}
        {error && <p className="form-error">{error}</p>}

        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Creating..." : "Create agent"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function RenameChannelModal({
  channel,
  onRename,
  onClose
}: {
  channel: Channel;
  onRename: (channelId: string, body: { name?: string; description?: string }) => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = !!name.trim();

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onRename(channel.id, { name, description });
    } catch (err) {
      setError((err as Error).message || "Failed to rename channel");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-channel-title"
        onClick={e => e.stopPropagation()}
      >
        <button className="modal-close" title="Close" onClick={onClose}>
          <X />
        </button>
        <p className="eyebrow">Channel settings</p>
        <h1 id="rename-channel-title">Rename channel.</h1>
        <p className="modal-lede">
          Renaming updates the channel path and keeps existing messages, tasks, and threads attached.
        </p>
        {error && <p className="form-error">{error}</p>}
        <label className="field">
          <span>
            Name <em>required</em>
          </span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            autoFocus
            onKeyDown={e => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea value={description} onChange={e => setDescription(e.target.value)} />
        </label>
        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving..." : "Save channel"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function RenameHumanModal({
  human,
  onRename,
  onClose
}: {
  human: Human;
  onRename: (humanId: string, name: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState(human.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = !!name.trim() && name.trim() !== human.name;

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onRename(human.id, name.trim());
    } catch (err) {
      setError((err as Error).message || "Failed to rename human");
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal modal-narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-human-title"
        onClick={event => event.stopPropagation()}
      >
        <button className="modal-close" title="Close" onClick={onClose}>
          <X />
        </button>
        <p className="eyebrow">Human profile</p>
        <h1 id="rename-human-title">Change your name.</h1>
        <p className="modal-lede">
          This updates how your name appears in members, messages, and future conversations.
        </p>
        {error && <p className="form-error">{error}</p>}
        <label className="field">
          <span>
            Display name <em>required</em>
          </span>
          <input
            value={name}
            onChange={event => setName(event.target.value)}
            autoFocus
            onKeyDown={event => {
              if (event.key === "Enter") submit();
            }}
          />
        </label>
        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
            {busy ? "Saving..." : "Save name"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function preferredCreateRuntime(runtimes: RuntimeInfo[]): string {
  const installed = runtimes.filter(runtime => runtime.installed && runtime.id !== "mock");
  const preferredAcpIds = ["trae", "gemini", "hermes"];
  for (const id of preferredAcpIds) {
    if (installed.some(runtime => runtime.id === id)) return id;
  }
  return (
    installed.find(runtime => runtime.id.includes("acp") || /\bACP\b/i.test(runtime.name)) ||
    installed[0]
  )?.id || "";
}

function runtimeLabel(runtime: string, fallback?: string): string {
  return ({ codex: "Codex CLI", claude: "Claude Code", gemini: "Gemini CLI", opencode: "OpenCode", trae: "Trae CLI (traecli)" } as Record<string, string>)[
    runtime
  ] || fallback || runtime;
}

function defaultModel(runtime: string): string {
  // Empty by default so Claude CLI reads ANTHROPIC_MODEL from the environment.
  // Users can still pick a preset from the datalist or type a custom model ID.
  return "";
}

function modelsFor(runtime: string): string[] {
  if (runtime === "claude") return ["sonnet", "opus"];
  if (runtime === "gemini") return ["gemini-2.5-pro", "gemini-2.5-flash","gemini-3.1-flash-lite"];
  if (runtime === "trae") return ["Doubao-Seed-1.8", "MiniMax-M2.7", "GLM-5.1", "GLM-5", "DeepSeek-V4-Pro", "DeepSeek-V4-Flash", "Kimi-K2.6", "Kimi-K2.5", "GPT-5.5", "GPT-5.4", "GPT-5.2", "Qwen3.6-Plus", "Qwen3.5-Plus"];
  return ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
}

// ---------- thread ----------

function ThreadPanel({
  state,
  root,
  messages,
  onClose,
  onViewChannel,
  onSend
}: {
  state: AppState;
  root: Message;
  messages: Message[];
  onClose: () => void;
  onViewChannel: () => void;
  onSend: (target: string, text: string, mentions: any[]) => void;
}) {
  const [text, setText] = useState("");
  const mentionMembers = useMemo(() => getMentionMembers(state, root.target), [state, root.target]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionOptions = useMemo(() => {
    if (!mentionMatch) return [];
    const query = mentionMatch.query.toLowerCase();
    return mentionMembers
      .filter(member =>
        member.handle.toLowerCase().includes(query) || member.name.toLowerCase().includes(query)
      )
      .slice(0, 8);
  }, [mentionMatch, mentionMembers]);
  const threadTarget = `${root.target}:${root.id}`;
  const rootTask = state.tasks.find(t => t.messageId === root.id || t.id === root.taskId);

  function refreshMention(target: HTMLTextAreaElement | null = textareaRef.current) {
    if (!target) return;
    const match = findMentionMatch(target.value, target.selectionStart || 0);
    setMentionMatch(match);
    setMentionIndex(0);
  }

  function insertMention(member: MentionMember) {
    if (!mentionMatch) return;
    const before = text.slice(0, mentionMatch.start);
    const after = text.slice(mentionMatch.end);
    const next = `${before}@${member.handle} ${after}`;
    const cursor = before.length + member.handle.length + 2;
    setText(next);
    setMentionMatch(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionMatch && mentionOptions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex(i => (i + 1) % mentionOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(i => (i - 1 + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(mentionOptions[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionMatch(null);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      send();
    }
  }

  async function send() {
    if (!text.trim()) return;
    await onSend(threadTarget, text, collectMentions(text, mentionMembers));
    setText("");
  }

  return (
    <aside className="thread-panel">
      <header>
        <div>
          <p className="eyebrow">Thread</p>
          <strong>{root.target}</strong>
        </div>
        <button className="btn btn-ghost" onClick={onViewChannel}>
          <ExternalLink size={14} /> View in channel
        </button>
        <button className="icon-btn" title="Close" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="thread-body">
        <MessageRow message={root} state={state} />
        {rootTask && (
          <div className="thread-task-meta">
            <span className={`status-pip ${rootTask.status}`} />
            Task #{rootTask.number} · {rootTask.status}
          </div>
        )}
        <div className="thread-divider">
          {messages.length} {messages.length === 1 ? "reply" : "replies"}
        </div>
        {messages.map(message => (
          <MessageRow key={message.id} message={message} state={state} />
        ))}
      </div>
      <div className="thread-composer">
        {mentionMatch && (
          <MentionMenu options={mentionOptions} activeIndex={mentionIndex} onPick={insertMention} />
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={event => {
            setText(event.target.value);
            refreshMention(event.target);
          }}
          onClick={event => refreshMention(event.target as HTMLTextAreaElement)}
          onKeyUp={event => {
            if (mentionMatch && isMentionNavigationKey(event.key)) return;
            refreshMention(event.target as HTMLTextAreaElement);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Reply in thread"
        />
        <button className="btn btn-primary" disabled={!text.trim()} onClick={send}>
          <Send size={15} />
        </button>
      </div>
    </aside>
  );
}

// ---------- helpers ----------

function taskStatuses() {
  return [
    { id: "todo", label: "Todo" },
    { id: "in_progress", label: "In Progress" },
    { id: "in_review", label: "In Review" },
    { id: "done", label: "Done" },
    { id: "closed", label: "Closed" }
  ];
}

function taskToRootMessage(task: Task): Message {
  return {
    id: task.messageId,
    target: task.target,
    authorId: task.createdBy || "human-local",
    text: task.title,
    type: "task",
    createdAt: task.createdAt || task.updatedAt || new Date().toISOString(),
    threadId: null,
    taskId: task.id,
    replyCount: task.replyCount
  };
}

function countThreadReplies(state: AppState, message: { target?: string; id?: string }) {
  if (!message?.target || !message?.id) return 0;
  const counted = state.messages.find(item => item.id === message.id)?.replyCount;
  if (typeof counted === "number") return counted;
  return state.messages.filter(item => item.target === `${message.target}:${message.id}`).length;
}

function channelMessageCount(state: AppState, channel: Channel, selectedTarget: string): number {
  if (typeof channel.messageCount === "number") return channel.messageCount;
  if (channel.target !== selectedTarget) return 0;
  return state.messages.filter(message => message.target === channel.target && !message.threadId).length;
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "—";
  return date.toLocaleString();
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function resolveChannel(channels: Channel[], channelIdOrTarget: string): Channel | null {
  return channels.find(channel =>
    channel.id === channelIdOrTarget ||
    channel.target === channelIdOrTarget ||
    channel.target === `#${channelIdOrTarget.replace(/^#/, "")}`
  ) || null;
}

function isProtectedChannel(channel: Channel): boolean {
  return channel.target === "#all" || channel.name === "all";
}

function agentForDm(state: AppState, channel: Channel): Agent | null {
  if (channel.kind !== "dm") return null;
  return state.agents.find(agent =>
    channel.memberIds?.includes(agent.id) ||
    channel.target === `dm:${agent.id}`
  ) || null;
}

function formatChatTitle(state: AppState, target: string): string {
  const channel = resolveChannel(state.channels, target);
  if (channel?.kind === "dm") {
    const agent = agentForDm(state, channel);
    return `@${agent?.handle || slugHandle(agent?.name || channel.name)}`;
  }
  if (channel) return `#${channel.name}`;
  return target.startsWith("#") ? target : `#${target}`;
}

function resolveChatSubtitle(state: AppState, target: string): string {
  const channel = resolveChannel(state.channels, target);
  if (channel?.description?.trim()) return channel.description;
  if (target.startsWith("dm:") || channel?.kind === "dm") {
    return "A private working thread between you and this agent.";
  }
  return "A shared canvas for humans and agents to think out loud.";
}

// ---------- routing ----------

interface RouteState {
  section: SectionId;
  channel: string;
  chatTab: "chat" | "tasks";
  agentId: string | null;
  computerId: string | null;
  threadId: string | null;
}

function parseLocation(loc: Location | { pathname: string; search: string }): RouteState {
  const segments = loc.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(loc.search);
  const threadId = params.get("thread");
  const route: RouteState = {
    section: "chat",
    channel: "#all",
    chatTab: "chat",
    agentId: null,
    computerId: null,
    threadId: threadId || null
  };
  if (segments.length === 0) return route;
  const [head, ...rest] = segments;
  switch (head) {
    case "channel": {
      route.section = "chat";
      if (rest[0]) route.channel = `#${rest[0].replace(/^#/, "")}`;
      if (rest[1] === "tasks" || rest[1] === "task") route.chatTab = "tasks";
      return route;
    }
    case "dm": {
      route.section = "chat";
      if (rest[0]) route.channel = `dm:${rest[0]}`;
      return route;
    }
    case "tasks":
    case "task": {
      route.section = "tasks";
      return route;
    }
    case "agents": {
      route.section = "members";
      return route;
    }
    case "agent": {
      route.section = "members";
      if (rest[0]) route.agentId = rest[0];
      return route;
    }
    case "computers": {
      route.section = "computers";
      return route;
    }
    case "computer": {
      route.section = "computers";
      if (rest[0]) route.computerId = rest[0];
      return route;
    }
    case "scheduled": {
      route.section = "scheduled";
      return route;
    }
    case "bots":
    case "integrations": {
      route.section = "integrations";
      return route;
    }
    default:
      return route;
  }
}

function buildPath(
  route: { section: SectionId; channel: string; chatTab: "chat" | "tasks"; agentId: string | null; computerId: string | null; threadId: string | null },
  state: AppState
): string {
  let path = "/";
  if (route.section === "tasks") {
    path = "/tasks";
  } else if (route.section === "chat") {
    if (route.channel.startsWith("dm:")) {
      const agentId = route.channel.slice(3);
      const agent = state.agents.find(a => a.id === agentId);
      const handle = agent?.handle || agent?.id || agentId;
      path = `/dm/${encodeURIComponent(handle)}`;
    } else {
      const name = route.channel.replace(/^#/, "");
      path = `/channel/${encodeURIComponent(name)}`;
      if (route.chatTab === "tasks") path += "/tasks";
    }
  } else if (route.section === "members") {
    if (route.agentId) path = `/agent/${encodeURIComponent(route.agentId)}`;
    else path = "/agents";
  } else if (route.section === "computers") {
    if (route.computerId) path = `/computer/${encodeURIComponent(route.computerId)}`;
    else path = "/computers";
  } else if (route.section === "scheduled") {
    path = "/scheduled";
  } else if (route.section === "integrations") {
    path = "/bots";
  }
  const params = new URLSearchParams();
  if (route.threadId) params.set("thread", route.threadId);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}


function agentRuntimeError(agent: Agent): string {
  return typeof agent.lastRuntimeStatus?.error === "string" ? agent.lastRuntimeStatus.error : "";
}

function isAgentStopped(agent: Agent) {
  return (
    ["offline", "stopped", "exited", "launch_failed"].includes(agent.status) ||
    agent.desiredStatus === "stopped"
  );
}

function getMentionMembers(state: AppState, channelTarget?: string): MentionMember[] {
  // In a DM channel (`dm:<agentId>`), the only valid agent mention is the DM
  // peer; offering other agents would mislead the user since the server
  // strips them out anyway.
  const dmAgentId = channelTarget && channelTarget.startsWith("dm:") ? channelTarget.slice(3) : null;
  const agents = dmAgentId
    ? state.agents.filter(agent => agent.id === dmAgentId)
    : state.agents;
  return [
    ...state.humans.map(human => ({
      id: human.id,
      kind: "human" as const,
      name: human.name,
      handle: human.handle || slugHandle(human.name),
      status: human.role || "human"
    })),
    ...agents.map(agent => ({
      id: agent.id,
      kind: "agent" as const,
      name: agent.name,
      handle: agent.handle || slugHandle(agent.name),
      status: agent.status
    }))
  ];
}

function isMentionNavigationKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === "Tab" || key === "Escape";
}

function findMentionMatch(value: string, cursor: number): MentionMatch | null {
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const prefix = at === 0 ? "" : before[at - 1];
  if (prefix && !/\s/.test(prefix)) return null;
  const query = before.slice(at + 1);
  if (!/^[A-Za-z0-9_-]*$/.test(query)) return null;
  return { start: at, end: cursor, query };
}

function collectMentions(text: string, members: MentionMember[]) {
  const handles = new Set(
    Array.from(text.matchAll(/@([A-Za-z0-9_-]+)/g)).map(match => match[1].toLowerCase())
  );
  return members
    .filter(member => handles.has(member.handle.toLowerCase()))
    .map(member => ({
      id: member.id,
      kind: member.kind,
      handle: member.handle,
      name: member.name
    }));
}

function renderMentionText(text: string) {
  const parts = String(text || "").split(/(@[A-Za-z0-9_-]+)/g);
  return parts.map((part, index) => {
    if (part.startsWith("@"))
      return (
        <span className="mention-text" key={index}>
          {part}
        </span>
      );
    return <React.Fragment key={index}>{part}</React.Fragment>;
  });
}

function renderMentionChildren(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, child => {
    if (typeof child === "string") return renderMentionText(child);
    return child;
  });
}

function MessageContent({ text, agent: _agent }: { text: string; agent?: boolean }) {
  const value = String(text || "");
  return (
    <div className="msg-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{renderMentionChildren(children)}</p>,
          li: ({ children }) => <li>{renderMentionChildren(children)}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          code: ({ className, children, ...rest }) => {
            const inline = !/language-/.test(className || "") && !String(children).includes("\n");
            if (inline) {
              return (
                <code className="md-code-inline" {...rest}>
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          }
        }}
      >
        {value}
      </ReactMarkdown>
    </div>
  );
}

function slugHandle(value: string) {
  return (
    String(value || "member")
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "member"
  );
}

function groupAgentsByComputer(state: AppState) {
  const groups = state.computers.map(computer => ({
    id: computer.id,
    name: computer.name,
    status: computer.status,
    agents: state.agents.filter(agent => agent.computerId === computer.id)
  }));
  const knownComputerIds = new Set(state.computers.map(computer => computer.id));
  const unassigned = state.agents.filter(agent => !agent.computerId || !knownComputerIds.has(agent.computerId));
  if (unassigned.length) {
    groups.push({
      id: "unassigned",
      name: "Unassigned",
      status: "offline",
      agents: unassigned
    });
  }
  return groups.filter(group => group.agents.length > 0);
}

// ---------- computers ----------

function ComputersView({
  state,
  selectedComputer,
  openConnectComputer,
  toggleAgent,
  deleteComputer
}: {
  state: AppState;
  selectedComputer: ComputerEntity | null;
  openConnectComputer: () => void;
  toggleAgent: (a: Agent) => void;
  deleteComputer: (c: ComputerEntity) => void;
}) {
  const computer = selectedComputer || state.computers[0];
  const onlineRuntimeIds = useMemo(() => {
    if (!computer) return new Set<string>();
    return new Set(
      state.agents
        .filter(
          a =>
            a.computerId === computer.id &&
            a.desiredStatus !== "stopped" &&
            String(a.status || "").toLowerCase() === "online"
        )
        .map(a => a.runtime)
    );
  }, [computer, state.agents]);

  return (
    <section className="pane">
      <Topbar
        eyebrow="Devices"
        title={computer?.name || "Computers"}
        subtitle="Connect local machines and inspect their daemon and runtime status."
      />
      {!computer && (
        <div className="empty computers-empty">
          <span className="brand-spike" aria-hidden />
          <h3>No computer connected.</h3>
          <p>Bring your own machine — local agents need a host to think from.</p>
          <button className="btn btn-primary" onClick={openConnectComputer}>
            <Plus size={15} /> Connect computer
          </button>
        </div>
      )}
      {computer && (
        <article className="computer-card">
          <div className="computer-card-icon">
            <Computer size={28} />
          </div>
          <div className="computer-card-body">
            <p className="eyebrow">Connected device</p>
            <h1>
              {computer.name} <small>{computer.status}</small>
            </h1>
            <p className="muted">
              {computer.fingerprint.os} · {computer.fingerprint.arch} · daemon {computer.daemonVersion}
            </p>
            <div className="chips">
              {computer.runtimes.map(r => (
                <span className={`chip-runtime ${r.installed ? "live" : "dim"}`} key={r.id}>
                  {r.installed && (
                    <span className={`chip-dot ${onlineRuntimeIds.has(r.id) ? "online" : "offline"}`} />
                  )}{" "}
                  {r.name}
                  {r.installed ? "" : " · not installed"}
                </span>
              ))}
            </div>
          </div>
          <div className="computer-card-actions">
            <button
              className="btn btn-ghost btn-danger"
              onClick={() => deleteComputer(computer)}
              title="Delete this computer"
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </article>
      )}
      {computer && computer.connectToken && (
        <ComputerConnectCommand computer={computer} />
      )}
      <div className="section-head">
        <h2>Agents on this computer</h2>
      </div>
      <div className="agent-table">
        {state.agents
          .filter(a => !computer || a.computerId === computer.id)
          .map(a => (
            <div className="agent-row" key={a.id}>
              <Avatar name={a.name} agent />
              <div>
                <strong>{a.name}</strong>
                <small>{a.runtime}</small>
                {agentRuntimeError(a) && <small className="agent-error">{agentRuntimeError(a)}</small>}
              </div>
              <span className={`status-pill ${agentRuntimeError(a) ? "error" : isAgentStopped(a) ? "closed" : "in_progress"}`}>
                {a.status}
              </span>
              <button className="btn btn-ghost" onClick={() => toggleAgent(a)}>
                {isAgentStopped(a) ? <Play size={13} /> : <Square size={13} />}
                {isAgentStopped(a) ? " Start" : " Stop"}
              </button>
            </div>
          ))}
        {state.agents.filter(a => !computer || a.computerId === computer?.id).length === 0 && (
          <p className="muted padded">No agents on this computer yet.</p>
        )}
      </div>
    </section>
  );
}

// navigator.clipboard is only defined in secure contexts (HTTPS or
// localhost/127.0.0.1). On plain HTTP LAN access (e.g. http://10.0.0.5:4318)
// it's undefined and calling .writeText throws TypeError. Fall back to the
// legacy textarea + execCommand("copy") path which still works there.
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function ComputerConnectCommand({ computer }: { computer: ComputerEntity }) {
  const command = useMemo(() => {
    const origin = window.location.origin;
    const tok = computer.connectToken || "";
    return [
      "npx",
      "-y",
      "@myersguo/iteam@latest",
      "daemon",
      "connect",
      "--server-url",
      origin,
      "--connect-token",
      tok
    ].join(" ");
  }, [computer.connectToken]);

  const [copied, setCopied] = useState(false);
  async function copy() {
    const ok = await copyToClipboard(command);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <section className="connect-command-block">
      <div className="connect-command-head">
        <p className="eyebrow">Connect command</p>
        <p className="connect-command-hint">Run this once on your local machine to pair the daemon.</p>
      </div>
      <div className="terminal terminal-inline">
        <div className="terminal-body terminal-body-inline">
          <div className="terminal-scroll" role="region" aria-label="Connect command">
            <code className="terminal-command">
              <span className="prompt">$</span> {command}
            </code>
          </div>
          <button className="terminal-copy" title="Copy" onClick={copy}>
            <Copy size={14} /> {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
    </section>
  );
}

function ConnectComputerModal({
  invite,
  connectedComputer,
  onClose
}: {
  invite: ConnectInvite;
  connectedComputer: ComputerEntity | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copyCommand() {
    const ok = await copyToClipboard(invite.command);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connect-computer-title"
        onClick={e => e.stopPropagation()}
      >
        <button className="modal-close" title="Close" onClick={onClose}>
          <X />
        </button>
        <p className="eyebrow">Bring your own machine</p>
        <h1 id="connect-computer-title">Connect a computer.</h1>
        <p className="modal-lede">
          Run the command below on the machine you want to register. iTeam pairs over a local
          handshake — no cloud round-trip.
        </p>
        <div className="terminal">
          <header>
            <span className="dot red" />
            <span className="dot amber" />
            <span className="dot teal" />
            <span className="terminal-label">~/iteam · pair</span>
          </header>
          <div className="terminal-body">
            <code>
              <span className="prompt">$</span> {invite.command}
            </code>
            <button className="terminal-copy" title="Copy" onClick={copyCommand}>
              <Copy size={14} /> {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
        <div className={`pair-state ${connectedComputer ? "is-connected" : ""}`}>
          <span className="pair-dot" />
          <strong>
            {connectedComputer
              ? `${connectedComputer.name} connected.`
              : "Waiting for the handshake…"}
          </strong>
        </div>
        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!connectedComputer} onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>
  );
}

// ---------- chrome ----------

function Topbar({
  eyebrow,
  title,
  subtitle
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <header className="topbar">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="topbar-sub">{subtitle}</p>}
      </div>
    </header>
  );
}

function Avatar({
  name,
  agent,
  large
}: {
  name: string;
  agent?: boolean;
  large?: boolean;
}) {
  return (
    <span className={`avatar ${agent ? "is-agent" : ""} ${large ? "is-large" : ""}`}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
