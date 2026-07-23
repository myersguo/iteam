import React, { useState } from "react";
import { Trash2, X } from "lucide-react";
import type { Agent, Channel, Human } from "../types";
import { isProtectedChannel } from "../utils";
import { UiButton, UiInput, UiModalHost, UiSelect, UiTextArea } from "./ui";

export function CreateChannelModal({
  agents,
  onCreate,
  onClose
}: {
  agents: Agent[];
  onCreate: (body: { name: string; description?: string; defaultAgentId?: string | null }) => Promise<void> | void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [defaultAgentId, setDefaultAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const valid = !!name.trim();

  async function submit() {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({ name, description, defaultAgentId: defaultAgentId || null });
    } catch (err) {
      setError((err as Error).message || "Failed to create channel");
      setBusy(false);
    }
  }

  return (
    <UiModalHost onClose={onClose}>
      <section className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="create-channel-title">
        <UiButton className="modal-close" title="Close" onClick={onClose}><X /></UiButton>
        <p className="eyebrow">New channel</p>
        <h1 id="create-channel-title">Create a channel.</h1>
        <p className="modal-lede">Channels are real local records. Messages, tasks, and threads stay scoped to the selected channel.</p>
        {error && <p className="form-error">{error}</p>}
        <label className="field">
          <span>Name <em>required</em></span>
          <UiInput
            value={name}
            onChange={event => setName(event.target.value)}
            placeholder="e.g. planning"
            autoFocus
            onKeyDown={event => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <UiTextArea value={description} onChange={event => setDescription(event.target.value)} placeholder="Optional context for this channel..." />
        </label>
        <div className="field">
          <span>Default agent <small>optional — handles untagged messages</small></span>
          <UiSelect value={defaultAgentId} onChange={event => setDefaultAgentId(event.target.value)}>
            <option value="">— none —</option>
            {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} @{agent.handle}</option>)}
          </UiSelect>
        </div>
        <footer className="modal-actions">
          <UiButton className="btn btn-ghost" onClick={onClose}>Cancel</UiButton>
          <UiButton className="btn btn-primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "Creating..." : "Create channel"}
          </UiButton>
        </footer>
      </section>
    </UiModalHost>
  );
}

export function RenameChannelModal({
  channel,
  agents,
  onRename,
  onDelete,
  onClose
}: {
  channel: Channel;
  agents: Agent[];
  onRename: (channelId: string, body: { name?: string; description?: string; defaultAgentId?: string | null }) => Promise<void> | void;
  onDelete: (channel: Channel) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(channel.name);
  const [description, setDescription] = useState(channel.description || "");
  const [defaultAgentId, setDefaultAgentId] = useState(channel.defaultAgentId || "");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const valid = !!name.trim();
  const isDm = channel.kind === "dm";
  const isProtected = isProtectedChannel(channel);
  const canDelete = !isDm && !isProtected;

  async function submit() {
    if (!valid || busy || deleting) return;
    setBusy(true);
    setError("");
    try {
      await onRename(channel.id, {
        name,
        description,
        ...(isDm ? {} : { defaultAgentId: defaultAgentId || null })
      });
    } catch (err) {
      setError((err as Error).message || "Failed to rename channel");
      setBusy(false);
    }
  }

  async function remove() {
    if (busy || deleting || !canDelete) return;
    setDeleting(true);
    setError("");
    try {
      await onDelete(channel);
      setDeleting(false);
    } catch (err) {
      setError((err as Error).message || "Failed to delete channel");
      setDeleting(false);
    }
  }

  return (
    <UiModalHost onClose={onClose}>
      <section className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="rename-channel-title">
        {canDelete && (
          <UiButton
            className="modal-close modal-delete"
            title="Delete channel"
            aria-label="Delete channel"
            disabled={busy || deleting}
            onClick={() => void remove()}
          >
            <Trash2 size={17} />
          </UiButton>
        )}
        <UiButton className="modal-close" title="Close" disabled={busy || deleting} onClick={onClose}><X /></UiButton>
        <p className="eyebrow">Channel settings</p>
        <h1 id="rename-channel-title">{isProtected ? "Channel settings." : "Rename channel."}</h1>
        <p className="modal-lede">{isProtected ? "Configure the default channel. Name cannot be changed." : "Renaming updates the channel path and keeps existing messages, tasks, and threads attached."}</p>
        {error && <p className="form-error">{error}</p>}
        <label className="field">
          <span>Name <em>required</em></span>
          <UiInput
            value={name}
            onChange={event => setName(event.target.value)}
            autoFocus={!isProtected}
            disabled={isProtected}
            onKeyDown={event => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        <label className="field">
          <span>Description</span>
          <UiTextArea value={description} onChange={event => setDescription(event.target.value)} />
        </label>
        {!isDm && (
          <div className="field">
            <span>Default agent <small>optional — handles untagged messages</small></span>
            <UiSelect value={defaultAgentId} onChange={event => setDefaultAgentId(event.target.value)}>
              <option value="">— none —</option>
              {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} @{agent.handle}</option>)}
            </UiSelect>
          </div>
        )}
        <footer className="modal-actions">
          <UiButton className="btn btn-ghost" onClick={onClose} disabled={busy || deleting}>Cancel</UiButton>
          <UiButton className="btn btn-primary" disabled={!valid || busy || deleting} onClick={() => void submit()}>
            {busy ? "Saving..." : "Save channel"}
          </UiButton>
        </footer>
      </section>
    </UiModalHost>
  );
}

export function RenameHumanModal({
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
    <UiModalHost onClose={onClose}>
      <section className="modal modal-narrow" role="dialog" aria-modal="true" aria-labelledby="rename-human-title" onClick={event => event.stopPropagation()}>
        <UiButton className="modal-close" title="Close" onClick={onClose}><X /></UiButton>
        <p className="eyebrow">Human profile</p>
        <h1 id="rename-human-title">Change your name.</h1>
        <p className="modal-lede">This updates how your name appears in members, messages, and future conversations.</p>
        {error && <p className="form-error">{error}</p>}
        <label className="field">
          <span>Display name <em>required</em></span>
          <UiInput
            value={name}
            onChange={event => setName(event.target.value)}
            autoFocus
            onKeyDown={event => {
              if (event.key === "Enter") void submit();
            }}
          />
        </label>
        <footer className="modal-actions">
          <UiButton className="btn btn-ghost" onClick={onClose}>Cancel</UiButton>
          <UiButton className="btn btn-primary" disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? "Saving..." : "Save name"}
          </UiButton>
        </footer>
      </section>
    </UiModalHost>
  );
}
