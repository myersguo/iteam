import React from "react";
import { Tooltip as ArcoTooltip } from "@arco-design/web-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageSquare } from "lucide-react";
import type { AppState, Message } from "../types";
import { Avatar } from "./avatar";
import { DeliveryTimeline } from "./delivery-timeline";
import { UiButton } from "./ui";

export function MessageRow({
  message,
  state,
  openThread
}: {
  message: Message;
  state: AppState;
  openThread?: (id: string) => void;
}) {
  const agent = state.agents.find(item => item.id === message.authorId);
  const human = state.humans.find(item => item.id === message.authorId);
  const ingressBot = resolveIngressBotAuthor(state, message.authorId);
  const author = agent || human || ingressBot || { name: message.authorId, role: "system" };
  const task = state.tasks.find(item => item.id === message.taskId || item.messageId === message.id);
  const replyCount = countThreadReplies(state, message);
  const deliveryRecords = state.deliveries.filter(delivery => delivery.messageId === message.id);
  const deliveryIds = new Set(deliveryRecords.map(delivery => delivery.id));
  const activity = state.deliveryEvents.filter(event => deliveryIds.has(event.deliveryId));
  const artifacts = state.deliveryArtifacts.filter(artifact => deliveryIds.has(artifact.deliveryId));

  return (
    <article className={`msg ${message.type || "chat"}`} data-message-id={message.id}>
      <Avatar name={author.name} agent={!!agent} avatarUrl={human?.avatarUrl} />
      <div className="msg-body">
        <header>
          <strong>{author.name}</strong>
          {message.depth !== undefined && message.depth > 0 && (
            <span className="depth-badge" title={`第 ${message.depth + 1} 轮`}>R{message.depth + 1}</span>
          )}
          <ArcoTooltip content={new Date(message.createdAt).toLocaleString()}>
            <span className="tt-anchor">
              <small>{new Date(message.createdAt).toLocaleTimeString()}</small>
            </span>
          </ArcoTooltip>
        </header>
        <MessageContent text={message.text} />
        {(activity.length > 0 || deliveryRecords.length > 0) && (
          <DeliveryTimeline
            events={activity}
            deliveries={deliveryRecords}
            artifacts={artifacts}
            agents={state.agents}
          />
        )}
        <div className="msg-actions">
          {task && (
            <UiButton className="chip chip-task" onClick={() => openThread?.(message.id)}>
              <span className={`status-pip ${task.status}`} />#{task.number} · {task.status}
            </UiButton>
          )}
          <UiButton
            className={`chip chip-reply ${replyCount ? "has-replies" : ""}`}
            onClick={() => openThread?.(message.id)}
          >
            <MessageSquare size={13} /> {replyCount ? `${replyCount} ${replyCount === 1 ? "reply" : "replies"}` : "Reply"}
          </UiButton>
        </div>
      </div>
    </article>
  );
}

export function countThreadReplies(state: AppState, message: { target?: string; id?: string }): number {
  if (!message?.target || !message?.id) return 0;
  const counted = state.messages.find(item => item.id === message.id)?.replyCount;
  if (typeof counted === "number") return counted;
  return state.messages.filter(item => item.target === `${message.target}:${message.id}`).length;
}

function resolveIngressBotAuthor(state: AppState, authorId: string): { name: string; role: string } | null {
  if (!authorId.startsWith("ingress:")) return null;
  const provider = authorId.slice("ingress:".length);
  const config = state.externalBotConfigs.find(item => item.provider === provider);
  if (!config) return null;
  return { name: config.alias || config.appId || config.provider, role: "external-bot" };
}

function MessageContent({ text }: { text: string }) {
  const renderMentionText = (value: string) => {
    const parts = String(value || "").split(/(@[A-Za-z0-9_-]+)/g);
    return parts.map((part, index) =>
      part.startsWith("@")
        ? <span className="mention-text" key={index}>{part}</span>
        : <React.Fragment key={index}>{part}</React.Fragment>
    );
  };
  const renderMentionChildren = (children: React.ReactNode) => React.Children.map(children, child => {
    if (typeof child === "string") return renderMentionText(child);
    return child;
  });

  return (
    <div className="msg-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p>{renderMentionChildren(children)}</p>,
          li: ({ children }) => <li>{renderMentionChildren(children)}</li>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>
          ),
          code: ({ className, children, ...rest }) => {
            const inline = !/language-/.test(className || "") && !String(children).includes("\n");
            return inline
              ? <code className="md-code-inline" {...rest}>{children}</code>
              : <code className={className} {...rest}>{children}</code>;
          }
        }}
      >
        {String(text || "")}
      </ReactMarkdown>
    </div>
  );
}
