import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Message as ArcoMessage } from "@arco-design/web-react";
import type { Space } from "../types";
import { UiButton, UiInput, UiModalHost, UiSelect, UiTextArea } from "./ui";

const SPACE_NAME_PATTERN = /^[A-Za-z0-9 _-]{1,40}$/;

export interface SpaceSwitcherProps {
  spaces: Space[];
  currentSpaceId: string;
  onSelect: (spaceId: string) => void;
  onCreated: (space: Space) => void;
  createSpace: (name: string, description: string) => Promise<Space>;
}

export function SpaceSwitcher({
  spaces,
  currentSpaceId,
  onSelect,
  onCreated,
  createSpace
}: SpaceSwitcherProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const items = spaces.length ? spaces : [{ id: "space_default", name: "Default", slug: "default" }];
  const currentSpace = items.find(space => space.id === currentSpaceId) || items[0];

  function handleSelect(spaceId: string) {
    if (spaceId === "__new__") {
      setCreateOpen(true);
      return;
    }
    if (spaceId !== "__divider__") onSelect(spaceId);
  }

  async function handleCreate(name: string, description: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const space = await createSpace(trimmed, description.trim());
      setCreateOpen(false);
      onCreated(space);
    } catch (error) {
      ArcoMessage.error(`Failed to create space: ${(error as Error).message}`);
    }
  }

  return (
    <>
      <div className="space-switcher">
        <span className="eyebrow space-switcher-label">Space</span>
        <div className="space-switcher-select">
          <UiSelect
            id="iteam-space-select"
            value={currentSpace?.id || "space_default"}
            onChange={event => handleSelect(event.target.value)}
            aria-label="Active space"
            title={currentSpace?.description || currentSpace?.name}
          >
            {items.map(space => (
              <option key={space.id} value={space.id}>{space.name}</option>
            ))}
            <option disabled value="__divider__">──────────</option>
            <option value="__new__">+ New space…</option>
          </UiSelect>
          <ChevronDown size={14} className="space-switcher-caret" aria-hidden />
        </div>
      </div>
      {createOpen && (
        <CreateSpaceModal
          onCancel={() => setCreateOpen(false)}
          onSubmit={handleCreate}
        />
      )}
    </>
  );
}

function CreateSpaceModal({
  onCancel,
  onSubmit
}: {
  onCancel: () => void;
  onSubmit: (name: string, description: string) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameValid = SPACE_NAME_PATTERN.test(name.trim());

  useEffect(() => {
    inputRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!nameValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(name, description);
    } catch (err) {
      setError((err as Error).message || "Failed to create space");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <UiModalHost onClose={onCancel}>
      <form className="modal" onSubmit={handleSubmit}>
        <UiButton type="button" className="modal-close" onClick={onCancel} aria-label="Close">
          <X size={16} />
        </UiButton>
        <p className="eyebrow">Workspace · Space</p>
        <h1>Create a new space</h1>
        <p className="modal-lede">
          Spaces isolate channels, agents, computers, schedules, and bot bindings so different
          teams or businesses can share one iTeam without leaking context.
        </p>
        {error && <p className="form-error">{error}</p>}
        <label className="field">
          <span>Name<em>required</em></span>
          <UiInput
            ref={inputRef}
            value={name}
            placeholder="e.g. growth, platform, fizzo"
            onChange={event => setName(event.target.value)}
            maxLength={40}
            aria-invalid={name.length > 0 && !nameValid}
          />
          <small className="field-hint">
            ASCII letters, digits, space, `_` or `-` (max 40). Chinese and other unicode
            aren't allowed so the URL stays clean.
          </small>
        </label>
        <label className="field">
          <span>Description<small>optional</small></span>
          <UiTextArea
            value={description}
            placeholder="What lives in this space?"
            onChange={event => setDescription(event.target.value)}
            maxLength={240}
          />
        </label>
        <div className="modal-actions">
          <UiButton type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </UiButton>
          <UiButton type="submit" className="btn btn-primary" disabled={!nameValid || submitting}>
            {submitting ? "Creating…" : "Create space"}
          </UiButton>
        </div>
      </form>
    </UiModalHost>
  );
}
