import React, { useEffect, useState } from "react";
import { Bot, ExternalLink, MessageSquare, Trash2 } from "lucide-react";
import type { AppState, ConfirmationRequest, ExternalBotConfig } from "../types";
import { Avatar } from "./avatar";
import { SectionLabel } from "./navigation";
import { Topbar } from "./topbar";
import { StatusTag, UiButton, UiInput } from "./ui";

export interface IntegrationsViewProps {
  state: AppState;
  refresh: () => void;
  selectedBotProvider: string | null;
  setSelectedBotProvider: (provider: string | null) => void;
  confirmDangerousAction: (request: ConfirmationRequest) => void;
  saveBotConfig: (body: Record<string, unknown>) => Promise<ExternalBotConfig>;
  deleteBotConfig: (provider: string) => Promise<void>;
}

const NEW_BOT_PROVIDER = "__new_bot__";

export function IntegrationsView({
  state,
  refresh,
  selectedBotProvider,
  setSelectedBotProvider,
  confirmDangerousAction,
  saveBotConfig,
  deleteBotConfig
}: IntegrationsViewProps) {
  const larkConfigs = state.externalBotConfigs.filter(config =>
    config.provider.startsWith("lark") || config.provider.startsWith("feishu")
  );
  const activeProvider = selectedBotProvider || larkConfigs[0]?.provider || NEW_BOT_PROVIDER;
  const existing = activeProvider === NEW_BOT_PROVIDER
    ? null
    : larkConfigs.find(config => config.provider === activeProvider) || null;
  const boundChats = existing
    ? state.externalBotBindings.filter(binding => binding.provider === existing.provider)
    : [];
  const [alias, setAlias] = useState(existing?.alias || "");
  const [appId, setAppId] = useState(existing?.appId || "");
  const [appSecret, setAppSecret] = useState("");
  const [domain, setDomain] = useState(existing?.domain || "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setAlias(existing?.alias || "");
    setAppId(existing?.appId || "");
    setDomain(existing?.domain || "");
    setEnabled(existing?.enabled ?? true);
    setAppSecret("");
  }, [existing?.alias, existing?.appId, existing?.domain, existing?.enabled, activeProvider]);

  async function save() {
    if (!appId.trim()) return;
    setSaving(true);
    setError("");
    try {
      const saved = await saveBotConfig({
        provider: existing?.provider || "lark",
        alias: alias.trim() || null,
        appId: appId.trim(),
        ...(appSecret.trim() ? { appSecret: appSecret.trim() } : {}),
        domain: domain.trim() || null,
        enabled
      });
      setSelectedBotProvider(saved.provider);
      await refresh();
    } catch (err) {
      setError((err as Error).message || "Failed to save bot config");
    } finally {
      setSaving(false);
    }
  }

  function deleteBot() {
    if (!existing) return;
    const label = existing.alias || existing.appId;
    confirmDangerousAction({
      title: `Delete bot ${label}?`,
      content: "This also removes its bound chats.",
      onOk: async () => {
        setSaving(true);
        setError("");
        try {
          await deleteBotConfig(existing.provider);
          setSelectedBotProvider(null);
          await refresh();
        } catch (err) {
          setError((err as Error).message || "Failed to delete bot config");
          throw err;
        } finally {
          setSaving(false);
        }
      }
    });
  }

  return (
    <section className="pane">
      <Topbar
        eyebrow="Integrations"
        title="Lark / Feishu bot"
        subtitle="Use a self-built app bot over long-connection events to talk with iTeam agents."
      />
      <div className="bots-layout">
        <aside className="panel panel-cream bots-guidance">
          <p className="eyebrow">How users talk to agents</p>
          <div className="integration-summary-card">
            <Bot size={16} />
            <div>
              <strong>{existing ? existing.alias || existing.appId : "New bot"}</strong>
              <small title={existing?.provider}>
                {existing ? existing.appId : `${larkConfigs.length} configured apps`}
              </small>
            </div>
            {existing && <StatusTag tone={botStatusClass(existing)}>{botStatusLabel(existing)}</StatusTag>}
          </div>
          <div className="bot-command-help">
            <p className="panel-note">After adding the bot to a chat, these messages are supported:</p>
            <ul className="bot-command-list">
              <li><code>/all @codex 帮我看一下这个问题</code></li>
              <li><code>/task /all @codex 帮我看一下这个问题</code></li>
              <li><code>/all 帮我看一下这个问题</code></li>
              <li><code>/iteam bind #all</code></li>
              <li><code>@codex 帮我看一下这个问题</code></li>
            </ul>
            <p className="panel-note">No channel + one agent mention routes to that agent's iTeam DM, not #all.</p>
          </div>
        </aside>
        <article className="panel panel-dark profile">
          <div className="profile-head">
            <Avatar name={alias || existing?.alias || "Lark"} agent large />
            <div>
              <p className="eyebrow on-dark">Bot app</p>
              <h1>
                {alias || existing?.alias || "Feishu bot"}{" "}
                <small>{existing ? (existing.enabled ? "configured" : "disabled") : "new"}</small>
              </h1>
            </div>
          </div>
          {existing && (
            <div className="bot-status-card">
              <StatusTag tone={botStatusClass(existing)}>{botStatusLabel(existing)}</StatusTag>
              <div>
                <strong>{botStatusTitle(existing)}</strong>
                <small>{existing.statusMessage || botStatusHint(existing)}</small>
              </div>
            </div>
          )}
          <label className="profile-rename">
            <span>Bot name / alias</span>
            <div><UiInput value={alias} onChange={event => setAlias(event.target.value)} placeholder="Production Feishu bot" /></div>
          </label>
          <label className="profile-rename">
            <span>App ID</span>
            <div><UiInput value={appId} onChange={event => setAppId(event.target.value)} placeholder="cli_xxx" disabled={!!existing} /></div>
          </label>
          <label className="profile-rename">
            <span>App Secret</span>
            <div>
              <UiInput
                type="password"
                value={appSecret}
                onChange={event => setAppSecret(event.target.value)}
                placeholder={existing?.appSecret ? "leave blank to keep existing secret" : "app secret"}
              />
            </div>
          </label>
          <label className="profile-rename">
            <span>Domain (optional)</span>
            <div><UiInput value={domain} onChange={event => setDomain(event.target.value)} placeholder="open.feishu.cn / open.larksuite.com" /></div>
          </label>
          <label className="check-row on-dark">
            <UiInput type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />
            <span>Enable long-connection bot on daemon restart</span>
          </label>
          {error && <p className="form-error">{error}</p>}
          <div className="profile-actions">
            <UiButton className="btn btn-secondary-on-dark" disabled={!appId.trim() || saving} onClick={save}>
              {saving ? "Saving..." : "Save bot config"}
            </UiButton>
            <a className="btn btn-secondary-on-dark" href="https://open.larkoffice.com/page/launcher?from=backend_oneclick" target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Create app
            </a>
            {existing && (
              <UiButton className="btn btn-danger-on-dark" disabled={saving} onClick={deleteBot}>
                <Trash2 size={14} /> Delete bot
              </UiButton>
            )}
          </div>
          <p className="profile-warning">
            Saving credentials now starts or reconnects the long-connection client automatically. If pairing stays pending, check App ID, App Secret, permissions, and event subscription.
          </p>
          <SectionLabel>Bound chats · {boundChats.length}</SectionLabel>
          <div className="bound-chat-list">
            {boundChats.map(binding => (
              <div className="bound-chat-row" key={binding.id}>
                <MessageSquare size={16} />
                <div>
                  <strong>{binding.defaultTarget || "No default channel"}</strong>
                  <small>{binding.chatId}</small>
                </div>
                <StatusTag tone={binding.status === "active" ? "done" : "closed"}>{binding.status}</StatusTag>
              </div>
            ))}
            {!existing && <p className="empty-note on-dark">Save this bot before binding Feishu chats.</p>}
            {existing && !boundChats.length && <p className="empty-note on-dark">No Feishu chat bound yet — use /iteam bind #all in this bot chat.</p>}
          </div>
        </article>
      </div>
    </section>
  );
}

function botStatusLabel(config: ExternalBotConfig): string {
  const status = config.enabled ? config.status || "pending" : "disabled";
  return status === "connected" ? "paired" : status;
}

function botStatusClass(config: ExternalBotConfig): string {
  const status = config.enabled ? config.status || "pending" : "disabled";
  if (status === "connected") return "done";
  if (status === "error" || status === "invalid") return "error";
  if (status === "pending") return "todo";
  return "closed";
}

function botStatusTitle(config: ExternalBotConfig): string {
  const status = config.enabled ? config.status || "pending" : "disabled";
  if (status === "connected") return "Feishu long connection paired.";
  if (status === "invalid") return "Not paired: invalid app id.";
  if (status === "error") return "Not paired: connection failed.";
  if (status === "disabled") return "Bot is disabled.";
  return "Waiting for daemon restart / connection.";
}

function botStatusHint(config: ExternalBotConfig): string {
  const status = config.enabled ? config.status || "pending" : "disabled";
  if (status === "connected" && config.lastConnectedAt) return `Last paired at ${new Date(config.lastConnectedAt).toLocaleString()}.`;
  if (status === "invalid") return "Use the real Feishu/Lark App ID, usually cli_xxx.";
  if (status === "error") return "Check App Secret, permissions, and long-connection availability, then restart the daemon.";
  if (status === "disabled") return "Enable this bot and restart the daemon to pair.";
  return "Save credentials, then restart the iTeam daemon so it can pair with Feishu/Lark.";
}
