import React, { useMemo, useRef, useState } from "react";
import { ExternalLink, Send, X } from "lucide-react";
import type { AppState, Message, Task } from "../types";
import { MessageRow } from "./message-list";
import {
  MentionMenu,
  collectMentions,
  findMentionMatch,
  getMentionMembers,
  isMentionNavigationKey,
  type MentionMatch,
  type MentionMember,
  type MentionReference
} from "./mentions";
import { UiButton, UiTextArea } from "./ui";

export interface ThreadPanelProps {
  state: AppState;
  root: Message;
  messages: Message[];
  onClose: () => void;
  onViewChannel: () => void;
  onSend: (target: string, text: string, mentions: MentionReference[]) => void | Promise<void>;
}

export function ThreadPanel({
  state,
  root,
  messages,
  onClose,
  onViewChannel,
  onSend
}: ThreadPanelProps) {
  const [text, setText] = useState("");
  const mentionMembers = useMemo(() => getMentionMembers(state, root.target), [state, root.target]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionOptions = useMemo(() => {
    if (!mentionMatch) return [];
    const query = mentionMatch.query.toLowerCase();
    return mentionMembers
      .filter(member => member.handle.toLowerCase().includes(query) || member.name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [mentionMatch, mentionMembers]);
  const threadTarget = `${root.target}:${root.id}`;
  const rootTask = state.tasks.find(task => task.messageId === root.id || task.id === root.taskId) as Task | undefined;

  function refreshMention(target: HTMLTextAreaElement | null = textareaRef.current) {
    if (!target) return;
    setMentionMatch(findMentionMatch(target.value, target.selectionStart || 0));
    setMentionIndex(0);
  }

  function insertMention(member: MentionMember) {
    if (!mentionMatch) return;
    const before = text.slice(0, mentionMatch.start);
    const after = text.slice(mentionMatch.end);
    const next = `${before}@${member.handle} ${after}`;
    const cursor = before.length + member.handle.length + 2;
    setText(next);
    setMentionMatch(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionMatch && mentionOptions.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex(index => (index + 1) % mentionOptions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(index => (index - 1 + mentionOptions.length) % mentionOptions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        insertMention(mentionOptions[mentionIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionMatch(null);
        return;
      }
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void send();
  }

  async function send() {
    if (!text.trim()) return;
    await onSend(threadTarget, text, collectMentions(text, mentionMembers));
    setText("");
  }

  return (
    <aside className="thread-panel">
      <header>
        <div>
          <p className="eyebrow">Thread</p>
          <strong>{root.target}</strong>
        </div>
        <UiButton className="btn btn-ghost" onClick={onViewChannel}>
          <ExternalLink size={14} /> View in channel
        </UiButton>
        <UiButton className="icon-btn" title="Close" onClick={onClose}>
          <X size={16} />
        </UiButton>
      </header>
      <div className="thread-body">
        <MessageRow message={root} state={state} />
        {rootTask && (
          <div className="thread-task-meta">
            <span className={`status-pip ${rootTask.status}`} />
            Task #{rootTask.number} · {rootTask.status}
          </div>
        )}
        <div className="thread-divider">
          {messages.length} {messages.length === 1 ? "reply" : "replies"}
        </div>
        {messages.map(message => <MessageRow key={message.id} message={message} state={state} />)}
      </div>
      <div className="thread-composer">
        {mentionMatch && <MentionMenu options={mentionOptions} activeIndex={mentionIndex} onPick={insertMention} />}
        <UiTextArea
          ref={textareaRef}
          value={text}
          onChange={event => {
            setText(event.target.value);
            refreshMention(event.target);
          }}
          onClick={event => refreshMention(event.target as HTMLTextAreaElement)}
          onKeyUp={event => {
            if (mentionMatch && isMentionNavigationKey(event.key)) return;
            refreshMention(event.target as HTMLTextAreaElement);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Reply in thread"
        />
        <UiButton className="btn btn-primary" disabled={!text.trim()} onClick={() => void send()}>
          <Send size={15} />
        </UiButton>
      </div>
    </aside>
  );
}
