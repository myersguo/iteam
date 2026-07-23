import React, { useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronDown, Computer, MessageSquare, Pencil, Play, Plus, Square, Trash2, X } from "lucide-react";
import type { Agent, AppState, RuntimeInfo } from "../types";
import { Avatar } from "./avatar";
import { Topbar } from "./topbar";
import { InlineEmpty, UiButton, UiInput, UiModalHost, UiSelect, UiTextArea } from "./ui";
import { groupAgentsByComputer } from "../utils";
import { agentRuntimeError, isAgentStopped } from "../features";

export interface MembersViewProps {
  state: AppState;
  selectedAgent: Agent | null;
  openCreateAgent: () => void;
  openAgentDm: (agent: Agent) => void;
  updateAgent: (agentId: string, patch: { name?: string; description?: string; model?: string | null }) => Promise<void>;
  deleteAgent: (agent: Agent) => Promise<void>;
  toggleAgent: (agent: Agent) => Promise<void>;
}

export function MembersView({
  state,
  selectedAgent,
  openCreateAgent,
  openAgentDm,
  updateAgent,
  deleteAgent,
  toggleAgent
}: MembersViewProps) {
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
          <UiButton className="btn btn-primary wide" onClick={openCreateAgent}>
            <Plus size={15} /> Create agent
          </UiButton>
          <div className="agent-computer-groups">
            {agentGroups.map(group => (
              <section className="agent-computer-group" key={group.id}>
                <header>
                  <span className="agent-computer-icon"><Computer size={14} /></span>
                  <div>
                    <strong>{group.name}</strong>
                    <small>{group.status}</small>
                  </div>
                  <span>{group.agents.length}</span>
                </header>
                <ul className="agent-mini-list">
                  {group.agents.map(agent => (
                    <li key={agent.id}>
                      <Avatar name={agent.name} agent />
                      <span>
                        <strong>{agent.name}</strong>
                        <small>{agent.runtime}</small>
                      </span>
                      <small>{agent.status}</small>
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
                  <h1>{selectedAgent.name} <small>{selectedAgent.status}</small></h1>
                </div>
              </div>
              <label className="profile-rename">
                <span>Display name</span>
                <div>
                  <UiInput
                    value={renameValue}
                    onChange={event => setRenameValue(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === "Enter") void saveName(selectedAgent);
                    }}
                  />
                  <UiButton
                    className="btn btn-secondary-on-dark"
                    disabled={!renameValue.trim() || renameValue.trim() === selectedAgent.name || renameBusy}
                    onClick={() => void saveName(selectedAgent)}
                  >
                    {renameBusy ? "Saving..." : "Save"}
                  </UiButton>
                </div>
                {renameError && <small>{renameError}</small>}
              </label>
              {agentRuntimeError(selectedAgent) && (
                <p className="profile-warning">Launch error: {agentRuntimeError(selectedAgent)}</p>
              )}
              <dl className="profile-dl">
                <div><dt>Runtime</dt><dd>{selectedAgent.runtime}</dd></div>
                <div><dt>Computer</dt><dd>{selectedComputer?.name || "Unassigned"}</dd></div>
                <label className="profile-rename">
                  <span>Model</span>
                  <div>
                    <UiInput
                      value={modelValue}
                      onChange={event => setModelValue(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === "Enter") void saveModel(selectedAgent);
                      }}
                      placeholder="empty = use env var"
                    />
                    <UiButton
                      className="btn btn-secondary-on-dark"
                      disabled={modelValue.trim() === (selectedAgent.model || "") || modelBusy}
                      onClick={() => void saveModel(selectedAgent)}
                    >
                      {modelBusy ? "Saving..." : "Save"}
                    </UiButton>
                  </div>
                  {modelError && <small>{modelError}</small>}
                </label>
                <div><dt>Reasoning</dt><dd>{selectedAgent.reasoning || "default"}</dd></div>
                <div><dt>Workspace</dt><dd className="mono">{selectedAgent.workspacePath || "—"}</dd></div>
              </dl>
              <div className="profile-actions">
                <UiButton className="btn btn-secondary-on-dark" onClick={() => openAgentDm(selectedAgent)}>
                  <MessageSquare size={14} /> Message
                </UiButton>
                <UiButton className="btn btn-secondary-on-dark" onClick={() => void toggleAgent(selectedAgent)}>
                  {isAgentStopped(selectedAgent) ? <Play size={14} /> : <Square size={14} />}
                  {isAgentStopped(selectedAgent) ? " Start agent" : " Stop agent"}
                </UiButton>
                <UiButton className="btn btn-danger-on-dark" onClick={() => void deleteAgent(selectedAgent)}>
                  <Trash2 size={14} /> Delete
                </UiButton>
              </div>
            </>
          ) : (
            <InlineEmpty
              className="empty on-dark"
              icon={<Bot size={32} />}
              description="Select an agent — or create a new one — to see its profile."
            />
          )}
        </article>
      </div>
    </section>
  );
}

export interface CreateAgentModalProps {
  state: AppState;
  agentName: string;
  setAgentName: (value: string) => void;
  agentDescription: string;
  setAgentDescription: (value: string) => void;
  runtime: string;
  setRuntime: (value: string) => void;
  agentComputerId: string;
  setAgentComputerId: (value: string) => void;
  agentModel: string;
  setAgentModel: (value: string) => void;
  agentShareHistory: boolean;
  setAgentShareHistory: (value: boolean) => void;
  createAgent: () => Promise<void> | void;
  onClose: () => void;
}

export function CreateAgentModal({
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
  agentShareHistory,
  setAgentShareHistory,
  createAgent,
  onClose
}: CreateAgentModalProps) {
  const computer = state.computers.find(item => item.id === agentComputerId);
  const runtimes = (computer?.runtimes || []).filter(runtimeInfo => runtimeInfo.installed && runtimeInfo.id !== "mock");
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
    const available = (computer?.runtimes || []).filter(runtimeInfo => runtimeInfo.installed && runtimeInfo.id !== "mock");
    if (available.length && (!runtime.trim() || !available.some(runtimeInfo => runtimeInfo.id === runtime))) {
      setRuntime(preferredCreateRuntime(available));
    }
  }, [agentComputerId, computer, runtime, setRuntime]);

  useEffect(() => {
    setAgentModel(defaultModel(runtime));
  }, [runtime, setAgentModel]);

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

  return (
    <UiModalHost onClose={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="create-agent-title">
        <UiButton className="modal-close" title="Close" onClick={onClose}><X /></UiButton>
        <p className="eyebrow">New collaborator</p>
        <h1 id="create-agent-title">Create an agent.</h1>
        <p className="modal-lede">Choose a computer, name your teammate, and pick the runtime that should think on its behalf.</p>
        <label className="field">
          <span>Computer <em>required</em></span>
          <UiSelect value={agentComputerId} onChange={event => setAgentComputerId(event.target.value)}>
            <option value="">Select…</option>
            {state.computers.map(computerItem => <option value={computerItem.id} key={computerItem.id}>{computerItem.name}</option>)}
          </UiSelect>
        </label>
        <label className="field">
          <span>Name <em>required</em></span>
          <UiInput value={agentName} onChange={event => setAgentName(event.target.value)} placeholder="e.g. Alice" />
        </label>
        <label className="field">
          <span>Description <small>optional</small></span>
          <UiTextArea
            value={agentDescription}
            onChange={event => setAgentDescription(event.target.value)}
            maxLength={3000}
            placeholder="Leave blank for a general-purpose agent, or describe a role..."
          />
          <div className="char-count">{agentDescription.length}/3000</div>
        </label>
        <div className="field-row">
          <div className="field runtime-combobox-field">
            <span>Runtime <small>type or pick</small></span>
            <div className="runtime-combobox">
              <UiInput
                value={runtime}
                onChange={event => {
                  setRuntime(event.target.value);
                  setRuntimePickerOpen(false);
                }}
                onFocus={() => setRuntimePickerOpen(true)}
                placeholder="codex, trae, or configured profile id"
                role="combobox"
                aria-expanded={runtimePickerOpen}
                aria-controls="runtime-options"
                autoComplete="off"
              />
              <UiButton className="runtime-combobox-toggle" type="button" aria-label="Show runtime options" onClick={() => setRuntimePickerOpen(open => !open)}>
                <ChevronDown size={16} />
              </UiButton>
              {runtimePickerOpen && runtimes.length > 0 && (
                <div className="runtime-options" id="runtime-options" role="listbox">
                  {runtimes.map(runtimeInfo => (
                    <UiButton
                      type="button"
                      role="option"
                      aria-selected={runtimeInfo.id === runtimeValue}
                      className={runtimeInfo.id === runtimeValue ? "is-selected" : ""}
                      key={runtimeInfo.id}
                      onClick={() => {
                        setRuntime(runtimeInfo.id);
                        setRuntimePickerOpen(false);
                      }}
                    >
                      <span>{runtimeLabel(runtimeInfo.id, runtimeInfo.name)}</span>
                      <code>{runtimeInfo.id}</code>
                    </UiButton>
                  ))}
                </div>
              )}
            </div>
          </div>
          <label className="field">
            <span>Model</span>
            <UiInput list="model-options" type="text" value={agentModel} onChange={event => setAgentModel(event.target.value)} placeholder="empty = use env var" />
            <datalist id="model-options">{modelsFor(runtime).map(model => <option value={model} key={model} />)}</datalist>
          </label>
          <label className="field field-checkbox">
            <UiInput type="checkbox" checked={agentShareHistory} onChange={event => setAgentShareHistory(event.target.checked)} />
            <span>Share runtime session history<small>Off by default. When on, this agent's turns appear in the runtime's <code>/resume</code> picker.</small></span>
          </label>
        </div>
        {!state.computers.length && <p className="form-error">Connect a computer before creating agents.</p>}
        {computer && !runtimes.length && <p className="form-error">No installed agent runtime was reported by this computer. You can still type a custom profile id; launch will fail later if the daemon cannot run it.</p>}
        {computer && runtimes.length > 0 && !runtimes.some(runtimeInfo => runtimeInfo.id === runtimeValue) && runtimeValue && <p className="char-count">Custom runtime id. Make sure the daemon can run it, usually via ITEAM_ACP_RUNTIMES or ITEAM_RUNTIME_PROFILES.</p>}
        {error && <p className="form-error">{error}</p>}
        <footer className="modal-actions">
          <UiButton className="btn btn-ghost" onClick={onClose}>Cancel</UiButton>
          <UiButton className="btn btn-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? "Creating..." : "Create agent"}</UiButton>
        </footer>
      </section>
    </UiModalHost>
  );
}

function preferredCreateRuntime(runtimes: RuntimeInfo[]): string {
  const installed = runtimes.filter(runtime => runtime.installed && runtime.id !== "mock");
  const preferredAcpIds = ["trae", "gemini", "hermes"];
  for (const id of preferredAcpIds) {
    if (installed.some(runtime => runtime.id === id)) return id;
  }
  return installed.find(runtime => runtime.id.includes("acp") || /\bACP\b/i.test(runtime.name))?.id || installed[0]?.id || "";
}

function runtimeLabel(runtime: string, fallback?: string): string {
  return ({ codex: "Codex CLI", claude: "Claude Code", gemini: "Gemini CLI", opencode: "OpenCode", trae: "Trae CLI (traecli)" } as Record<string, string>)[runtime] || fallback || runtime;
}

function defaultModel(_runtime: string): string {
  return "";
}

function modelsFor(runtime: string): string[] {
  if (runtime === "claude") return ["sonnet", "opus"];
  if (runtime === "gemini") return ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-3.1-flash-lite"];
  if (runtime === "trae") return ["Doubao-Seed-1.8", "MiniMax-M2.7", "GLM-5.1", "GLM-5", "DeepSeek-V4-Pro", "DeepSeek-V4-Flash", "Kimi-K2.6", "Kimi-K2.5", "GPT-5.5", "GPT-5.4", "GPT-5.2", "Qwen3.6-Plus", "Qwen3.5-Plus"];
  return ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"];
}
