import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal as ArcoModal,
  Message as ArcoMessage
} from "@arco-design/web-react";
import UrlChangeReporter from "./UrlChangeReporter";
import type {
  Agent,
  AppState,
  AuthInfo,
  Channel,
  ComputerEntity,
  ExternalBotBinding,
  ExternalBotConfig,
  Human,
  Message,
  ScheduledTask,
  SectionId,
  Space,
  Task
} from "./types";
import { api } from "./app/api";
import { buildPath, parseLocation, spaceIdToSlug } from "./app/routing";
import {
  consumeAuthTokenFromHash,
  getActiveSpaceId,
  getAuthToken,
  resolveInitialSpaceId,
  setActiveSpaceId
} from "./app/session";
import { AuthGate } from "./components/auth-gate";
import { MainView } from "./app/MainView";
import { Rail, WorkspaceSidebar } from "./components/navigation";
import { agentForDm, slugHandle } from "./utils";
import {
  isAgentStopped,
  taskToRootMessage
} from "./features";
import { ThreadPanel as ThreadPanelComponent } from "./components/thread-panel";
import {
  CreateChannelModal as CreateChannelModalComponent,
  RenameChannelModal as RenameChannelModalComponent,
  RenameHumanModal as RenameHumanModalComponent
} from "./components/channel-modals";
import {
  CreateAgentModal as CreateAgentModalComponent
} from "./components/members";
import {
  ConnectComputerModal as ConnectComputerModalComponent
} from "./components/computers";
import "@arco-design/web-react/dist/css/arco.css";

// ---------- types ----------

const NEW_BOT_PROVIDER = "__new_bot__";

interface ConnectInvite {
  id: string;
  command: string;
}

// ---------- root ----------

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [auth, setAuth] = useState<AuthInfo | null>(null);
  const [authTokenVersion, setAuthTokenVersion] = useState(0);
  const initialRoute = useMemo(() => parseLocation(window.location), []);
  const [activeSpaceId, setActiveSpaceIdState] = useState<string>(() =>
    resolveInitialSpaceId(initialRoute.spaceSlug)
  );
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
  const [agentShareHistory, setAgentShareHistory] = useState(false);
  const [connectInvite, setConnectInvite] = useState<ConnectInvite | null>(null);
  const [createAgentOpen, setCreateAgentOpen] = useState(false);
  const [createChannelOpen, setCreateChannelOpen] = useState(false);
  const [renameChannel, setRenameChannel] = useState<Channel | null>(null);
  const [renameHuman, setRenameHuman] = useState<Human | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [threadRootId, setThreadRootIdState] = useState<string | null>(initialRoute.threadId);
  const [taskThreadRoot, setTaskThreadRoot] = useState<Message | null>(null);
  const [threadMessages, setThreadMessages] = useState<Message[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === "undefined") return 272;
    const saved = Number(window.localStorage.getItem("iteam-sidebar-width"));
    return Number.isFinite(saved) && saved >= 200 && saved <= 600 ? saved : 272;
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState<{
    title: string;
    content: string;
    onOk: () => Promise<void>;
  } | null>(null);
  const [confirmationLoading, setConfirmationLoading] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);

  function confirmDangerousAction({
    title,
    content,
    onOk
  }: {
    title: string;
    content: string;
    onOk: () => Promise<void>;
  }): void {
    setPendingConfirmation({ title, content, onOk });
  }

  async function handleConfirmationOk(): Promise<void> {
    if (!pendingConfirmation) return;
    setConfirmationLoading(true);
    try {
      await pendingConfirmation.onOk();
      setPendingConfirmation(null);
    } catch (error) {
      ArcoMessage.error((error as Error).message || "Delete failed");
    } finally {
      setConfirmationLoading(false);
    }
  }

  useEffect(() => {
    if (consumeAuthTokenFromHash()) setAuthTokenVersion(version => version + 1);
  }, []);

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

  // Persist active space to localStorage so `apiFetch` (which reads it
  // synchronously via getActiveSpaceId) always sends the current header.
  useEffect(() => {
    setActiveSpaceId(activeSpaceId);
  }, [activeSpaceId]);

  // Once spaces load, resolve any pending slug/id from the URL to the canonical
  // space id. If the URL points at a space that doesn't exist any more, fall
  // back to the default space instead of leaving the user with a permanent
  // "space not found" backend error.
  useEffect(() => {
    if (!state) return;
    const spaces = state.spaces || [];
    if (!spaces.length) return;
    const known = spaces.find(space => space.id === activeSpaceId || space.slug === activeSpaceId);
    if (!known) {
      setActiveSpaceIdState("space_default");
      return;
    }
    if (known.id !== activeSpaceId) setActiveSpaceIdState(known.id);
  }, [state?.spaces, activeSpaceId]);

  // sync state -> URL
  useEffect(() => {
    if (!state) return;
    const spaceSlug = spaceIdToSlug(activeSpaceId, state.spaces || []);
    const next = buildPath(
      { section, channel, chatTab, agentId: selectedAgentId, computerId: selectedComputerId, threadId: threadRootId, spaceSlug },
      state
    );
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, "", next);
    }
  }, [section, channel, chatTab, selectedAgentId, selectedComputerId, threadRootId, state, activeSpaceId]);

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
      if (route.spaceSlug) setActiveSpaceIdState(route.spaceSlug);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /**
   * Change the active space and pull a fresh snapshot for it. Optionally
   * navigate back to `#all` when we know cross-space links wouldn't resolve
   * (e.g. right after creating a new empty space).
   */
  async function switchSpace(spaceId: string, options: { navigateHome?: boolean; spaces?: Space[] } = {}) {
    setActiveSpaceIdState(spaceId);
    setActiveSpaceId(spaceId);
    if (options.navigateHome) {
      setSection("chat");
      setChannel("#all");
      setChatTab("chat");
      setSelectedAgentId(null);
      setSelectedComputerId(null);
      setThreadRootIdState(null);
    }
    // Optimistically merge any known spaces (e.g. the one just created) into
    // the current state so the sidebar and URL update before the refetch
    // returns.
    if (options.spaces && state) {
      setState({ ...state, spaces: options.spaces });
    }
    await refresh(options.navigateHome ? "#all" : channel);
  }

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const channelViewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track the live channel so the (stable) SSE handlers always act on the
  // currently-open channel without re-subscribing on every switch.
  const channelRef = useRef(channel);
  useEffect(() => { channelRef.current = channel; }, [channel]);
  // In-flight guards: if an event arrives while a refresh is running, remember
  // to run once more when it settles instead of stacking concurrent fetches.
  const fullRefreshInFlight = useRef(false);
  const fullRefreshPending = useRef(false);
  const channelRefreshInFlight = useRef(false);
  const channelRefreshPending = useRef(false);
  // Retained only for the SSE cleanup path; the periodic full refresh was
  // removed so a channel page never re-pulls the global lists on its own.
  const throttledFullTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function refresh(channelTarget = channelRef.current) {
    const nextAuth = await api.getAuth();
    setAuth(nextAuth);
    if (nextAuth.authMode !== "none" && !nextAuth.authenticated) {
      setState(null);
      return;
    }
    setState(await api.getState(channelTarget));
  }

  /**
   * Cheap refresh of just the open channel (messages + its deliveries/events/
   * artifacts). Merges into existing state so the global lists (agents, humans,
   * computers, spaces, …) are left untouched — those only change on the heavier
   * `state:changed`-driven full refresh.
   */
  async function refreshChannelView(channelTarget = channelRef.current): Promise<void> {
    const view = await api.getChannelView(channelTarget);
    setState(prev => (prev ? { ...prev, ...view } : prev));
  }

  // Full refresh, coalesced: at most one in flight, with a single trailing
  // re-run if events arrived meanwhile.
  async function runFullRefresh(): Promise<void> {
    if (fullRefreshInFlight.current) {
      fullRefreshPending.current = true;
      return;
    }
    fullRefreshInFlight.current = true;
    try {
      await refresh(channelRef.current);
    } finally {
      fullRefreshInFlight.current = false;
      if (fullRefreshPending.current) {
        fullRefreshPending.current = false;
        void runFullRefresh();
      }
    }
  }

  // Channel-only refresh, coalesced the same way.
  async function runChannelRefresh(): Promise<void> {
    if (channelRefreshInFlight.current) {
      channelRefreshPending.current = true;
      return;
    }
    channelRefreshInFlight.current = true;
    try {
      await refreshChannelView(channelRef.current);
    } catch {
      // A transient fetch failure should not wedge future refreshes.
    } finally {
      channelRefreshInFlight.current = false;
      if (channelRefreshPending.current) {
        channelRefreshPending.current = false;
        void runChannelRefresh();
      }
    }
  }

  // Debounced schedulers. Streaming agent output fires delivery/activity events
  // very frequently, so the light channel refresh is debounced wide enough to
  // coalesce a burst of deltas into a single fetch.
  function scheduleFullRefresh(): void {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => void runFullRefresh(), 300);
  }
  function scheduleChannelRefresh(): void {
    if (channelViewTimerRef.current) clearTimeout(channelViewTimerRef.current);
    channelViewTimerRef.current = setTimeout(() => void runChannelRefresh(), 500);
  }

  // Stable SSE subscription: opened once (per auth token), never torn down on
  // channel switches.
  //
  // On a channel page we only want the message list to stay live. `state:changed`
  // fires on *every* server mutate — new messages, but also periodic computer
  // heartbeats — so it must NOT trigger a full-workspace refresh (spaces /
  // agents / humans / computers / bots). It drives only the light channel
  // refresh, which re-pulls this channel's messages + its channel list.
  //
  // The global lists change rarely and are refreshed by: the initial load,
  // agent lifecycle events, and explicit user actions (creating agents /
  // channels / spaces all call refresh() directly).
  useEffect(() => {
    void runFullRefresh();
    const authToken = getAuthToken();
    const events = new EventSource(authToken ? `/api/events?auth=${encodeURIComponent(authToken)}` : "/api/events");
    events.addEventListener("delivery:event", () => scheduleChannelRefresh());
    events.addEventListener("agent:activity", () => scheduleChannelRefresh());
    events.addEventListener("state:changed", () => scheduleChannelRefresh());
    events.addEventListener("agent:started", () => scheduleFullRefresh());
    events.addEventListener("agent:stopped", () => scheduleFullRefresh());
    return () => {
      events.close();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (channelViewTimerRef.current) clearTimeout(channelViewTimerRef.current);
      if (throttledFullTimerRef.current) clearTimeout(throttledFullTimerRef.current);
    };
  }, [authTokenVersion]);

  // Switching channel should feel instant: the sidebar/messages already render
  // from loaded state, so just pull the new channel's messages in the
  // background without blocking on a full workspace refresh.
  const didInitialChannelLoad = useRef(false);
  useEffect(() => {
    if (!didInitialChannelLoad.current) {
      // The SSE effect's initial full refresh already covers the first channel.
      didInitialChannelLoad.current = true;
      return;
    }
    void runChannelRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    setThreadMessages(await api.fetchTargetMessages(target));
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
    api.fetchTargetMessages(threadTarget)
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
    confirmDangerousAction({
      title: "Delete scheduled task?",
      content: `Delete the scheduled task for ${task.target}?`,
      onOk: async () => {
        await api.del(`/api/scheduled-tasks/${task.id}`);
        refresh();
      }
    });
  }

  async function createAgent() {
    const agent = await api.post<Agent>("/api/agents", {
      name: agentName.trim(),
      description: agentDescription,
      runtime: runtime.trim(),
      model: agentModel,
      computerId: agentComputerId,
      shareRuntimeHistory: agentShareHistory
    });
    setSelectedAgentId(agent.id);
    setRuntime("");
    setAgentShareHistory(false);
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
    confirmDangerousAction({
      title: `Delete ${computer.name}?`,
      content: "This removes all agents on this computer.",
      onOk: async () => {
        await api.del(`/api/computers/${encodeURIComponent(computer.id)}`);
        if (selectedComputerId === computer.id) setSelectedComputerId(null);
        refresh();
      }
    });
  }

  async function deleteAgent(agent: Agent) {
    confirmDangerousAction({
      title: `Delete ${agent.name}?`,
      content: "This stops the runtime and removes its direct message channel.",
      onOk: async () => {
        const nextChannel = channel === `dm:${agent.id}` ? "#all" : channel;
        await api.del(`/api/agents/${encodeURIComponent(agent.id)}`);
        if (selectedAgentId === agent.id) setSelectedAgentId(null);
        if (scheduledAgentId === agent.id) setScheduledAgentId("");
        if (nextChannel !== channel) setChannel(nextChannel);
        refresh(nextChannel);
      }
    });
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

  async function createChannel(body: { name: string; description?: string; defaultAgentId?: string | null }) {
    const created = await api.post<Channel>("/api/channels", body);
    setChannel(created.target);
    setSection("chat");
    setCreateChannelOpen(false);
    refresh(created.target);
  }

  async function updateChannel(channelId: string, body: { name?: string; description?: string; defaultAgentId?: string | null }) {
    const updated = await api.patch<Channel>(`/api/channels/${encodeURIComponent(channelId)}`, body);
    setChannel(updated.target);
    setRenameChannel(null);
    refresh(updated.target);
  }

  async function deleteChannel(channelToDelete: Channel) {
    confirmDangerousAction({
      title: `Delete #${channelToDelete.name}?`,
      content: "Its messages, tasks, schedules, and deliveries will also be deleted.",
      onOk: async () => {
        const deletingCurrentChannel = channel === channelToDelete.target;
        await api.del(`/api/channels/${encodeURIComponent(channelToDelete.id)}`);
        if (renameChannel?.id === channelToDelete.id) setRenameChannel(null);
        if (deletingCurrentChannel) {
          setChannel("#all");
          setSection("chat");
          setThreadRootId(null);
          setTaskThreadRoot(null);
          setThreadMessages([]);
          refresh("#all");
          return;
        }
        refresh();
      }
    });
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
  const authenticatedAuth = auth && auth.authMode !== "none" && auth.authenticated ? auth : null;
  const currentHuman = authenticatedAuth?.human || null;

  if (auth && auth.authMode !== "none" && !auth.authenticated) {
    return <AuthGate auth={auth} />;
  }

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
      <Rail
        section={section}
        currentHuman={currentHuman}
        auth={auth}
        onSectionChange={setSection}
        onRefresh={() => void refresh()}
      />
      <WorkspaceSidebar
        state={state}
        section={section}
        activeSpaceId={activeSpaceId}
        sidebarCollapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(value => !value)}
        sidebarRef={sidebarRef}
        onResizeStart={event => {
          event.preventDefault();
          setResizingSidebar(true);
        }}
        onResizeReset={() => setSidebarWidth(272)}
        onSwitchSpace={spaceId => void switchSpace(spaceId)}
        onCreateSpace={(name, description) => api.post<Space>("/api/spaces", { name, description })}
        channel={channel}
        onSelectChannel={nextChannel => {
          setChannel(nextChannel);
          setSection("chat");
        }}
        onOpenTasks={() => setSection("tasks")}
        onCreateChannel={() => setCreateChannelOpen(true)}
        onRenameChannel={setRenameChannel}
        onOpenAgentDm={openAgentDm}
        onCreateAgent={() => setCreateAgentOpen(true)}
        onRenameHuman={setRenameHuman}
        onSelectAgent={setSelectedAgentId}
        selectedAgentId={selectedAgentId}
        selectedComputerId={selectedComputerId}
        onSelectComputer={setSelectedComputerId}
        onConnectComputer={() => void openConnectComputer()}
        scheduledAgentId={scheduledAgentId}
        onSelectScheduledAgent={setScheduledAgentId}
        selectedBotProvider={selectedBotProvider}
        onSelectBotProvider={setSelectedBotProvider}
      />

      <MainView
        state={state}
        section={section}
        channel={channel}
        messages={channelMessages}
        message={message}
        setMessage={setMessage}
        asTask={asTask}
        setAsTask={setAsTask}
        sendMessage={sendMessage}
        chatTab={chatTab}
        setChatTab={setChatTab}
        openThread={openThread}
        createTask={createTask}
        updateTask={updateTask}
        openTaskThread={openTaskThread}
        setChannel={setChannel}
        setSection={setSection}
        selectedAgent={selectedAgent}
        openCreateAgent={() => setCreateAgentOpen(true)}
        openAgentDm={openAgentDm}
        updateAgent={updateAgent}
        deleteAgent={deleteAgent}
        toggleAgent={toggleAgent}
        selectedComputer={selectedComputer}
        openConnectComputer={openConnectComputer}
        deleteComputer={deleteComputer}
        scheduledAgentId={scheduledAgentId}
        selectScheduledAgent={setScheduledAgentId}
        updateScheduledTask={updateScheduledTask}
        deleteScheduledTask={deleteScheduledTask}
        refresh={refresh}
        selectedBotProvider={selectedBotProvider}
        setSelectedBotProvider={setSelectedBotProvider}
        confirmDangerousAction={confirmDangerousAction}
      />

      {connectInvite && (
        <ConnectComputerModalComponent
          invite={connectInvite}
          connectedComputer={connectedInvite}
          onClose={() => setConnectInvite(null)}
        />
      )}
      {createAgentOpen && (
        <CreateAgentModalComponent
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
          agentShareHistory={agentShareHistory}
          setAgentShareHistory={setAgentShareHistory}
          createAgent={createAgent}
          onClose={() => setCreateAgentOpen(false)}
        />
      )}
      {createChannelOpen && (
        <CreateChannelModalComponent
          agents={state.agents || []}
          onCreate={createChannel}
          onClose={() => setCreateChannelOpen(false)}
        />
      )}
      {renameChannel && (
        <RenameChannelModalComponent
          channel={renameChannel}
          agents={state.agents || []}
          onRename={updateChannel}
          onDelete={deleteChannel}
          onClose={() => setRenameChannel(null)}
        />
      )}
      {renameHuman && (
        <RenameHumanModalComponent
          human={renameHuman}
          onRename={updateHuman}
          onClose={() => setRenameHuman(null)}
        />
      )}
      {pendingConfirmation && (
        <ArcoModal
          visible
          title={pendingConfirmation.title}
          okText="Delete"
          cancelText="Cancel"
          okButtonProps={{ status: "danger" }}
          confirmLoading={confirmationLoading}
          maskClosable={!confirmationLoading}
          closable={!confirmationLoading}
          onCancel={() => setPendingConfirmation(null)}
          onOk={handleConfirmationOk}
        >
          {pendingConfirmation.content}
        </ArcoModal>
      )}
      {threadRoot && (
        <ThreadPanelComponent
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

export default App;
