import React, { useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Computer,
  Hash,
  Kanban,
  List,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Users
} from "lucide-react";
import type {
  Agent,
  AppState,
  AuthInfo,
  Channel,
  Human,
  SectionId
} from "../types";
import { Avatar } from "./avatar";
import {
  DeliveryCountBadge,
  deliveryActivityForAgent,
  deliveryActivityForTarget
} from "./delivery-activity";
import { SpaceSwitcher } from "./space-switcher";
import { UiButton } from "./ui";
import { agentForDm, channelMessageCount, groupAgentsByComputer, slugHandle } from "../utils";

export function titleFor(section: SectionId): string {
  return ({ chat: "Channels", tasks: "Channels", members: "Members", computers: "Computers", scheduled: "Scheduled", integrations: "Bots" } as const)[section];
}

export function Rail({
  section,
  currentHuman,
  auth,
  onSectionChange,
  onRefresh
}: {
  section: SectionId;
  currentHuman: Human | null;
  auth: AuthInfo | null;
  onSectionChange: (section: SectionId) => void;
  onRefresh: () => void;
}) {
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (!userMenuOpen) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (target && userMenuRef.current?.contains(target)) return;
      setUserMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setUserMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [userMenuOpen]);

  const authenticatedAuth = auth && auth.authMode !== "none" && auth.authenticated ? auth : null;
  return (
    <nav className="rail" aria-label="Primary">
      <div className="brand">
        <span className="brand-spike" aria-hidden />
        <span className="brand-word">iTeam</span>
      </div>
      <div className="rail-nav">
        <RailButton active={section === "chat" || section === "tasks"} label="Chat" icon={<MessageSquare size={18} />} onClick={() => onSectionChange("chat")} />
        <RailButton active={section === "members"} label="Members" icon={<Users size={18} />} onClick={() => onSectionChange("members")} />
        <RailButton active={section === "computers"} label="Computers" icon={<Computer size={18} />} onClick={() => onSectionChange("computers")} />
        <RailButton active={section === "scheduled"} label="Scheduled" icon={<List size={18} />} onClick={() => onSectionChange("scheduled")} />
        <RailButton active={section === "integrations"} label="Bots" icon={<Bot size={18} />} onClick={() => onSectionChange("integrations")} />
      </div>
      <div className="rail-foot">
        {currentHuman && (
          <details className="current-user-menu" ref={userMenuRef} open={userMenuOpen}>
            <summary
              className="current-user"
              title="User menu"
              onClick={event => {
                event.preventDefault();
                setUserMenuOpen(open => !open);
              }}
            >
              <Avatar name={currentHuman.name} avatarUrl={currentHuman.avatarUrl} />
              <span>{currentHuman.name}</span>
            </summary>
            <div className="current-user-popover" role="menu">
              <p className="eyebrow">用户信息</p>
              <strong>{currentHuman.name}</strong>
              <small>{currentHuman.email || currentHuman.username || `@${currentHuman.handle || "you"}`}</small>
              <a
                className="current-user-logout"
                href={authenticatedAuth?.logoutUrl || "/auth/logout"}
                role="menuitem"
                onClick={() => {
                  try {
                    localStorage.removeItem("iteam.authToken");
                  } catch {}
                }}
              >
                登出
              </a>
            </div>
          </details>
        )}
        <UiButton className="ghost-btn" title="Refresh" onClick={onRefresh}>
          <RefreshCw size={16} />
          <span>Refresh</span>
        </UiButton>
      </div>
    </nav>
  );
}

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
    <UiButton className={`rail-btn ${active ? "is-active" : ""}`} title={label} aria-label={label} onClick={onClick}>
      <span className="rail-btn-icon">{icon}</span>
      <span className="rail-btn-label">{label}</span>
      {active && <span className="rail-btn-mark" aria-hidden />}
    </UiButton>
  );
}

export function WorkspaceSidebar({
  state,
  section,
  activeSpaceId,
  sidebarCollapsed,
  onToggle,
  sidebarRef,
  onResizeStart,
  onResizeReset,
  onSwitchSpace,
  onCreateSpace,
  channel,
  onSelectChannel,
  onOpenTasks,
  onCreateChannel,
  onRenameChannel,
  onOpenAgentDm,
  onCreateAgent,
  onRenameHuman,
  onSelectAgent,
  selectedAgentId,
  selectedComputerId,
  onSelectComputer,
  onConnectComputer,
  scheduledAgentId,
  onSelectScheduledAgent,
  selectedBotProvider,
  onSelectBotProvider
}: {
  state: AppState;
  section: SectionId;
  activeSpaceId: string;
  sidebarCollapsed: boolean;
  onToggle: () => void;
  sidebarRef: React.RefObject<HTMLElement | null>;
  onResizeStart: (event: React.MouseEvent<HTMLDivElement>) => void;
  onResizeReset: () => void;
  onSwitchSpace: (spaceId: string) => void;
  onCreateSpace: (name: string, description: string) => Promise<import("../types").Space>;
  channel: string;
  onSelectChannel: (channel: string) => void;
  onOpenTasks: () => void;
  onCreateChannel: () => void;
  onRenameChannel: (channel: Channel) => void;
  onOpenAgentDm: (agent: Agent) => void;
  onCreateAgent: () => void;
  onRenameHuman: (human: Human) => void;
  onSelectAgent: (id: string) => void;
  selectedAgentId: string | null;
  selectedComputerId: string | null;
  onSelectComputer: (id: string) => void;
  onConnectComputer: () => void;
  scheduledAgentId: string;
  onSelectScheduledAgent: (id: string) => void;
  selectedBotProvider: string | null;
  onSelectBotProvider: (provider: string | null) => void;
}) {
  const [channelsCollapsed, setChannelsCollapsed] = useState(false);
  const title = titleFor(section);
  return (
    <aside className="sidebar" aria-label={title} ref={sidebarRef}>
      <UiButton
        className="sidebar-toggle"
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        onClick={onToggle}
      >
        {sidebarCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
      </UiButton>
      <header className="sidebar-head">
        <p className="eyebrow">Workspace</p>
        <h2>{title}</h2>
        <SpaceSwitcher
          spaces={state.spaces || []}
          currentSpaceId={activeSpaceId}
          onSelect={onSwitchSpace}
          onCreated={space => onSwitchSpace(space.id)}
          createSpace={onCreateSpace}
        />
      </header>
      {(section === "chat" || section === "tasks") && (
        <ChatSidebar
          state={state}
          section={section}
          channel={channel}
          channelsCollapsed={channelsCollapsed}
          setChannelsCollapsed={setChannelsCollapsed}
          onSelectChannel={onSelectChannel}
          onOpenTasks={onOpenTasks}
          onCreateChannel={onCreateChannel}
          onRenameChannel={onRenameChannel}
          onOpenAgentDm={onOpenAgentDm}
          onSelectAgent={onSelectAgent}
        />
      )}
      {section === "computers" && (
        <ComputersSidebar state={state} selectedComputerId={selectedComputerId} onSelectComputer={onSelectComputer} onConnectComputer={onConnectComputer} />
      )}
      {section === "scheduled" && (
        <ScheduledSidebar state={state} selectedAgentId={scheduledAgentId} onSelectAgent={onSelectScheduledAgent} />
      )}
      {section === "members" && (
        <MembersSidebar state={state} selectedAgentId={selectedAgentId} onSelectAgent={onSelectAgent} onCreateAgent={onCreateAgent} onRenameHuman={onRenameHuman} />
      )}
      {section === "integrations" && (
        <IntegrationsSidebar state={state} selectedBotProvider={selectedBotProvider} onSelectBotProvider={onSelectBotProvider} />
      )}
      {!sidebarCollapsed && (
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onMouseDown={onResizeStart}
          onDoubleClick={onResizeReset}
        />
      )}
    </aside>
  );
}

export function SectionLabel({
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

function ChatSidebar({
  state,
  section,
  channel,
  channelsCollapsed,
  setChannelsCollapsed,
  onSelectChannel,
  onOpenTasks,
  onCreateChannel,
  onRenameChannel,
  onOpenAgentDm,
  onSelectAgent
}: {
  state: AppState;
  section: SectionId;
  channel: string;
  channelsCollapsed: boolean;
  setChannelsCollapsed: (value: boolean) => void;
  onSelectChannel: (channel: string) => void;
  onOpenTasks: () => void;
  onCreateChannel: () => void;
  onRenameChannel: (channel: Channel) => void;
  onOpenAgentDm: (agent: Agent) => void;
  onSelectAgent: (id: string) => void;
}) {
  const publicChannels = state.channels.filter(channel => channel.kind !== "dm");
  const dmChannels = state.channels.filter(channel => channel.kind === "dm");
  return (
    <>
      <SectionLabel
        action={
          <span className="side-actions">
            <UiButton className="side-add" title={channelsCollapsed ? "Expand channels" : "Collapse channels"} onClick={() => setChannelsCollapsed(!channelsCollapsed)}>
              {channelsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </UiButton>
            <UiButton className="side-add" onClick={onCreateChannel} title="Create channel"><Plus size={14} /></UiButton>
          </span>
        }
      >
        Channels · {publicChannels.length}
      </SectionLabel>
      <UiButton className={`side-row channel-row ${section === "tasks" ? "is-selected" : ""}`} onClick={onOpenTasks}>
        <Kanban size={15} />
        <span>Task</span>
        <small>{state.tasks.length}</small>
      </UiButton>
      {!channelsCollapsed && (
        <div className="side-collapsible">
          {publicChannels.map(c => {
            const activity = deliveryActivityForTarget(state.deliveries, c.target);
            return (
              <div key={c.id} role="button" tabIndex={0} className={`side-row channel-row ${section === "chat" && channel === c.target ? "is-selected" : ""}`} onClick={() => onSelectChannel(c.target)} onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") onSelectChannel(c.target);
              }}>
                <Hash size={15} />
                <span>{c.name}</span>
                <UiButton className="row-icon-btn" title="Edit channel" onClick={event => { event.stopPropagation(); onRenameChannel(c); }}>
                  <Pencil size={13} />
                </UiButton>
                {activity.active > 0 ? <DeliveryCountBadge activity={activity} /> : <small>{channelMessageCount(state, c, channel)}</small>}
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
            const activity = deliveryActivityForTarget(state.deliveries, dm.target);
            return (
              <UiButton key={dm.id} className={`side-row member ${section === "chat" && channel === dm.target ? "is-selected" : ""}`} onClick={() => {
                if (agent) onSelectAgent(agent.id);
                onSelectChannel(dm.target);
              }}>
                <Avatar name={agent?.name || dm.name} agent />
                <span>{agent?.name || dm.name}</span>
                {activity.active > 0 ? <DeliveryCountBadge activity={activity} /> : <small>@{agent?.handle || slugHandle(dm.name)}</small>}
              </UiButton>
            );
          })}
        </div>
      ) : <p className="side-empty">No DMs yet — start one from a member's profile.</p>}
      {state.agents.some(agent => !dmChannels.some(dm => dm.memberIds?.includes(agent.id))) && (
        <div className="dm-start-list">
          {state.agents.filter(agent => !dmChannels.some(dm => dm.memberIds?.includes(agent.id))).map(agent => (
            <UiButton key={agent.id} className="side-row member ghost" onClick={() => onOpenAgentDm(agent)}>
              <Avatar name={agent.name} agent />
              <span>{agent.name}</span>
              <small>start</small>
            </UiButton>
          ))}
        </div>
      )}
    </>
  );
}

function MembersSidebar({
  state,
  selectedAgentId,
  onSelectAgent,
  onCreateAgent,
  onRenameHuman
}: {
  state: AppState;
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onCreateAgent: () => void;
  onRenameHuman: (human: Human) => void;
}) {
  const agentGroups = groupAgentsByComputer(state);
  return (
    <>
      <SectionLabel action={<UiButton className="side-add" onClick={onCreateAgent} title="Create agent"><Plus size={14} /></UiButton>}>
        Agents · {state.agents.length}
      </SectionLabel>
      {agentGroups.map(group => (
        <div className="side-agent-group" key={group.id}>
          <div className="side-agent-group-head"><Computer size={12} /><span>{group.name}</span><small className={`status-dot ${group.status}`}>{group.agents.length}</small></div>
          {group.agents.map(agent => {
            const activity = deliveryActivityForAgent(state.deliveries, agent.id);
            return (
              <UiButton key={agent.id} className={`side-row member ${selectedAgentId === agent.id ? "is-selected" : ""}`} onClick={() => onSelectAgent(agent.id)}>
                <Avatar name={agent.name} agent />
                <span>{agent.name}</span>
                {activity.active > 0 ? <DeliveryCountBadge activity={activity} /> : <small>{agent.status}</small>}
              </UiButton>
            );
          })}
        </div>
      ))}
      {!state.agents.length && <UiButton className="empty-cta" onClick={onCreateAgent}><Plus size={14} /> Create your first agent</UiButton>}
      <SectionLabel>Humans · {state.humans.length}</SectionLabel>
      {state.humans.map(human => (
        <div className="side-row member" key={human.id}>
          <Avatar name={human.name} avatarUrl={human.avatarUrl} /><span>{human.name}</span><small>you</small>
          <UiButton className="row-icon-btn human-rename" title={`Rename ${human.name}`} aria-label={`Rename ${human.name}`} onClick={() => onRenameHuman(human)}><Pencil size={13} /></UiButton>
        </div>
      ))}
    </>
  );
}

function ComputersSidebar({
  state,
  selectedComputerId,
  onSelectComputer,
  onConnectComputer
}: {
  state: AppState;
  selectedComputerId: string | null;
  onSelectComputer: (id: string) => void;
  onConnectComputer: () => void;
}) {
  return (
    <>
      <SectionLabel action={<UiButton className="side-add" onClick={onConnectComputer} title="Connect computer"><Plus size={14} /></UiButton>}>Computers · {state.computers.length}</SectionLabel>
      {state.computers.map(computer => (
        <UiButton key={computer.id} className={`side-row computer ${selectedComputerId === computer.id ? "is-selected" : ""}`} onClick={() => onSelectComputer(computer.id)}>
          <span className="computer-tile"><Computer size={18} /></span><span>{computer.name}</span><small className={`status-dot ${computer.status}`}>{computer.status}</small>
        </UiButton>
      ))}
      {!state.computers.length && <UiButton className="empty-cta" onClick={onConnectComputer}><Plus size={14} /> Connect a computer</UiButton>}
    </>
  );
}

function ScheduledSidebar({
  state,
  selectedAgentId,
  onSelectAgent
}: {
  state: AppState;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
}) {
  const active = state.scheduledTasks.filter(task => task.status === "active").length;
  const assignedAgents = state.agents.map(agent => ({ agent, tasks: state.scheduledTasks.filter(task => task.agentId === agent.id) })).filter(group => group.tasks.length > 0);
  const missingAgentTasks = state.scheduledTasks.filter(task => !state.agents.some(agent => agent.id === task.agentId));
  return (
    <>
      <SectionLabel>Agents with schedules · {assignedAgents.length}</SectionLabel>
      {!!state.scheduledTasks.length && <UiButton className={`side-row schedule-agent-row ${selectedAgentId === "" ? "is-selected" : ""}`} onClick={() => onSelectAgent("")}><span className="computer-tile"><List size={16} /></span><span>All schedules</span><span className="schedule-agent-count">{state.scheduledTasks.length}</span></UiButton>}
      {assignedAgents.map(({ agent, tasks }) => {
        const activeTasks = tasks.filter(task => task.status === "active").length;
        return <UiButton key={agent.id} className={`side-row schedule-agent-row ${selectedAgentId === agent.id ? "is-selected" : ""}`} onClick={() => onSelectAgent(agent.id)}><Avatar name={agent.name} agent /><span><strong>@{agent.handle || agent.name}</strong><small>{activeTasks} active</small></span><span className="schedule-agent-count">{tasks.length}</span></UiButton>;
      })}
      {!!missingAgentTasks.length && <UiButton className={`side-row schedule-agent-row ${selectedAgentId === "__missing__" ? "is-selected" : ""}`} onClick={() => onSelectAgent("__missing__")}><span className="computer-tile"><Bot size={16} /></span><span><strong>Missing agent</strong><small>Assignment unavailable</small></span><span className="schedule-agent-count">{missingAgentTasks.length}</span></UiButton>}
      {!state.scheduledTasks.length && <p className="side-empty">No schedules yet — ask an agent “每隔 10 分钟…”, and it can declare one.</p>}
      <SectionLabel>Summary</SectionLabel>
      <div className="side-row member"><span>{active} active</span><small>{state.scheduledTasks.length - active} paused</small></div>
    </>
  );
}

function IntegrationsSidebar({
  state,
  selectedBotProvider,
  onSelectBotProvider
}: {
  state: AppState;
  selectedBotProvider: string | null;
  onSelectBotProvider: (provider: string | null) => void;
}) {
  const larkConfigs = state.externalBotConfigs.filter(config => config.provider.startsWith("lark") || config.provider.startsWith("feishu"));
  const activeProvider = selectedBotProvider || larkConfigs[0]?.provider || "__new_bot__";
  return (
    <div className="side-section">
      <SectionLabel action={<UiButton className="side-add" onClick={() => onSelectBotProvider("__new_bot__")} title="Add bot"><Plus size={14} /></UiButton>}>Bot integrations</SectionLabel>
      <UiButton className="side-row is-selected"><Bot size={16} /><span>Lark / Feishu</span><small>{larkConfigs.filter(config => config.enabled).length || "setup"}</small></UiButton>
      {larkConfigs.map(config => <UiButton className={`side-row member ${activeProvider === config.provider ? "is-selected" : ""}`} key={config.provider} onClick={() => onSelectBotProvider(config.provider)}><span>{config.alias || config.appId}</span><small>{botStatusLabel(config)}</small></UiButton>)}
    </div>
  );
}

function botStatusLabel(config: AppState["externalBotConfigs"][number]): string {
  if (!config.enabled) return "disabled";
  if (config.status === "connected") return "connected";
  if (config.status === "error") return "error";
  return config.status || "configured";
}
