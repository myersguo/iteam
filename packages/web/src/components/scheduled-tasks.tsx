import React, { useState } from "react";
import { Pencil, Play, Square, Trash2, X } from "lucide-react";
import type { AppState, ScheduledTask } from "../types";
import { Topbar } from "./topbar";
import { InlineEmpty, StatusTag, UiButton, UiInput, UiModalHost, UiSelect, UiTextArea } from "./ui";

export interface ScheduledTasksViewProps {
  state: AppState;
  selectedAgentId: string;
  selectAgent: (agentId: string) => void;
  updateScheduledTask: (task: ScheduledTask, patch: Record<string, unknown>) => Promise<void>;
  deleteScheduledTask: (task: ScheduledTask) => Promise<void>;
}

export function ScheduledTasksView({
  state,
  selectedAgentId,
  selectAgent,
  updateScheduledTask,
  deleteScheduledTask
}: ScheduledTasksViewProps) {
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
    .sort((left, right) => left.nextRunAt.localeCompare(right.nextRunAt));
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
          <UiSelect value={status} onChange={event => setStatus(event.target.value)}>
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </UiSelect>
        </label>
        <label className="select-shell">
          <span>Agent</span>
          <UiSelect value={selectedAgentId} onChange={event => selectAgent(event.target.value)}>
            <option value="">Any agent</option>
            {state.agents
              .filter(agent => state.scheduledTasks.some(task => task.agentId === agent.id))
              .map(agent => (
                <option key={agent.id} value={agent.id}>{agent.name}</option>
              ))}
            {state.scheduledTasks.some(task => !state.agents.some(agent => agent.id === task.agentId)) && (
              <option value="__missing__">Missing agent</option>
            )}
          </UiSelect>
        </label>
      </div>
      <div className="schedule-list">
        {tasks.map(task => {
          const agent = state.agents.find(item => item.id === task.agentId);
          return (
            <article className="schedule-card" key={task.id}>
              <header>
                <div>
                  <p className="eyebrow">{task.target}</p>
                  <h2>{agent ? `@${agent.handle || agent.name}` : task.agentId}</h2>
                </div>
                <StatusTag tone={task.status === "active" ? "done" : "closed"}>{task.status}</StatusTag>
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
                <div><dt>Next run</dt><dd>{formatDateTime(task.nextRunAt)}</dd></div>
                <div><dt>Last run</dt><dd>{task.lastRunAt ? formatDateTime(task.lastRunAt) : "Never"}</dd></div>
                <div><dt>Runs</dt><dd>{task.runCount}</dd></div>
                <div><dt>Last message</dt><dd className="mono">{task.lastMessageId || "—"}</dd></div>
                <div><dt>ID</dt><dd className="mono">{task.id}</dd></div>
              </dl>
              <footer>
                <UiButton className="btn btn-ghost" onClick={() => setEditingTask(task)}>
                  <Pencil size={13} /> Edit
                </UiButton>
                <UiButton
                  className="btn btn-ghost"
                  onClick={() => updateScheduledTask(task, { status: task.status === "active" ? "paused" : "active" })}
                >
                  {task.status === "active" ? <Square size={13} /> : <Play size={13} />}
                  {task.status === "active" ? " Pause" : " Resume"}
                </UiButton>
                <UiButton className="btn btn-ghost btn-danger" onClick={() => deleteScheduledTask(task)}>
                  <Trash2 size={13} /> Delete
                </UiButton>
              </footer>
            </article>
          );
        })}
        {tasks.length === 0 && (
          <InlineEmpty
            title="No scheduled tasks."
            description={
              selectedAgent
                ? `No schedules are assigned to ${selectedAgent.name}.`
                : "Ask an agent “每隔 10 分钟汇报…”. If the agent declares a schedule, iTeam will run it."
            }
          />
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
      await onSave({ target: target.trim(), agentId, status, ...schedulePatch, prompt: prompt.trim() });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <UiModalHost onClose={onClose}>
      <section className="modal modal-wide" role="dialog" aria-modal="true">
        <UiButton className="modal-close" title="Close" onClick={onClose}><X /></UiButton>
        <p className="eyebrow">Schedule</p>
        <h1>Edit scheduled task.</h1>
        <p className="modal-lede">Changes are saved to the server timer. Future runs will use the edited prompt and cadence.</p>
        <div className="field-row">
          <label className="field">
            <span>Target</span>
            <UiInput value={target} onChange={event => setTarget(event.target.value)} placeholder="#all or dm:agent_id" />
          </label>
          <label className="field">
            <span>Agent</span>
            <UiSelect value={agentId} onChange={event => setAgentId(event.target.value)}>
              {state.agents.map(agent => <option key={agent.id} value={agent.id}>@{agent.handle || agent.name}</option>)}
            </UiSelect>
          </label>
        </div>
        <div className="field-row">
          <label className="field">
            <span>Status</span>
            <UiSelect value={status} onChange={event => setStatus(event.target.value)}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </UiSelect>
          </label>
          <label className="field">
            <span>Schedule type</span>
            <UiSelect value={scheduleType} onChange={event => setScheduleType(event.target.value)}>
              <option value="interval">Interval</option>
              <option value="cron">Cron</option>
            </UiSelect>
          </label>
        </div>
        {scheduleType === "cron" ? (
          <div className="field-row">
            <label className="field">
              <span>Cron expression</span>
              <UiInput className="mono" value={cronExpression} onChange={event => setCronExpression(event.target.value)} placeholder="0 9-19 * * 1-5" />
              <small>Standard 5-field cron: minute hour day month weekday.</small>
            </label>
            <label className="field">
              <span>Timezone</span>
              <UiInput value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="Asia/Shanghai" />
            </label>
          </div>
        ) : (
          <div className="field-row">
            <label className="field">
              <span>Interval minutes</span>
              <UiInput type="number" min="1" step="1" value={intervalMinutes} onChange={event => setIntervalMinutes(event.target.value)} />
            </label>
            <label className="field">
              <span>Next run</span>
              <UiInput type="datetime-local" value={nextRunAt} onChange={event => setNextRunAt(event.target.value)} />
            </label>
          </div>
        )}
        <label className="field">
          <span>Prompt</span>
          <UiTextArea value={prompt} onChange={event => setPrompt(event.target.value)} />
        </label>
        {error && <div className="form-error">{error}</div>}
        <footer className="modal-actions">
          <UiButton className="btn btn-ghost" onClick={onClose}>Cancel</UiButton>
          <UiButton className="btn btn-primary" disabled={!valid} onClick={save}>Save changes</UiButton>
        </footer>
      </section>
    </UiModalHost>
  );
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
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
