import React, { useEffect, useState } from "react";
import { Kanban, List, MessageSquare, Plus, X } from "lucide-react";
import type { AppState, SectionId, Task } from "../types";
import { countThreadReplies } from "./message-list";
import { Topbar } from "./topbar";
import { InlineEmpty, StatusTag, UiButton, UiInput, UiModalHost, UiSelect, UiTextArea } from "./ui";
import { taskStatuses } from "../features";

export interface TaskViewsProps {
  state: AppState;
  fetchTasks: (filter: {
    target?: string;
    status?: string;
    assigneeId?: string;
    createdBy?: string;
    q?: string;
  }) => Promise<Task[]>;
  createTask: (body: Record<string, unknown>) => Promise<void>;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openTaskThread: (task: Task) => void;
  formatChatTitle: (state: AppState, target: string) => string;
  resolveChannel: (channels: AppState["channels"], target: string) => AppState["channels"][number] | null;
  setChannel?: (channel: string) => void;
  setSection?: (section: SectionId) => void;
}

export function TasksView({
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

  async function createFromModal(body: Record<string, unknown>) {
    await createTask(body);
    setCreateOpen(false);
  }

  return (
    <section className="tasks-pane chat-tasks-pane">
      <TaskToolbar
        creator={creator}
        assignee={assignee}
        view={view}
        onCreatorChange={setCreator}
        onAssigneeChange={setAssignee}
        onViewChange={setView}
        onCreate={() => setCreateOpen(true)}
        state={state}
      />
      <TaskCollection
        tasks={tasks}
        state={state}
        view={view}
        updateTask={updateTask}
        openTaskThread={openTaskThread}
      />
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

export function AllTasksView({
  state,
  fetchTasks,
  updateTask,
  openTaskThread,
  formatChatTitle,
  resolveChannel,
  setChannel,
  setSection
}: Omit<TaskViewsProps, "createTask"> & { createTask?: never }) {
  const [view, setView] = useState<"board" | "list">("board");
  const [target, setTarget] = useState("");
  const [status, setStatus] = useState("open");
  const [assignee, setAssignee] = useState("");
  const [creator, setCreator] = useState("");
  const [query, setQuery] = useState("");
  const [tasks, setTasks] = useState<Task[]>(state.tasks);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchTasks({
      target,
      status,
      assigneeId: assignee,
      createdBy: creator,
      q: query.trim()
    })
      .then(next => {
        if (alive) setTasks(next);
      })
      .catch(() => {
        if (alive) setTasks([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target, status, assignee, creator, query, state.tasks, fetchTasks]);

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
          <UiSelect value={target} onChange={event => setTarget(event.target.value)}>
            <option value="">Any channel</option>
            {state.channels.map(channel => (
              <option key={channel.id} value={channel.target}>
                {channel.kind === "dm" ? formatChatTitle(state, channel.target) : `#${channel.name}`}
              </option>
            ))}
          </UiSelect>
        </label>
        <label className="select-shell">
          <span>Status</span>
          <UiSelect value={status} onChange={event => setStatus(event.target.value)}>
            <option value="open">Open</option>
            <option value="all">Any status</option>
            {taskStatuses().map(item => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </UiSelect>
        </label>
        <label className="select-shell">
          <span>Assignee</span>
          <UiSelect value={assignee} onChange={event => setAssignee(event.target.value)}>
            <option value="">Anyone</option>
            {state.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </UiSelect>
        </label>
        <label className="select-shell">
          <span>Creator</span>
          <UiSelect value={creator} onChange={event => setCreator(event.target.value)}>
            <option value="">Anyone</option>
            {state.humans.map(human => <option key={human.id} value={human.id}>{human.name}</option>)}
            {state.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </UiSelect>
        </label>
        <label className="select-shell">
          <span>Search</span>
          <UiInput value={query} onChange={event => setQuery(event.target.value)} placeholder="Title or description" />
        </label>
        <span className="toolbar-spacer" />
        <ViewToggle view={view} onChange={setView} />
      </div>
      {loading && <div className="message-loading">Loading tasks...</div>}
      <TaskCollection
        tasks={tasks}
        state={state}
        view={view}
        updateTask={updateTask}
        openTaskThread={openTaskThread}
        showChannel
        formatChatTitle={formatChatTitle}
        resolveChannel={resolveChannel}
      />
      <div className="task-page-foot">
        {target && setChannel && setSection && (
          <UiButton
            className="btn btn-ghost"
            onClick={() => {
              setChannel(target);
              setSection("chat");
            }}
          >
            <MessageSquare size={14} /> View selected channel
          </UiButton>
        )}
      </div>
    </section>
  );
}

function TaskToolbar({
  state,
  creator,
  assignee,
  view,
  onCreatorChange,
  onAssigneeChange,
  onViewChange,
  onCreate
}: {
  state: AppState;
  creator: string;
  assignee: string;
  view: "board" | "list";
  onCreatorChange: (value: string) => void;
  onAssigneeChange: (value: string) => void;
  onViewChange: (view: "board" | "list") => void;
  onCreate: () => void;
}) {
  return (
    <div className="task-toolbar">
      <label className="select-shell">
        <span>Creator</span>
        <UiSelect value={creator} onChange={event => onCreatorChange(event.target.value)}>
          <option value="">Anyone</option>
          {state.humans.map(human => <option key={human.id} value={human.id}>{human.name}</option>)}
          {state.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </UiSelect>
      </label>
      <label className="select-shell">
        <span>Assignee</span>
        <UiSelect value={assignee} onChange={event => onAssigneeChange(event.target.value)}>
          <option value="">Anyone</option>
          {state.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
        </UiSelect>
      </label>
      <span className="toolbar-spacer" />
      <ViewToggle view={view} onChange={onViewChange} />
      <UiButton className="btn btn-primary" onClick={onCreate}><Plus size={14} /> New task</UiButton>
    </div>
  );
}

function ViewToggle({
  view,
  onChange
}: {
  view: "board" | "list";
  onChange: (view: "board" | "list") => void;
}) {
  return (
    <div className="seg">
      <UiButton className={view === "board" ? "is-active" : ""} onClick={() => onChange("board")}>
        <Kanban size={14} /> Board
      </UiButton>
      <UiButton className={view === "list" ? "is-active" : ""} onClick={() => onChange("list")}>
        <List size={14} /> List
      </UiButton>
    </div>
  );
}

function TaskCollection({
  tasks,
  state,
  view,
  updateTask,
  openTaskThread,
  list = false,
  showChannel = false,
  formatChatTitle,
  resolveChannel
}: {
  tasks: Task[];
  state: AppState;
  view: "board" | "list";
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openTaskThread: (task: Task) => void;
  list?: boolean;
  showChannel?: boolean;
  formatChatTitle?: (state: AppState, target: string) => string;
  resolveChannel?: (channels: AppState["channels"], target: string) => AppState["channels"][number] | null;
}) {
  const statuses = taskStatuses();
  if (view === "list" || list) {
    return (
      <div className="task-list">
        {tasks.map(task => (
          <TaskCard
            key={task.id}
            task={task}
            state={state}
            updateTask={updateTask}
            openTaskThread={openTaskThread}
            list
            showChannel={showChannel}
            formatChatTitle={formatChatTitle}
            resolveChannel={resolveChannel}
          />
        ))}
        {tasks.length === 0 && <InlineEmpty title="No tasks yet." />}
      </div>
    );
  }
  return (
    <div className="task-board">
      {statuses.map(status => {
        const columnTasks = tasks.filter(task => task.status === status.id);
        return (
          <section className="task-column" key={status.id}>
            <header>
              <StatusTag tone={status.id}>{status.label}</StatusTag>
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
                  showChannel={showChannel}
                  formatChatTitle={formatChatTitle}
                  resolveChannel={resolveChannel}
                />
              ))}
              {columnTasks.length === 0 && <div className="task-empty">No {status.label.toLowerCase()} tasks.</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  state,
  updateTask,
  openTaskThread,
  list = false,
  showChannel = false,
  formatChatTitle,
  resolveChannel
}: {
  task: Task;
  state: AppState;
  updateTask: (task: Task, patch: Record<string, unknown>) => Promise<void>;
  openTaskThread: (task: Task) => void;
  list?: boolean;
  showChannel?: boolean;
  formatChatTitle?: (state: AppState, target: string) => string;
  resolveChannel?: (channels: AppState["channels"], target: string) => AppState["channels"][number] | null;
}) {
  const assignee = state.agents.find(agent => agent.id === task.assigneeId);
  const replies = typeof task.replyCount === "number"
    ? task.replyCount
    : countThreadReplies(state, { target: task.target, id: task.messageId });
  const channel = resolveChannel?.(state.channels, task.target);
  return (
    <article className={`task-card ${list ? "list" : ""}`} onClick={() => openTaskThread(task)}>
      <small className="task-num">#{task.number || task.id}</small>
      <div>
        {showChannel && (
          <small className="task-channel">
            {channel?.kind === "dm"
              ? formatChatTitle?.(state, task.target)
              : channel ? `#${channel.name}` : task.target}
          </small>
        )}
        <h3>{task.title}</h3>
      </div>
      {task.description && <p>{task.description}</p>}
      <div className="task-meta">
        <span>{assignee ? `@${assignee.handle || assignee.name}` : "Unassigned"}</span>
        <span>{replies} replies</span>
      </div>
      <UiSelect
        className="task-status"
        value={task.status}
        onClick={event => event.stopPropagation()}
        onChange={event => void updateTask(task, { status: event.target.value })}
      >
        {taskStatuses().map(status => <option key={status.id} value={status.id}>{status.label}</option>)}
      </UiSelect>
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
    <UiModalHost onClose={onClose}>
      <section className="modal" role="dialog" aria-modal="true">
        <UiButton className="modal-close" title="Close" onClick={onClose}><X /></UiButton>
        <p className="eyebrow">New work</p>
        <h1>Make it a task.</h1>
        <p className="modal-lede">Tasks live alongside the chat — every reply, every status flip, captured in one thread.</p>
        <label className="field">
          <span>Title <em>required</em></span>
          <UiInput value={title} onChange={event => setTitle(event.target.value)} placeholder="Write a task..." />
        </label>
        <label className="field">
          <span>Description</span>
          <UiTextArea value={description} onChange={event => setDescription(event.target.value)} placeholder="Optional details, acceptance criteria, links..." />
        </label>
        <label className="field">
          <span>Assignee</span>
          <UiSelect value={assigneeId} onChange={event => setAssigneeId(event.target.value)}>
            <option value="">Unassigned</option>
            {state.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </UiSelect>
        </label>
        <footer className="modal-actions">
          <UiButton className="btn btn-ghost" onClick={onClose}>Cancel</UiButton>
          <UiButton
            className="btn btn-primary"
            disabled={!valid}
            onClick={() => void onCreate({ title, description, assigneeId: assigneeId || null })}
          >
            Create task
          </UiButton>
        </footer>
      </section>
    </UiModalHost>
  );
}

