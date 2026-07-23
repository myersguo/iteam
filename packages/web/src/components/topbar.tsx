import React from "react";

export function Topbar({
  eyebrow,
  title,
  subtitle,
  extra
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  extra?: React.ReactNode;
}) {
  return (
    <header className="topbar">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {subtitle && <p className="topbar-sub">{subtitle}</p>}
        {extra}
      </div>
    </header>
  );
}
