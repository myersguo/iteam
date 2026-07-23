import type { AppState, SectionId, Space } from "../types";

export interface RouteState {
  section: SectionId;
  channel: string;
  chatTab: "chat" | "tasks";
  agentId: string | null;
  computerId: string | null;
  threadId: string | null;
  spaceSlug: string | null;
}

export function parseLocation(loc: Location | { pathname: string; search: string }): RouteState {
  const segments = loc.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const params = new URLSearchParams(loc.search);
  const threadId = params.get("thread");
  const route: RouteState = {
    section: "chat",
    channel: "#all",
    chatTab: "chat",
    agentId: null,
    computerId: null,
    threadId: threadId || null,
    spaceSlug: null
  };
  if (segments.length === 0) return route;
  let head = segments[0];
  let rest = segments.slice(1);
  // Allow an optional leading space slug: /:space/<section>/... . If the first
  // segment matches a known section keyword we treat it as legacy default-space
  // routing so old bookmarks keep working.
  if (!isSectionSegment(head)) {
    route.spaceSlug = head;
    head = rest[0] || "";
    rest = rest.slice(1);
    if (!head) return route;
  }
  switch (head) {
    case "channel": {
      route.section = "chat";
      if (rest[0]) route.channel = `#${rest[0].replace(/^#/, "")}`;
      if (rest[1] === "tasks" || rest[1] === "task") route.chatTab = "tasks";
      return route;
    }
    case "dm": {
      route.section = "chat";
      if (rest[0]) route.channel = `dm:${rest[0]}`;
      return route;
    }
    case "tasks":
    case "task": {
      route.section = "tasks";
      return route;
    }
    case "agents": {
      route.section = "members";
      return route;
    }
    case "agent": {
      route.section = "members";
      if (rest[0]) route.agentId = rest[0];
      return route;
    }
    case "computers": {
      route.section = "computers";
      return route;
    }
    case "computer": {
      route.section = "computers";
      if (rest[0]) route.computerId = rest[0];
      return route;
    }
    case "scheduled": {
      route.section = "scheduled";
      return route;
    }
    case "bots":
    case "integrations": {
      route.section = "integrations";
      return route;
    }
    default:
      return route;
  }
}

const SECTION_SEGMENTS = new Set([
  "channel", "dm", "tasks", "task", "agents", "agent",
  "computers", "computer", "scheduled", "bots", "integrations"
]);

function isSectionSegment(value: string): boolean {
  return SECTION_SEGMENTS.has(value);
}

export function buildPath(
  route: {
    section: SectionId;
    channel: string;
    chatTab: "chat" | "tasks";
    agentId: string | null;
    computerId: string | null;
    threadId: string | null;
    spaceSlug?: string | null;
  },
  state: AppState
): string {
  let path = "";
  if (route.section === "tasks") {
    path = "/tasks";
  } else if (route.section === "chat") {
    if (route.channel.startsWith("dm:")) {
      const agentId = route.channel.slice(3);
      const agent = state.agents.find(agent => agent.id === agentId);
      const handle = agent?.handle || agent?.id || agentId;
      path = `/dm/${encodeURIComponent(handle)}`;
    } else {
      const name = route.channel.replace(/^#/, "");
      path = `/channel/${encodeURIComponent(name)}`;
      if (route.chatTab === "tasks") path += "/tasks";
    }
  } else if (route.section === "members") {
    if (route.agentId) path = `/agent/${encodeURIComponent(route.agentId)}`;
    else path = "/agents";
  } else if (route.section === "computers") {
    if (route.computerId) path = `/computer/${encodeURIComponent(route.computerId)}`;
    else path = "/computers";
  } else if (route.section === "scheduled") {
    path = "/scheduled";
  } else if (route.section === "integrations") {
    path = "/bots";
  }
  const slug = normalizeSpaceSlugForPath(route.spaceSlug);
  if (slug) path = `/${encodeURIComponent(slug)}${path || "/"}`;
  else if (!path) path = "/";
  const params = new URLSearchParams();
  if (route.threadId) params.set("thread", route.threadId);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Return the slug that should appear in the URL. The default space is omitted
 * so `/channel/all` continues to point to it.
 */
function normalizeSpaceSlugForPath(slug: string | null | undefined): string | null {
  const value = String(slug || "").trim();
  if (!value) return null;
  if (value === "default" || value === "space_default") return null;
  return value;
}

export function spaceIdToSlug(spaceId: string, spaces: Space[]): string | null {
  if (!spaceId || spaceId === "space_default") return null;
  const match = spaces.find(space => space.id === spaceId);
  return match ? match.slug : spaceId;
}
