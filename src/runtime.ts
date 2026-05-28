import { nowIso } from "./lib.js";
import { ensureAgentWorkspace } from "./workspace.js";
import type { IStore } from "./store/types.js";
import type { Agent, Message, Task } from "./types.js";

interface WorkerEntry {
  startedAt: string;
  busy: boolean;
}

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
    ensureAgentWorkspace(this.store, agent);
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
