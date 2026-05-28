/** Domain types shared across CLI, core, and worker client. */

/** A stored inbound email as returned by the worker read API. */
export interface Email {
  id: number;
  sender: string;
  recipient: string;
  subject: string | null;
  text: string | null;
  html: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  received_at: string; // ISO-ish (SQLite datetime)
  read: number; // 0 | 1
  /** Optional Workers-AI classification, present when the worker enriches. */
  intent?: EmailIntent | null;
}

export type IntentKind =
  | "verification"
  | "magic_link"
  | "password_reset"
  | "two_factor"
  | "marketing"
  | "transactional"
  | "other";

export interface EmailIntent {
  kind: IntentKind;
  service: string | null;
  action_url: string | null;
  confidence: number; // 0..1
}

/** Heuristic + intent extraction result for `code`. */
export interface VerificationResult {
  email_id: number;
  from: string;
  subject: string | null;
  received_at: string;
  code: string | null;
  codes: string[];
  links: string[];
  intent?: EmailIntent | null;
}

/** A named connection profile — the "any Cloudflare account" seam. */
export interface Profile {
  name: string;
  /** Base URL of the deployed worker, e.g. https://mail.clearfeed.tech */
  workerUrl: string;
  /** Bearer API key for the worker read API. */
  apiKey: string;
  /** Default recipient filter for client commands (optional). */
  defaultTo?: string;
  /** Cloudflare account/zone metadata, used by admin/provisioning commands. */
  accountId?: string;
  zoneId?: string;
  domain?: string;
}

export interface ProfileStore {
  active: string;
  profiles: Record<string, Profile>;
}
