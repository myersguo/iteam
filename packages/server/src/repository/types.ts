import type { DeliveryArtifact, DeliveryEvent, Message } from "@iteam/shared";

export interface MessageQuery {
  spaceId?: string | null;
  target: string;
  limit?: number | string | null;
  before?: string | null;
}

export interface ChannelMessageQuery {
  spaceId?: string | null;
  channelId: string;
  limit?: number | string | null;
  before?: string | null;
}

export interface DeliveryEventQuery {
  spaceId?: string | null;
  target?: string | null;
  deliveryId?: string | null;
  limit?: number | string | null;
}

export interface DeliveryArtifactQuery {
  spaceId?: string | null;
  target?: string | null;
  deliveryId?: string | null;
  eventId?: string | null;
  limit?: number | string | null;
}

export type ChannelMessageResult = Message & { replyCount: number; depth?: number };

export interface IteamRepository {
  listMessagesByTarget(query: MessageQuery): Promise<Message[]>;
  listMessagesByChannel(query: ChannelMessageQuery): Promise<ChannelMessageResult[]>;
  listDeliveryEvents(query?: DeliveryEventQuery): Promise<DeliveryEvent[]>;
  listDeliveryArtifacts(query?: DeliveryArtifactQuery): Promise<DeliveryArtifact[]>;
  getDeliveryArtifact(artifactId: string, spaceId?: string | null): Promise<DeliveryArtifact | null>;
}

export interface SqlRowsAdapter {
  all<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;
}
