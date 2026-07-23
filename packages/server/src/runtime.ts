import { nowIso } from "@iteam/shared";
import type { Agent, Message, Task } from "@iteam/shared";
import type { IStore } from "./store/index.js";

interface WorkerEntry {
  startedAt: string;
  busy: boolean;
}

/**
 * Vestigial in-server runtime bookkeeping. The real agent runtime runs in the
 * client daemon (ACP/claude/codex drivers); the server only tracks lightweight
 * lifecycle state and emits `runtime:*` events. `start`/`stop` are retained for
 * embedded/test scenarios and are not on the daemon's hot path (agents are
 * launched via the computer daemon, not here), so this no longer depends on the
 * client-side workspace preparation.
 */
export class RuntimeManager {
  store: IStore;
  workers: Map<string, WorkerEntry>;

  constructor(store: IStore) {
    this.store = store;
    this.workers = new Map();
  }

  start(agentId: string): Agent {
    const state = this.store.snapshot();
    const agent = state.agents.find(a => a.id === agentId);
    if (!agent) throw new Error(`agent not found: ${agentId}`);
    this.store.mutate(s => {
      const target = s.agents.find(a => a.id === agentId);
      if (!target) return;
      target.status = "idle";
      target.lastStartedAt = nowIso();
    });
    this.workers.set(agentId, { startedAt: nowIso(), busy: false });
    this.store.emit("agent:started", { agentId });
    const updated = this.store.snapshot().agents.find(a => a.id === agentId);
    if (!updated) throw new Error(`agent not found after start: ${agentId}`);
    return updated;
  }

  stop(agentId: string): { ok: true } {
    this.workers.delete(agentId);
    this.store.mutate(s => {
      const agent = s.agents.find(a => a.id === agentId);
      if (agent) agent.status = "offline";
    });
    this.store.emit("agent:stopped", { agentId });
    return { ok: true };
  }

  onMessage(message: Message): void {
    this.store.emit("runtime:delivery_pending", { messageId: message.id });
  }

  onTask(task: Task): void {
    this.store.emit("runtime:delivery_pending", { taskId: task.id });
  }
}
