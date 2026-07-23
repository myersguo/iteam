import type { Message, Task } from "../../types";

export function taskStatuses() {
  return [
    { id: "todo", label: "Todo" },
    { id: "in_progress", label: "In Progress" },
    { id: "in_review", label: "In Review" },
    { id: "done", label: "Done" },
    { id: "closed", label: "Closed" }
  ];
}

export function taskToRootMessage(task: Task): Message {
  return {
    id: task.messageId,
    target: task.target,
    authorId: task.createdBy || "human-local",
    text: task.title,
    type: "task",
    createdAt: task.createdAt || task.updatedAt || new Date().toISOString(),
    threadId: null,
    taskId: task.id,
    replyCount: task.replyCount
  };
}
