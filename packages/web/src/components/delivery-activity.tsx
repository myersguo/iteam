import { CircleGauge } from "lucide-react";
import type { Agent, Delivery } from "../types";
import { UiButton } from "./ui";

export interface DeliveryActivity {
  active: number;
  queued: number;
  running: number;
  dispatching: number;
  oldestAt?: string;
  maxQueuePosition?: number;
}

export function deliveryPhase(delivery: Delivery): "queued" | "running" | "dispatching" | null {
  if (delivery.status !== "pending" && delivery.status !== "delivering") return null;
  const lifecycle = delivery.lifecycle || [];
  for (let index = lifecycle.length - 1; index >= 0; index -= 1) {
    const intent = lifecycle[index].intent;
    if (intent === "delivery.running" || intent === "delivery.progress") return "running";
    if (intent === "delivery.queued") return "queued";
  }
  return "dispatching";
}

export function summarizeDeliveryActivity(deliveries: Delivery[]): DeliveryActivity {
  const activeDeliveries = deliveries.filter(delivery => deliveryPhase(delivery));
  const activity: DeliveryActivity = {
    active: activeDeliveries.length,
    queued: 0,
    running: 0,
    dispatching: 0
  };
  for (const delivery of activeDeliveries) {
    const phase = deliveryPhase(delivery);
    if (phase) activity[phase] += 1;
    const runtimeRecord = [...(delivery.lifecycle || [])]
      .reverse()
      .find(record => record.intent === "delivery.queued" || record.intent === "delivery.running");
    const queuePosition = Number(runtimeRecord?.details?.queuePosition);
    if (Number.isFinite(queuePosition)) {
      activity.maxQueuePosition = Math.max(activity.maxQueuePosition || 0, queuePosition);
    }
  }
  activity.oldestAt = activeDeliveries
    .map(delivery => delivery.createdAt)
    .sort()[0];
  return activity;
}

export function deliveryActivityForTarget(deliveries: Delivery[], target: string): DeliveryActivity {
  return summarizeDeliveryActivity(deliveries.filter(delivery => delivery.target === target));
}

export function deliveryActivityForAgent(deliveries: Delivery[], agentId: string): DeliveryActivity {
  return summarizeDeliveryActivity(deliveries.filter(delivery => delivery.agentId === agentId));
}

export function DeliveryCountBadge({ activity }: { activity: DeliveryActivity }) {
  const label = activity.queued > 0
    ? `${activity.queued} queued`
    : activity.running > 0
      ? `${activity.running} running`
      : `${activity.dispatching} dispatching`;
  return (
    <span className={`delivery-count ${activity.queued > 0 ? "is-queued" : "is-running"}`} title={label}>
      {activity.active}
    </span>
  );
}

export function DeliveryActivityBar({ activity }: { activity: DeliveryActivity }) {
  if (!activity.active) return null;
  const waiting = activity.oldestAt ? compactElapsed(Date.now() - new Date(activity.oldestAt).getTime()) : null;
  return (
    <div className="delivery-activity" aria-live="polite">
      <CircleGauge size={16} aria-hidden />
      <strong>Agent activity</strong>
      {!!activity.running && <span className="delivery-phase is-running">{activity.running} running</span>}
      {!!activity.queued && (
        <span className="delivery-phase is-queued">
          {activity.queued} queued{activity.maxQueuePosition ? ` · up to #${activity.maxQueuePosition}` : ""}
        </span>
      )}
      {!!activity.dispatching && <span className="delivery-phase">{activity.dispatching} dispatching</span>}
      {waiting && <small>oldest {waiting}</small>}
    </div>
  );
}

function compactElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
