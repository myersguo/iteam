import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Spin as ArcoSpin } from "@arco-design/web-react";
import { Kanban, MessageSquare, Send } from "lucide-react";
import type { AppState, Message } from "../types";
import { DeliveryActivityBar, deliveryActivityForTarget } from "./delivery-activity";
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
import { Topbar } from "./topbar";
import { UiButton, UiInput, UiTextArea, InlineEmpty } from "./ui";

export interface ChatViewProps {
  state: AppState;
  channel: string;
  messages: Message[];
  message: string;
  setMessage: (message: string) => void;
  asTask: boolean;
  setAsTask: (asTask: boolean) => void;
  sendMessage: (mentions?: MentionReference[]) => void;
  tab: "chat" | "tasks";
  setTab: (tab: "chat" | "tasks") => void;
  fetchOlderMessages: (channel: string, before?: string) => Promise<Message[]>;
  formatTitle: (state: AppState, channel: string) => string;
  resolveSubtitle: (state: AppState, channel: string) => string;
  getMentionMembers?: (state: AppState, channel?: string) => MentionMember[];
  collectMentions?: (text: string, members: MentionMember[]) => ReturnType<typeof collectMentions>;
  renderMessage: (message: Message) => React.ReactNode;
  tasksView: React.ReactNode;
}

export function ChatView({
  state,
  channel,
  messages,
  message,
  setMessage,
  asTask,
  setAsTask,
  sendMessage,
  tab,
  setTab,
  fetchOlderMessages,
  formatTitle,
  resolveSubtitle,
  getMentionMembers: resolveMentionMembers = getMentionMembers,
  collectMentions: resolveMentions = collectMentions,
  renderMessage,
  tasksView
}: ChatViewProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [olderMessages, setOlderMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const oldestIdRef = useRef<string | null>(null);
  const mentionMembers = useMemo(() => resolveMentionMembers(state, channel), [resolveMentionMembers, state, channel]);
  const deliveryActivity = useMemo(
    () => deliveryActivityForTarget(state.deliveries, channel),
    [state.deliveries, channel]
  );
  const mentionOptions = useMemo(() => {
    if (!mentionMatch) return [];
    const query = mentionMatch.query.toLowerCase();
    return mentionMembers
      .filter(member =>
        member.handle.toLowerCase().includes(query) || member.name.toLowerCase().includes(query)
      )
      .slice(0, 8);
  }, [mentionMatch, mentionMembers]);

  useEffect(() => {
    setOlderMessages([]);
    setHasMore(true);
    oldestIdRef.current = null;
  }, [channel]);

  const previousScrollHeightRef = useRef(0);
  const previousScrollTopRef = useRef(0);

  async function loadOlder() {
    if (!hasMore || loadingOlder) return;
    const cursor = oldestIdRef.current || (messages.length > 0 ? messages[0].id : null);
    if (!cursor) {
      setHasMore(false);
      return;
    }
    setLoadingOlder(true);
    if (listRef.current) {
      previousScrollHeightRef.current = listRef.current.scrollHeight;
      previousScrollTopRef.current = listRef.current.scrollTop;
    }
    try {
      const older = await fetchOlderMessages(channel, cursor);
      if (older.length === 0) {
        setHasMore(false);
      } else {
        oldestIdRef.current = older[0].id;
        setOlderMessages(previous => {
          const existing = new Set(previous.map(item => item.id));
          const unique = older.filter(item => !existing.has(item.id));
          return [...unique, ...previous];
        });
      }
    } catch {
      // A transient pagination failure should not block the composer.
    } finally {
      setLoadingOlder(false);
    }
  }

  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  const topObserverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = topObserverRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) loadOlderRef.current();
      },
      { root: listRef.current, rootMargin: "100px 0px 0px 0px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [tab]);

  const allMessages = useMemo(() => {
    const existing = new Set(messages.map(item => item.id));
    const uniqueOlder = olderMessages.filter(item => !existing.has(item.id));
    return [...uniqueOlder, ...messages];
  }, [olderMessages, messages]);

  useLayoutEffect(() => {
    if (listRef.current && previousScrollHeightRef.current > 0) {
      const heightDifference = listRef.current.scrollHeight - previousScrollHeightRef.current;
      if (heightDifference > 0) {
        listRef.current.scrollTop = previousScrollTopRef.current + heightDifference;
      }
      previousScrollHeightRef.current = 0;
    }
  }, [allMessages]);

  function refreshMention(target: HTMLTextAreaElement | null = textareaRef.current) {
    if (!target) return;
    setMentionMatch(findMentionMatch(target.value, target.selectionStart || 0));
    setMentionIndex(0);
  }

  function insertMention(member: MentionMember) {
    if (!mentionMatch) return;
    const before = message.slice(0, mentionMatch.start);
    const after = message.slice(mentionMatch.end);
    const next = `${before}@${member.handle} ${after}`;
    const cursor = before.length + member.handle.length + 2;
    setMessage(next);
    setMentionMatch(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function handleComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
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
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      sendMessage(resolveMentions(message, mentionMembers));
    }
  }

  const handleSend = () => sendMessage(resolveMentions(message, mentionMembers));

  return (
    <section className="pane chat-pane" ref={listRef}>
      <Topbar
        eyebrow={channel.startsWith("dm:") ? "Direct message" : "Channel"}
        title={formatTitle(state, channel)}
        subtitle={resolveSubtitle(state, channel)}
        extra={<DeliveryActivityBar activity={deliveryActivity} />}
      />
      <div className="pane-tabs">
        <UiButton className={tab === "chat" ? "is-active" : ""} onClick={() => setTab("chat")}>
          <MessageSquare size={14} /> Chat
        </UiButton>
        <UiButton className={tab === "tasks" ? "is-active" : ""} onClick={() => setTab("tasks")}>
          <Kanban size={14} /> Tasks
        </UiButton>
      </div>
      {tab === "chat" ? (
        <>
          <div className="message-list">
            <div ref={topObserverRef} style={{ height: 1, flexShrink: 0 }} />
            {loadingOlder && <ArcoSpin className="message-loading" size={18} tip="Loading older messages..." />}
            {!hasMore && allMessages.length > 0 && <div className="message-loading">Beginning of channel</div>}
            {allMessages.length === 0 && (
              <InlineEmpty
                className="message-empty"
                icon={<span className="brand-spike" aria-hidden />}
                title="Quiet here."
                description="Drop a thought, summon an agent with @, or kick off a task."
              />
            )}
            {allMessages.map(item => <React.Fragment key={item.id}>{renderMessage(item)}</React.Fragment>)}
          </div>
          <div className="composer">
            {mentionMatch && <MentionMenu options={mentionOptions} activeIndex={mentionIndex} onPick={insertMention} />}
            <UiTextArea
              ref={textareaRef}
              value={message}
              onChange={event => {
                setMessage(event.target.value);
                refreshMention(event.target);
              }}
              onClick={event => refreshMention(event.target as HTMLTextAreaElement)}
              onKeyUp={event => {
                if (mentionMatch && isMentionNavigationKey(event.key)) return;
                refreshMention(event.target as HTMLTextAreaElement);
              }}
              placeholder={`Message ${channel}`}
              onKeyDown={handleComposerKeyDown}
            />
            <div className="composer-bar">
              <label className="task-toggle">
                <UiInput type="checkbox" checked={asTask} onChange={event => setAsTask(event.target.checked)} />
                <span>Send as task</span>
              </label>
              <span className="composer-hint">⌘ ⏎ to send</span>
              <UiButton className="btn btn-primary" onClick={handleSend}>
                <Send size={15} /> <span>Send</span>
              </UiButton>
            </div>
          </div>
        </>
      ) : (
        tasksView
      )}
    </section>
  );
}

