import React from "react";
import { ChevronRight } from "lucide-react";
import type { AuthInfo, AuthProviderOption } from "../types";

export function AuthGate({ auth }: { auth: AuthInfo }) {
  const providers = auth.providers || [];
  const fallbackLoginUrl = auth.loginUrl || providers[0]?.loginUrl || "/auth/login";
  const multiProvider = providers.length > 1;

  return (
    <div className="auth-gate">
      <section className="auth-card">
        <span className="brand-spike" aria-hidden />
        <p className="eyebrow">Secure workspace</p>
        <h1>{multiProvider ? "Choose how to sign in." : "Sign in to iTeam."}</h1>
        <p>Identify yourself before posting messages, creating tasks, or coordinating agents.</p>
        <div className="auth-provider-list">
          {providers.length > 0 ? providers.map(provider => (
            <a className="auth-provider-card" href={provider.loginUrl} key={provider.id}>
              <span className={`auth-provider-icon ${provider.type}`}>{providerIcon(provider)}</span>
              <span>
                <strong>{provider.label}</strong>
                <small>{providerDescription(provider)}</small>
              </span>
              <ChevronRight size={16} />
            </a>
          )) : (
            <a className="btn btn-primary" href={fallbackLoginUrl}>
              Sign in
            </a>
          )}
        </div>
      </section>
    </div>
  );
}

function providerIcon(provider: AuthProviderOption): string {
  if (provider.type === "github" || provider.id === "github") return "GH";
  return "OA";
}

function providerDescription(provider: AuthProviderOption): string {
  if (provider.type === "github" || provider.id === "github") return "Use your GitHub OAuth identity.";
  return "Use a configured OAuth provider.";
}
