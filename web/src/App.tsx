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
import "./styles.css";

// ---------- types ----------

type SectionId = "chat" | "members" | "computers";

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
}

interface Channel {
  id: string;
  name: string;
  target: string;
  kind?: string;
  description?: string;
  memberIds?: string[];
}

interface Message {
  id: string;
  target: string;
  authorId: string;
  text: string;
  type?: string;
  createdAt: string;
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
  createdBy?: string;
  assigneeId?: string | null;
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

interface AppState {
  humans: Human[];
  agents: Agent[];
  channels: Channel[];
  messages: Message[];
  tasks: Task[];
  computers: ComputerEntity[];
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
    const [humans, agents, channels, tasks, computers] = await Promise.all([
      fetch("/api/humans").then(r => r.json()),
      fetch("/api/agents").then(r => r.json()),
      fetch("/api/channels").then(r => r.json()),
      fetch("/api/tasks").then(r => r.json()),
      fetch("/api/computers").then(r => r.json())
    ]);
    const selectedChannel = resolveChannel(channels, channelTarget);
    const messages = selectedChannel
      ? await fetch(`/api/messages/channel/${encodeURIComponent(selectedChannel.id)}?limit=10`).then(r => r.json())
      : [];
    return { humans, agents, channels, messages, tasks, computers, events: [] };
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
  const [message, setMessage] = useState("");
  const [asTask, setAsTask] = useState(false);
  const [agentName, setAgentName] = useState("codex");
  const [agentDescription, setAgentDescription] = useState("");
  const [runtime, setRuntime] = useState("codex");
  const [agentComputerId, setAgentComputerId] = useState("");
  const [agentModel, setAgentModel] = useState("");
  const [connectInvite, setConnectInvite] = useState<ConnectInvite | null>(null);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [renameChannel, setRenameChannel] = useState<Channel | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [channelsCollapsed, setChannelsCollapsed] = useState(false);
  const [threadRootId, setThreadRootIdState] = useState<string | null>(initialRoute.threadId);
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
  const threadRoot = state?.messages.find(m => m.id === threadRootId) || null;
  const threadTarget = threadRoot ? `${threadRoot.target}:${threadRoot.id}` : null;

  async function loadThreadMessages(target: string) {
    const messages = await fetch(`/api/messages?target=${encodeURIComponent(target)}&limit=50`).then(r => r.json());
    setThreadMessages(messages);
  }

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
  }, [threadTarget]);

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
    await api.post("/api/messages", {
      target,
      text,
      authorId: "human-local",
      mentions,
      defaultAgentId: selectedAgentId || null
    });
    await loadThreadMessages(target);
    refresh(channel);
  }

  async function createTask(body: Record<string, unknown>) {
    const task = await api.post<Task>("/api/tasks", { target: channel, ...body });
    setThreadRootId(task.messageId);
    refresh();
  }

  async function updateTask(task: Task, patch: Record<string, unknown>) {
    await api.patch(`/api/tasks/${task.id}`, patch);
    refresh();
  }

  async function createAgent() {
    const agent = await api.post<Agent>("/api/agents", {
      name: agentName,
      description: agentDescription,
      runtime,
      model: agentModel,
      computerId: agentComputerId
    });
    setSelectedAgentId(agent.id);
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
      <nav className="rail" aria-label="Primary">
        <div className="brand">
          <span className="brand-spike" aria-hidden />
          <span className="brand-word">iTeam</span>
        </div>
        <div className="rail-nav">
          <RailButton
            active={section === "chat"}
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
        {section === "chat" && (
          <ChatSidebar
            state={state}
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
        {section !== "chat" && section !== "computers" && (
          <MembersSidebar
            state={state}
            selectedAgentId={selectedAgentId}
            setSelectedAgentId={setSelectedAgentId}
            openCreateAgent={() => setCreateAgentOpen(true)}
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
            openThread={setThreadRootId}
            tab={chatTab}
            setTab={setChatTab}
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
      {threadRoot && (
        <ThreadPanel
          state={state}
          root={threadRoot}
          messages={threadMessages}
          onClose={() => setThreadRootId(null)}
          onViewChannel={() => {
            setSection("chat");
            setChatTab("chat");
            if (threadRoot) setChannel(threadRoot.target);
            setThreadRootId(null);
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
  return ({ chat: "Channels", members: "Members", computers: "Computers" } as const)[section];
}

function ChatSidebar({
  state,
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
      {!channelsCollapsed && (
        <div className="side-collapsible">
          {publicChannels.map(c => {
            const protectedChannel = isProtectedChannel(c);
            return (
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                className={`side-row channel-row ${channel === c.target ? "is-selected" : ""}`}
                onClick={() => setChannel(c.target)}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") setChannel(c.target);
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
                <small>{c.memberIds?.length || 0}</small>
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
                className={`side-row member ${channel === dm.target ? "is-selected" : ""}`}
                onClick={() => {
                  if (agent) setSelectedAgentId(agent.id);
                  setChannel(dm.target);
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
  openCreateAgent
}: {
  state: AppState;
  selectedAgentId: string | null;
  setSelectedAgentId: (id: string) => void;
  openCreateAgent: () => void;
}) {
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
      {state.agents.map(a => (
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
              onKeyUp={e => refreshMention(e.target as HTMLTextAreaElement)}
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
          openThread={openThread}
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
  const author = agent || human || { name: message.authorId, role: "system" };
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

// ---------- tasks ----------

function TasksView({
  state,
  channel,
  createTask,
  updateTask,
  openThread
}: {
  state: AppState;
  channel: string;
  createTask: (body: Record<string, unknown>) => Promise<void>;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openThread: (id: string) => void;
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
                      openThread={openThread}
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
              openThread={openThread}
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

function TaskCard({
  task,
  state,
  updateTask,
  openThread,
  list = false
}: {
  task: Task;
  state: AppState;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openThread: (id: string) => void;
  list?: boolean;
}) {
  const assignee = state.agents.find(a => a.id === task.assigneeId);
  const replies = countThreadReplies(state, { target: task.target, id: task.messageId } as Message);
  return (
    <article className={`task-card ${list ? "list" : ""}`} onClick={() => openThread(task.messageId)}>
      <small className="task-num">#{task.number || task.id}</small>
      <h3>{task.title}</h3>
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
          <ul className="agent-mini-list">
            {state.agents.map(a => (
              <li key={a.id}>
                <Avatar name={a.name} agent />
                <span>{a.name}</span>
                <small>{a.status}</small>
              </li>
            ))}
            {!state.agents.length && <li className="muted">No agents yet.</li>}
          </ul>
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
              <dl className="profile-dl">
                <div>
                  <dt>Runtime</dt>
                  <dd>{selectedAgent.runtime}</dd>
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
  createAgent: () => void;
  onClose: () => void;
}) {
  const computer = state.computers.find(c => c.id === agentComputerId);
  const runtimes = (computer?.runtimes || []).filter(
    r => ["codex", "claude", "gemini", "trae"].includes(r.id) && r.installed
  );
  const valid = agentComputerId && agentName.trim() && runtime && runtimes.some(r => r.id === runtime);

  useEffect(() => {
    if (!agentComputerId && state.computers[0]) setAgentComputerId(state.computers[0].id);
  }, [agentComputerId, state.computers, setAgentComputerId]);

  useEffect(() => {
    const available = (computer?.runtimes || []).filter(
      r => ["codex", "claude", "gemini", "trae"].includes(r.id) && r.installed
    );
    if (available.length && !available.some(r => r.id === runtime)) setRuntime(available[0].id);
  }, [computer, runtime, setRuntime]);

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
          <label className="field">
            <span>Runtime</span>
            <select value={runtime} onChange={e => setRuntime(e.target.value)}>
              <option value="">Select…</option>
              {runtimes.map(r => (
                <option value={r.id} key={r.id}>
                  {runtimeLabel(r.id)}
                </option>
              ))}
            </select>
          </label>
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
          <p className="form-error">No supported agent runtime is installed on this computer.</p>
        )}

        <footer className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!valid} onClick={createAgent}>
            Create agent
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

function runtimeLabel(runtime: string): string {
  return ({ codex: "Codex CLI", claude: "Claude Code", gemini: "Gemini CLI", trae: "Trae CLI (traecli)" } as Record<string, string>)[
    runtime
  ] || runtime;
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
          onKeyUp={event => refreshMention(event.target as HTMLTextAreaElement)}
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

function countThreadReplies(state: AppState, message: { target?: string; id?: string }) {
  if (!message?.target || !message?.id) return 0;
  const counted = state.messages.find(item => item.id === message.id)?.replyCount;
  if (typeof counted === "number") return counted;
  return state.messages.filter(item => item.target === `${message.target}:${message.id}`).length;
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
    default:
      return route;
  }
}

function buildPath(
  route: { section: SectionId; channel: string; chatTab: "chat" | "tasks"; agentId: string | null; computerId: string | null; threadId: string | null },
  state: AppState
): string {
  let path = "/";
  if (route.section === "chat") {
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
  }
  const params = new URLSearchParams();
  if (route.threadId) params.set("thread", route.threadId);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
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
              </div>
              <span className={`status-pill ${isAgentStopped(a) ? "closed" : "in_progress"}`}>
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
