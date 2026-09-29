import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Db = Database;

export type Project = {
  id: number;
  name: string;
  origins: string[];
  siteKey: string;
  createdAt: string;
};

export type Reply = {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  updatedAt?: string;
  images?: ImageMeta[];
};

export type ImageMeta = {
  id: string;
  url: string;
  mime: string;
  size: number;
};

export type Comment = {
  id: string;
  page: string;
  url: string | null;
  type: string;
  author: string;
  text: string;
  color: string;
  anchor: unknown;
  geom: unknown;
  resolved: boolean;
  replies: Reply[];
  images: ImageMeta[];
  createdAt: string;
  updatedAt: string;
};

type ProjectRow = {
  id: number;
  name: string;
  origins_json: string;
  site_key: string;
  created_at: string;
};

export type CommentRow = {
  id: string;
  project_id: number;
  page: string;
  url: string | null;
  type: string;
  author: string;
  text: string;
  color: string;
  anchor_json: string | null;
  geom_json: string | null;
  resolved: number;
  replies_json: string;
  images_json: string;
  created_at: string;
  updated_at: string;
};

export const DEFAULT_DB_PATH = "./data/annotate.sqlite";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    origins_json TEXT NOT NULL,
    site_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page TEXT NOT NULL,
    url TEXT,
    type TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    color TEXT NOT NULL,
    anchor_json TEXT,
    geom_json TEXT,
    resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1)),
    replies_json TEXT NOT NULL DEFAULT '[]',
    images_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS comments_project_page_idx
    ON comments (project_id, page, created_at);

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
    reply_id TEXT,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS images_comment_idx
    ON images (project_id, comment_id, reply_id);
`;

export function createDatabase(dbPath = process.env.ANNOTATE_DB_PATH || DEFAULT_DB_PATH): Db {
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA journal_mode = WAL");
  db.run(SCHEMA);
  return db;
}

export function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    origins: parseJson<string[]>(row.origins_json, []),
    siteKey: row.site_key,
    createdAt: row.created_at,
  };
}

export function rowToComment(row: CommentRow, imageUrl: (id: string) => string): Comment {
  const images = parseJson<Omit<ImageMeta, "url">[]>(row.images_json, []).map((image) => ({
    ...image,
    url: imageUrl(image.id),
  }));
  const replies = parseJson<Reply[]>(row.replies_json, []).map((reply) => ({
    ...reply,
    images: (reply.images || []).map((image) => ({
      ...image,
      url: imageUrl(image.id),
    })),
  }));

  return {
    id: row.id,
    page: row.page,
    url: row.url,
    type: row.type,
    author: row.author,
    text: row.text,
    color: row.color,
    anchor: parseJson(row.anchor_json, null),
    geom: parseJson(row.geom_json, null),
    resolved: Boolean(row.resolved),
    replies,
    images,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function generateSiteKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getProjectByKey(db: Db, siteKey: string): Project | null {
  const row = db.query("SELECT * FROM projects WHERE site_key = ? LIMIT 1").get(siteKey) as ProjectRow | null;
  return row ? rowToProject(row) : null;
}

export function getProjectById(db: Db, projectId: number): Project | null {
  const row = db.query("SELECT * FROM projects WHERE id = ? LIMIT 1").get(projectId) as ProjectRow | null;
  return row ? rowToProject(row) : null;
}

export function hasOrigin(db: Db, origin: string): boolean {
  const rows = db.query("SELECT origins_json FROM projects").all() as Array<{ origins_json: string }>;
  return rows.some((row) => parseJson<string[]>(row.origins_json, []).includes(origin));
}

export function createProject(db: Db, name: string, origins: string[]): Project {
  const createdAt = now();
  let siteKey = generateSiteKey();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      db.query(
        "INSERT INTO projects (name, origins_json, site_key, created_at) VALUES (?, ?, ?, ?)",
      ).run(name, JSON.stringify(origins), siteKey, createdAt);
      const row = db.query("SELECT * FROM projects WHERE site_key = ? LIMIT 1").get(siteKey) as ProjectRow;
      return rowToProject(row);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("UNIQUE")) throw error;
      siteKey = generateSiteKey();
    }
  }
  throw new Error("could not generate a unique project key");
}

export function withTransaction<T>(db: Db, fn: () => T): T {
  db.run("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.run("COMMIT");
    return result;
  } catch (error) {
    try { db.run("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
}
