import React, { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { Message as ArcoMessage } from "@arco-design/web-react";
import type { Space } from "../types";
import { UiButton, UiInput, UiModalHost, UiSelect, UiTextArea } from "./ui";

const SPACE_NAME_PATTERN = /^[A-Za-z0-9 _-]{1,40}$/;
const SPACE_PAGE_SIZE = 8;

export interface SpaceSwitcherProps {
  spaces: Space[];
  currentSpaceId: string;
  onSelect: (spaceId: string) => void;
  onCreated: (space: Space) => void;
  createSpace: (name: string, description: string) => Promise<Space>;
  deleteSpace: (space: Space) => Promise<void>;
}

export function SpaceSwitcher({
  spaces,
  currentSpaceId,
  onSelect,
  onCreated,
  createSpace,
  deleteSpace
}: SpaceSwitcherProps) {
  const [manageOpen, setManageOpen] = useState(false);
  const items = spaces.length ? spaces : [{ id: "space_default", name: "Default", slug: "default" }];
  const currentSpace = items.find(space => space.id === currentSpaceId) || items[0];

  function handleSelect(spaceId: string) {
    if (spaceId === "__manage__") {
      setManageOpen(true);
      return;
    }
    if (spaceId !== "__divider__") onSelect(spaceId);
  }

  async function handleCreate(name: string, description: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const space = await createSpace(trimmed, description.trim());
      onCreated(space);
    } catch (error) {
      ArcoMessage.error(`Failed to create space: ${(error as Error).message}`);
      throw error;
    }
  }

  async function handleDelete(space: Space) {
    try {
      await deleteSpace(space);
    } catch (error) {
      ArcoMessage.error(`Failed to delete space: ${(error as Error).message}`);
      throw error;
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
            <option value="__manage__">Manage spaces…</option>
          </UiSelect>
          <ChevronDown size={14} className="space-switcher-caret" aria-hidden />
        </div>
      </div>
      {manageOpen && (
        <ManageSpacesModal
          spaces={items}
          currentSpaceId={currentSpace?.id || "space_default"}
          onCancel={() => setManageOpen(false)}
          onCreate={handleCreate}
          onDelete={handleDelete}
        />
      )}
    </>
  );
}

function ManageSpacesModal({
  spaces,
  currentSpaceId,
  onCancel,
  onCreate,
  onDelete
}: {
  spaces: Space[];
  currentSpaceId: string;
  onCancel: () => void;
  onCreate: (name: string, description: string) => void | Promise<void>;
  onDelete: (space: Space) => void | Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteConfirmations, setDeleteConfirmations] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameValid = SPACE_NAME_PATTERN.test(name.trim());
  const totalPages = Math.max(1, Math.ceil(spaces.length / SPACE_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * SPACE_PAGE_SIZE;
  const visibleSpaces = spaces.slice(pageStart, pageStart + SPACE_PAGE_SIZE);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

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
      await onCreate(name, description);
      setName("");
      setDescription("");
      setPage(Math.max(1, Math.ceil((spaces.length + 1) / SPACE_PAGE_SIZE)));
    } catch (err) {
      setError((err as Error).message || "Failed to create space");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(space: Space) {
    const required = space.name || space.slug || space.id;
    const confirmed = (deleteConfirmations[space.id] || "").trim() === required;
    if (!confirmed || deletingId) return;
    setDeletingId(space.id);
    setError(null);
    try {
      await onDelete(space);
      setDeleteConfirmations(current => {
        const next = { ...current };
        delete next[space.id];
        return next;
      });
    } catch (err) {
      setError((err as Error).message || "Failed to delete space");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <UiModalHost onClose={onCancel}>
      <form className="modal" onSubmit={handleSubmit}>
        <UiButton type="button" className="modal-close" onClick={onCancel} aria-label="Close">
          <X size={16} />
        </UiButton>
        <p className="eyebrow">Workspace · Space</p>
        <h1>Manage spaces</h1>
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
        <section className="space-manager-list" aria-label="Existing spaces">
          <div className="space-manager-list-head">
            <p className="eyebrow">Existing spaces</p>
            {totalPages > 1 && (
              <div className="space-manager-pager" aria-label="Space list pagination">
                <UiButton
                  type="button"
                  className="btn btn-ghost"
                  disabled={currentPage <= 1}
                  onClick={() => setPage(value => Math.max(1, value - 1))}
                >
                  Prev
                </UiButton>
                <span>{pageStart + 1}-{Math.min(pageStart + SPACE_PAGE_SIZE, spaces.length)} / {spaces.length}</span>
                <UiButton
                  type="button"
                  className="btn btn-ghost"
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage(value => Math.min(totalPages, value + 1))}
                >
                  Next
                </UiButton>
              </div>
            )}
          </div>
          {visibleSpaces.map(space => {
            const required = space.name || space.slug || space.id;
            const canDelete = space.id !== "space_default" && spaces.length > 1;
            const confirmation = deleteConfirmations[space.id] || "";
            const confirmed = confirmation.trim() === required;
            const isCurrent = space.id === currentSpaceId;
            return (
              <div className="space-manager-row" key={space.id}>
                <div>
                  <strong>{space.name}</strong>
                  <small>{isCurrent ? "Current space" : space.description || space.slug || space.id}</small>
                </div>
                {canDelete ? (
                  <div className="space-manager-delete">
                    <UiInput
                      value={confirmation}
                      placeholder={`Type ${required}`}
                      onChange={event => setDeleteConfirmations(current => ({ ...current, [space.id]: event.target.value }))}
                      aria-label={`Confirm deletion for ${space.name}`}
                    />
                    <UiButton
                      type="button"
                      className="btn btn-danger"
                      disabled={!confirmed || deletingId === space.id}
                      onClick={() => void handleDelete(space)}
                    >
                      {deletingId === space.id ? "Deleting…" : "Delete"}
                    </UiButton>
                  </div>
                ) : (
                  <small className="space-manager-note">Protected</small>
                )}
              </div>
            );
          })}
        </section>
      </form>
    </UiModalHost>
  );
}
