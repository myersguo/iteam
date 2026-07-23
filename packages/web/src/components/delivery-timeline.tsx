import React, { useState } from "react";
import { createPortal } from "react-dom";
import { Drawer as ArcoDrawer } from "@arco-design/web-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CircleGauge, X } from "lucide-react";
import type { Agent, Delivery, DeliveryArtifact, DeliveryEvent } from "../types";
import { UiButton } from "./ui";

export function DeliveryTimeline({
  events,
  deliveries,
  artifacts,
  agents
}: {
  events: DeliveryEvent[];
  deliveries: Delivery[];
  artifacts: DeliveryArtifact[];
  agents: Agent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<DeliveryEvent | null>(null);
  const ordered = [...events].sort((left, right) =>
    left.sequence - right.sequence ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
  const timelineEvents = ordered.filter(event => event.kind !== "message_delta");
  const grouped = groupDeliveryEvents(appendDeliveryOutcomeEvents(timelineEvents, deliveries));
  const visible = expanded ? grouped : grouped.slice(-4);
  const draft = deliveryDraftText(ordered);
  const status = deliveryTimelineStatus(deliveries);

  return (
    <div className="delivery-timeline">
      <UiButton
        className={`delivery-timeline-head is-${status.tone}`}
        onClick={() => setExpanded(value => !value)}
      >
        <CircleGauge size={14} />
        <span>{status.label}</span>
        <small>{ordered.length} events</small>
      </UiButton>
      <div className="delivery-event-list">
        {visible.map(event => (
          <DeliveryTimelineItem
            key={event.id}
            event={event}
            artifacts={artifacts.filter(artifact => artifact.eventId === event.id)}
            agent={agents.find(agent => agent.id === event.agentId)}
            onOpen={() => setSelectedEvent(event)}
          />
        ))}
      </div>
      {draft && (
        <div className="delivery-draft">
          <small>Draft reply</small>
          <p>{draft}</p>
        </div>
      )}
      {selectedEvent && (
        <DeliveryEventDrawer
          event={selectedEvent}
          artifacts={artifacts.filter(artifact => artifact.eventId === selectedEvent.id)}
          agent={agents.find(agent => agent.id === selectedEvent.agentId)}
          onClose={() => setSelectedEvent(null)}
        />
      )}
    </div>
  );
}

function DeliveryTimelineItem({
  event,
  artifacts,
  agent,
  onOpen
}: {
  event: DeliveryEvent;
  artifacts: DeliveryArtifact[];
  agent?: Agent;
  onOpen: () => void;
}) {
  return (
    <UiButton
      type="button"
      className={`delivery-event is-${event.kind} ${artifacts.length ? "has-artifacts" : ""}`}
      onClick={onOpen}
    >
      <span className="delivery-event-dot" />
      <div>
        <strong>{deliveryEventTitle(event)}</strong>
        {event.text && event.kind !== "message_delta" && <p>{event.text}</p>}
        {artifacts.length > 0 && (
          <em>{artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}</em>
        )}
        <small>
          {agent?.name || event.agentId}
          {" · "}
          {new Date(event.createdAt).toLocaleTimeString()}
        </small>
      </div>
    </UiButton>
  );
}

function DeliveryEventDrawer({
  event,
  artifacts,
  agent,
  onClose
}: {
  event: DeliveryEvent;
  artifacts: DeliveryArtifact[];
  agent?: Agent;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState<string>(artifacts[0]?.id || "raw");
  const active = artifacts.find(artifact => artifact.id === activeId) || artifacts[0] || null;

  return createPortal(
    <ArcoDrawer
      visible
      placement="right"
      width={520}
      footer={null}
      closable={false}
      maskClosable
      onCancel={onClose}
      className="artifact-drawer"
      title={null}
    >
      <header>
        <div>
          <p className="eyebrow">Delivery event</p>
          <h2>{deliveryEventTitle(event)}</h2>
          <small>{agent?.name || event.agentId} · {new Date(event.createdAt).toLocaleString()}</small>
        </div>
        <UiButton className="icon-btn" onClick={onClose} title="Close">
          <X size={16} />
        </UiButton>
      </header>
      <div className="artifact-drawer-body">
        <section className="artifact-meta">
          <dl>
            <div><dt>Kind</dt><dd>{event.kind}</dd></div>
            <div><dt>Status</dt><dd>{event.status || "—"}</dd></div>
            <div><dt>Tool</dt><dd>{event.toolName || "—"}</dd></div>
            <div><dt>Call id</dt><dd>{event.toolCallId || "—"}</dd></div>
          </dl>
          {event.text && <p>{event.text}</p>}
        </section>
        {artifacts.length > 0 && (
          <div className="artifact-tabs">
            {artifacts.map(artifact => (
              <UiButton
                key={artifact.id}
                type="button"
                className={artifact.id === activeId ? "is-active" : ""}
                onClick={() => setActiveId(artifact.id)}
              >
                {artifactLabel(artifact)}
              </UiButton>
            ))}
            <UiButton
              type="button"
              className={activeId === "raw" ? "is-active" : ""}
              onClick={() => setActiveId("raw")}
            >
              Raw JSON
            </UiButton>
          </div>
        )}
        {active && activeId !== "raw" ? (
          <ArtifactPreview artifact={active} />
        ) : (
          <ArtifactCode title="Raw event payload" content={formatUnknown(event.payload ?? event)} />
        )}
      </div>
    </ArcoDrawer>,
    document.body
  );
}

function ArtifactPreview({ artifact }: { artifact: DeliveryArtifact }) {
  const content = artifact.content || "";
  return (
    <section className="artifact-preview">
      <header>
        <div>
          <h3>{artifact.title}</h3>
          <small>{artifact.kind} · {formatBytes(artifact.size)} · {artifact.mime}</small>
        </div>
        {artifact.relativePath && <code>{artifact.relativePath}</code>}
      </header>
      {artifact.summary && <p>{artifact.summary}</p>}
      {artifact.mime.includes("markdown") ? (
        <div className="artifact-markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
      ) : (
        <ArtifactCode title={artifact.title} content={content || formatUnknown(artifact.metadata)} />
      )}
    </section>
  );
}

function ArtifactCode({ title, content }: { title: string; content: string }) {
  return (
    <section className="artifact-code" aria-label={title}>
      <pre>{content || "(empty)"}</pre>
    </section>
  );
}

function artifactLabel(artifact: DeliveryArtifact): string {
  if (artifact.kind === "tool_input") return "Inputs";
  if (artifact.kind === "tool_output") return "Outputs";
  if (artifact.kind === "command_stdout") return "stdout";
  if (artifact.kind === "command_stderr") return "stderr";
  if (artifact.kind === "file_diff") return "Diff";
  if (artifact.kind === "file_snapshot") return "File";
  return artifact.kind;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value ?? "");
  }
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function deliveryTimelineStatus(deliveries: Delivery[]): {
  label: string;
  tone: "running" | "completed" | "failed" | "cancelled";
} {
  if (deliveries.some(delivery => delivery.status === "delivering" || delivery.status === "pending")) {
    return { label: "Working", tone: "running" };
  }
  if (deliveries.some(delivery => delivery.status === "failed")) {
    return { label: "Failed", tone: "failed" };
  }
  if (deliveries.some(delivery => delivery.status === "cancelled")) {
    return { label: "Cancelled", tone: "cancelled" };
  }
  if (deliveries.length > 0 && deliveries.every(delivery => delivery.status === "done")) {
    return { label: "Completed", tone: "completed" };
  }
  return { label: "Working", tone: "running" };
}

function deliveryEventTitle(event: DeliveryEvent): string {
  if (event.title) return event.title;
  if (event.kind === "tool_call") return event.toolName ? `Using ${event.toolName}` : "Tool call";
  if (event.kind === "tool_result") return event.status === "failed" ? "Tool failed" : "Tool completed";
  if (event.kind === "message_delta") return "Writing reply";
  if (event.kind === "thinking") return "Thinking";
  if (event.kind === "plan") return "Plan updated";
  if (event.kind === "queued") return "Queued";
  if (event.kind === "running") return "Runtime started";
  return event.kind;
}

function appendDeliveryOutcomeEvents(events: DeliveryEvent[], deliveries: Delivery[]): DeliveryEvent[] {
  if (deliveries.length === 0) return events;
  const output = [...events];
  let syntheticOffset = 1;
  const maxSequence = Math.max(0, ...events.map(event => Number(event.sequence) || 0));
  for (const delivery of deliveries) {
    if (!["done", "failed", "cancelled"].includes(delivery.status)) continue;
    const hasOutcome = output.some(event =>
      event.deliveryId === delivery.id &&
      (
        (delivery.status === "done" && event.kind === "completed") ||
        (delivery.status === "failed" && event.kind === "error" && event.status === "failed") ||
        (delivery.status === "cancelled" && event.kind === "cancelled")
      )
    );
    if (hasOutcome) continue;
    output.push({
      id: `synthetic:${delivery.id}:${delivery.status}`,
      deliveryId: delivery.id,
      agentId: delivery.agentId,
      target: delivery.target,
      kind: delivery.status === "done" ? "completed" : delivery.status === "failed" ? "error" : "cancelled",
      title: delivery.status === "done" ? "Completed" : delivery.status === "failed" ? "Delivery failed" : "Cancelled",
      text: delivery.status === "failed" ? delivery.error || null : null,
      status: delivery.status,
      sequence: maxSequence + syntheticOffset++,
      createdAt: delivery.updatedAt,
      payload: { synthetic: true }
    });
  }
  return output.sort((left, right) =>
    left.sequence - right.sequence ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function groupDeliveryEvents(events: DeliveryEvent[]): DeliveryEvent[] {
  const grouped: DeliveryEvent[] = [];
  for (const event of events) {
    const previous = grouped[grouped.length - 1];
    if (
      previous &&
      event.kind === "thinking" &&
      previous.kind === event.kind &&
      previous.deliveryId === event.deliveryId
    ) {
      previous.text = mergeStreamText(previous.text || "", event.text || "");
      previous.createdAt = event.createdAt;
      previous.sequence = event.sequence;
      previous.id = event.id;
      continue;
    }
    grouped.push({ ...event });
  }
  return grouped;
}

function deliveryDraftText(events: DeliveryEvent[]): string {
  const chunks = events
    .filter(event => event.kind === "message_delta" && event.text)
    .map(event => String(event.text));
  return chunks
    .reduce((text, chunk) => mergeStreamText(text, chunk || ""), "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
}

function mergeStreamText(existing: string, next: string): string {
  if (!existing) return next;
  if (!next) return existing;
  const previousChar = existing[existing.length - 1];
  const nextChar = next[0];
  if (/\s/.test(previousChar) || /\s/.test(nextChar)) return existing + next;
  if (/^[.,;:!?，。；：！？）】}"']/.test(nextChar)) return existing + next;
  if (/[（【{"']$/.test(previousChar)) return existing + next;
  if (/[\u4e00-\u9fff]/.test(previousChar) || /[\u4e00-\u9fff]/.test(nextChar)) return existing + next;
  return `${existing} ${next}`;
}
