import { getDb } from "./db.js";

const normalize = (handle: string): string => handle.replace(/^@/, "").toLowerCase();

export interface AccountRow {
  handle: string;
  display_name: string | null;
  weight: number;
  added_at: string;
  last_interacted_at: string | null;
}

/** Add or update a tracked account's weight. */
export function addAccount(handle: string, weight: number): AccountRow {
  const db = getDb();
  const key = normalize(handle);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO accounts (handle, weight, added_at)
     VALUES (?, ?, ?)
     ON CONFLICT(handle) DO UPDATE SET weight = excluded.weight`,
  ).run(key, weight, now);
  return db.prepare("SELECT * FROM accounts WHERE handle = ?").get(key) as AccountRow;
}

/** List tracked accounts, highest weight first. */
export function listAccounts(): AccountRow[] {
  return getDb()
    .prepare("SELECT * FROM accounts ORDER BY weight DESC, handle ASC")
    .all() as AccountRow[];
}
