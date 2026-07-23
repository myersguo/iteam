import React, { useMemo, useState } from "react";
import { Computer, Copy, Play, Plus, Square, Trash2, X } from "lucide-react";
import { Empty as ArcoEmpty } from "@arco-design/web-react";
import type { Agent, ComputerEntity } from "../types";
import { Avatar } from "./avatar";
import { Topbar } from "./topbar";
import { StatusTag, UiButton, UiModalHost } from "./ui";
import { agentRuntimeError, isAgentStopped } from "../features";

export interface ConnectInvite {
  id: string;
  command: string;
}

export interface ComputersViewProps {
  state: {
    agents: Agent[];
    computers: ComputerEntity[];
  };
  selectedComputer: ComputerEntity | null;
  openConnectComputer: () => void;
  toggleAgent: (agent: Agent) => Promise<void>;
  deleteComputer: (computer: ComputerEntity) => Promise<void>;
}

export function ComputersView({
  state,
  selectedComputer,
  openConnectComputer,
  toggleAgent,
  deleteComputer
}: ComputersViewProps) {
  const computer = selectedComputer || state.computers[0];
  const onlineRuntimeIds = useMemo(() => {
    if (!computer) return new Set<string>();
    return new Set(
      state.agents
        .filter(agent =>
          agent.computerId === computer.id &&
          agent.desiredStatus !== "stopped" &&
          String(agent.status || "").toLowerCase() === "online"
        )
        .map(agent => agent.runtime)
    );
  }, [computer, state.agents]);

  return (
    <section className="pane">
      <Topbar
        eyebrow="Devices"
        title={computer?.name || "Computers"}
        subtitle="Connect local machines and inspect their daemon and runtime status."
      />
      {!computer && (
        <div className="empty computers-empty">
          <span className="brand-spike" aria-hidden />
          <ArcoEmpty description="Bring your own machine — local agents need a host to think from." />
          <UiButton className="btn btn-primary" onClick={openConnectComputer}>
            <Plus size={15} /> Connect computer
          </UiButton>
        </div>
      )}
      {computer && (
        <article className="computer-card">
          <div className="computer-card-icon"><Computer size={28} /></div>
          <div className="computer-card-body">
            <p className="eyebrow">Connected device</p>
            <h1>{computer.name} <small>{computer.status}</small></h1>
            <p className="muted">{computer.fingerprint.os} · {computer.fingerprint.arch} · daemon {computer.daemonVersion}</p>
            <div className="chips">
              {computer.runtimes.map(runtime => (
                <span className={`chip-runtime ${runtime.installed ? "live" : "dim"}`} key={runtime.id}>
                  {runtime.installed && <span className={`chip-dot ${onlineRuntimeIds.has(runtime.id) ? "online" : "offline"}`} />}{" "}
                  {runtime.name}{runtime.installed ? "" : " · not installed"}
                </span>
              ))}
            </div>
          </div>
          <div className="computer-card-actions">
            <UiButton className="btn btn-ghost btn-danger" onClick={() => void deleteComputer(computer)} title="Delete this computer">
              <Trash2 size={14} /> Delete
            </UiButton>
          </div>
        </article>
      )}
      {computer?.connectToken && <ComputerConnectCommand computer={computer} />}
      <div className="section-head"><h2>Agents on this computer</h2></div>
      <div className="agent-table">
        {state.agents
          .filter(agent => !computer || agent.computerId === computer.id)
          .map(agent => (
            <div className="agent-row" key={agent.id}>
              <Avatar name={agent.name} agent />
              <div>
                <strong>{agent.name}</strong>
                <small>{agent.runtime}</small>
                {agentRuntimeError(agent) && <small className="agent-error">{agentRuntimeError(agent)}</small>}
              </div>
              <StatusTag
                className="agent-status-tag"
                tone={agentRuntimeError(agent) ? "error" : isAgentStopped(agent) ? "closed" : "in_progress"}
              >
                {agent.status}
              </StatusTag>
              <UiButton className="btn btn-ghost" onClick={() => void toggleAgent(agent)}>
                {isAgentStopped(agent) ? <Play size={13} /> : <Square size={13} />}
                {isAgentStopped(agent) ? " Start" : " Stop"}
              </UiButton>
            </div>
          ))}
        {state.agents.filter(agent => !computer || agent.computerId === computer?.id).length === 0 && (
          <p className="muted padded">No agents on this computer yet.</p>
        )}
      </div>
    </section>
  );
}

export function ConnectComputerModal({
  invite,
  connectedComputer,
  onClose
}: {
  invite: ConnectInvite;
  connectedComputer: ComputerEntity | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copyCommand() {
    const ok = await copyToClipboard(invite.command);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <UiModalHost onClose={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-computer-title">
        <UiButton className="modal-close" title="Close" onClick={onClose}><X /></UiButton>
        <p className="eyebrow">Bring your own machine</p>
        <h1 id="connect-computer-title">Connect a computer.</h1>
        <p className="modal-lede">Run the command below on the machine you want to register. iTeam pairs over a local handshake — no cloud round-trip.</p>
        <div className="terminal">
          <header><span className="dot red" /><span className="dot amber" /><span className="dot teal" /><span className="terminal-label">~/iteam · pair</span></header>
          <div className="terminal-body">
            <code><span className="prompt">$</span> {invite.command}</code>
            <UiButton className="terminal-copy" title="Copy" onClick={() => void copyCommand()}>
              <Copy size={14} /> {copied ? "Copied" : "Copy"}
            </UiButton>
          </div>
        </div>
        <div className={`pair-state ${connectedComputer ? "is-connected" : ""}`}>
          <span className="pair-dot" />
          <strong>{connectedComputer ? `${connectedComputer.name} connected.` : "Waiting for the handshake…"}</strong>
        </div>
        <footer className="modal-actions">
          <UiButton className="btn btn-ghost" onClick={onClose}>Cancel</UiButton>
          <UiButton className="btn btn-primary" disabled={!connectedComputer} onClick={onClose}>Done</UiButton>
        </footer>
      </section>
    </UiModalHost>
  );
}

function ComputerConnectCommand({ computer }: { computer: ComputerEntity }) {
  const command = useMemo(() => {
    const origin = window.location.origin;
    return [
      "npx", "-y", "@myersguo/iteam@latest", "daemon", "connect",
      "--server-url", origin, "--connect-token", computer.connectToken || ""
    ].join(" ");
  }, [computer.connectToken]);
  const [copied, setCopied] = useState(false);

  async function copy() {
    const ok = await copyToClipboard(command);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  return (
    <section className="connect-command-block">
      <div className="connect-command-head">
        <p className="eyebrow">Connect command</p>
        <p className="connect-command-hint">Run this once on your local machine to pair the daemon.</p>
      </div>
      <div className="terminal terminal-inline">
        <div className="terminal-body terminal-body-inline">
          <div className="terminal-scroll" role="region" aria-label="Connect command">
            <code className="terminal-command"><span className="prompt">$</span> {command}</code>
          </div>
          <UiButton className="terminal-copy" title="Copy" onClick={() => void copy()}>
            <Copy size={14} /> {copied ? "Copied" : "Copy"}
          </UiButton>
        </div>
      </div>
    </section>
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
