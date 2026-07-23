import React from "react";
import { Avatar } from "./avatar";
import { UiButton } from "./ui";
import type { Agent, AppState } from "../types";

export interface MentionMember {
  id: string;
  kind: "human" | "agent";
  name: string;
  handle: string;
  status: string;
}

export interface MentionMatch {
  start: number;
  end: number;
  query: string;
}

export interface MentionReference {
  id: string;
  kind: MentionMember["kind"];
  handle: string;
  name: string;
}

export function MentionMenu({
  options,
  activeIndex,
  onPick
}: {
  options: MentionMember[];
  activeIndex: number;
  onPick: (member: MentionMember) => void;
}) {
  return (
    <div className="mention-menu">
      {options.length === 0 && <div className="mention-empty">No matching members</div>}
      {options.map((member, index) => (
        <UiButton
          key={`${member.kind}-${member.id}`}
          className={`mention-option ${index === activeIndex ? "is-active" : ""}`}
          onMouseDown={event => {
            event.preventDefault();
            onPick(member);
          }}
        >
          <Avatar name={member.name} agent={member.kind === "agent"} />
          <span>{member.name}</span>
          <small>@{member.handle}</small>
        </UiButton>
      ))}
    </div>
  );
}

export function getMentionMembers(state: AppState, channelTarget?: string): MentionMember[] {
  const dmAgentId = channelTarget?.startsWith("dm:") ? channelTarget.slice(3) : null;
  const agents = dmAgentId
    ? state.agents.filter(agent => agent.id === dmAgentId)
    : state.agents;
  return [
    ...state.humans.map(human => ({
      id: human.id,
      kind: "human" as const,
      name: human.name,
      handle: human.handle || slugHandle(human.name),
      status: human.role || "human"
    })),
    ...agents.map(agent => ({
      id: agent.id,
      kind: "agent" as const,
      name: agent.name,
      handle: agent.handle || slugHandle(agent.name),
      status: agent.status
    }))
  ];
}

export function isMentionNavigationKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === "Tab" || key === "Escape";
}

export function findMentionMatch(value: string, cursor: number): MentionMatch | null {
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const prefix = at === 0 ? "" : before[at - 1];
  if (prefix && !/\s/.test(prefix)) return null;
  const query = before.slice(at + 1);
  if (!/^[A-Za-z0-9_-]*$/.test(query)) return null;
  return { start: at, end: cursor, query };
}

export function collectMentions(text: string, members: MentionMember[]): MentionReference[] {
  const handles = new Set(
    Array.from(text.matchAll(/@([A-Za-z0-9_-]+)/g)).map(match => match[1].toLowerCase())
  );
  return members
    .filter(member => handles.has(member.handle.toLowerCase()))
    .map(member => ({
      id: member.id,
      kind: member.kind,
      handle: member.handle,
      name: member.name
    }));
}

function slugHandle(value: string): string {
  return String(value || "member")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "member";
}
