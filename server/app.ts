import { join, resolve } from "node:path";
import {
  Comment,
  CommentRow,
  Db,
  ImageMeta,
  Project,
  Reply,
  createDatabase,
  getProjectByKey,
  hasOrigin,
  id,
  now,
  parseJson,
  rowToComment,
  withTransaction,
} from "./db";

const MAX_TEXT = 5000;
const MAX_NAME = 100;
const MAX_PAGE = 500;
const MAX_URL = 2000;
const MAX_JSON_BODY = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_STRUCTURED_FIELD = 512 * 1024;
const DEFAULT_COLOR = "#f59e0b";
const COMMENT_TYPES = new Set(["note", "highlight", "pin", "shape", "pen", "block"]);

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

type AppOptions = {
  dbPath?: string;
  staticRoot?: string;
};

type Authorized = {
  project: Project;
  origin: string | null;
};

type StoredImage = Omit<ImageMeta, "url">;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function httpError(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterCount(value: string): number {
  return Array.from(value).length;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) httpError(400, "invalid_input", `${field} is required`);
  const result = value.trim();
  if (characterCount(result) > max) httpError(400, "invalid_input", `${field} is too long`);
  return result;
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string") httpError(400, "invalid_input", `${field} must be a string`);
  if (characterCount(value) > max) httpError(400, "invalid_input", `${field} is too long`);
  return value;
}

function validateColor(value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) {
    httpError(400, "invalid_input", "color must be a hex color");
  }
  return value;
}

function structuredJson(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (!isRecord(value) && !Array.isArray(value)) httpError(400, "invalid_input", `${field} must be an object`);
  const validateValue = (candidate: unknown, depth: number): void => {
    if (depth > 24) httpError(400, "invalid_input", `${field} is too deeply nested`);
    if (typeof candidate === "number" && !Number.isFinite(candidate)) {
      httpError(400, "invalid_input", `${field} contains an invalid number`);
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((item) => validateValue(item, depth + 1));
      return;
    }
    if (isRecord(candidate)) {
      Object.values(candidate).forEach((item) => validateValue(item, depth + 1));
      return;
    }
    if (!["string", "number", "boolean"].includes(typeof candidate) && candidate !== null) {
      httpError(400, "invalid_input", `${field} must be JSON data`);
    }
  };
  validateValue(value, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    httpError(400, "invalid_input", `${field} must be JSON data`);
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_STRUCTURED_FIELD) {
    httpError(400, "invalid_input", `${field} is too large`);
  }
  return serialized;
}

function errorResponse(error: unknown, origin: string | null, allowCors: boolean): Response {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : "internal_error";
  const message = error instanceof HttpError ? error.message : "request failed";
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (origin && allowCors) applyCors(headers, origin);
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

function jsonResponse(value: unknown, status = 200, origin: string | null = null): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (origin) applyCors(headers, origin);
  return new Response(JSON.stringify(value), { status, headers });
}

function applyCors(headers: Headers, origin: string): void {
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-headers", "Content-Type, X-Annotate-Key");
  headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
  headers.set("access-control-max-age", "600");
  headers.append("vary", "Origin");
}

function keyFromRequest(request: Request, imageQuery = false): string {
  const key = imageQuery
    ? new URL(request.url).searchParams.get("key")
    : request.headers.get("X-Annotate-Key");
  if (!key || key.length > 200) httpError(401, "invalid_key", "annotate key is required");
  return key;
}

function originFromRequest(request: Request): string | null {
  const value = request.headers.get("Origin");
  return value || null;
}

function authorize(db: Db, request: Request, imageQuery = false): Authorized {
  const origin = originFromRequest(request);
  const key = keyFromRequest(request, imageQuery);
  const project = getProjectByKey(db, key);
  if (!project) httpError(401, "invalid_key", "annotate key is invalid");
  if (origin && !project.origins.includes(origin)) {
    httpError(403, "origin_not_allowed", "origin is not allowed for this project");
  }
  return { project, origin };
}

function parsePath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      httpError(400, "invalid_path", "invalid URL path");
    }
  });
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    httpError(415, "unsupported_media_type", "JSON request body is required");
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_JSON_BODY) httpError(413, "payload_too_large", "request body is too large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_JSON_BODY) {
    httpError(413, "payload_too_large", "request body is too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    httpError(400, "invalid_json", "request body must be valid JSON");
  }
  if (!isRecord(body)) httpError(400, "invalid_json", "request body must be an object");
  return body;
}

function getComment(db: Db, projectId: number, commentId: string): CommentRow | null {
  return db.query(
    "SELECT * FROM comments WHERE project_id = ? AND id = ? LIMIT 1",
  ).get(projectId, commentId) as CommentRow | null;
}

function toComment(db: Db, project: Project, row: CommentRow): Comment {
  return rowToComment(row, (imageId) => `/v1/images/${encodeURIComponent(imageId)}?key=${encodeURIComponent(project.siteKey)}`);
}

function validateReply(raw: unknown): Reply {
  if (!isRecord(raw)) httpError(400, "invalid_input", "reply must be an object");
  const text = requiredString(raw.text, "reply.text", MAX_TEXT);
  const author = raw.author ?? raw.name ?? "Anonymous";
  const replyAuthor = requiredString(author, "reply.author", MAX_NAME);
  return {
    id: typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : id("r"),
    author: replyAuthor,
    text,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : now(),
    images: [],
  };
}

function validateImageMagic(data: Uint8Array): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 &&
    data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a
  ) return "image/png";
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) return "image/webp";
  if (
    data.length >= 6 &&
    ((data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 &&
      data[4] === 0x37 && data[5] === 0x61) ||
      (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38 &&
        data[4] === 0x39 && data[5] === 0x61))
  ) return "image/gif";
  return null;
}

async function parseImage(value: FormDataEntryValue | null): Promise<{ mime: string; data: Uint8Array }> {
  if (!(value instanceof File)) httpError(400, "invalid_image", "image file is required");
  const mime = value.type.toLowerCase();
  if (!IMAGE_TYPES.has(mime)) httpError(415, "invalid_image", "image type is not supported");
  if (value.size <= 0 || value.size > MAX_IMAGE_BYTES) {
    httpError(413, "invalid_image", "image must be between 1 byte and 5 MiB");
  }
  const data = new Uint8Array(await value.arrayBuffer());
  if (validateImageMagic(data) !== mime) {
    httpError(415, "invalid_image", "image content does not match its type");
  }
  return { mime, data };
}

async function uploadImage(db: Db, project: Project, commentId: string, request: Request, origin: string | null): Promise<Response> {
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    httpError(415, "unsupported_media_type", "multipart image upload is required");
  }
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_IMAGE_BYTES + 256 * 1024) httpError(413, "payload_too_large", "request body is too large");
  const form = await request.formData();
  const parsed = await parseImage(form.get("image"));
  const replyIdValue = form.get("replyId");
  const replyId = replyIdValue == null ? null : requiredString(replyIdValue, "replyId", 200);
  const row = getComment(db, project.id, commentId);
  if (!row) httpError(404, "not_found", "comment not found");

  const imageId = id("i");
  const createdAt = now();
  const stored: StoredImage = { id: imageId, mime: parsed.mime, size: parsed.data.byteLength };
  withTransaction(db, () => {
    const replies = parseJson<Reply[]>(row.replies_json, []);
    if (replyId && !replies.some((reply) => reply.id === replyId)) {
      httpError(404, "not_found", "reply not found");
    }
    db.query(
      "INSERT INTO images (id, project_id, comment_id, reply_id, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(imageId, project.id, commentId, replyId, parsed.mime, parsed.data.byteLength, parsed.data, createdAt);

    const images = parseJson<StoredImage[]>(row.images_json, []);
    if (!replyId) {
      images.push(stored);
    } else {
      const reply = replies.find((candidate) => candidate.id === replyId)!;
      reply.images = [...(reply.images || []), stored as ImageMeta];
    }
    if (replyId) {
      db.query("UPDATE comments SET replies_json = ?, updated_at = ? WHERE project_id = ? AND id = ?")
        .run(JSON.stringify(replies), createdAt, project.id, commentId);
    } else {
      db.query("UPDATE comments SET images_json = ?, updated_at = ? WHERE project_id = ? AND id = ?")
        .run(JSON.stringify(images), createdAt, project.id, commentId);
    }
  });

  return jsonResponse({
    id: imageId,
    url: `/v1/images/${encodeURIComponent(imageId)}?key=${encodeURIComponent(project.siteKey)}`,
    mime: parsed.mime,
    size: parsed.data.byteLength,
  }, 201, origin);
}

async function staticResponse(staticRoot: string, pathname: string, origin: string | null, allowCors: boolean): Promise<Response> {
  const files: Record<string, [string, string]> = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/embed.js": ["dist/embed.js", "application/javascript; charset=utf-8"],
    "/embed.css": ["dist/embed.css", "text/css; charset=utf-8"],
    "/emoji-data.json": ["dist/emoji-data.json", "application/json; charset=utf-8"],
    "/annotate.js": ["annotate.js", "application/javascript; charset=utf-8"],
  };
  const entry = files[pathname];
  if (!entry) return jsonResponse({ error: { code: "not_found", message: "route not found" } }, 404);
  const file = Bun.file(join(staticRoot, entry[0]));
  if (!(await file.exists())) return jsonResponse({ error: { code: "not_found", message: "static asset not found" } }, 404);
  const headers = new Headers({
    "content-type": entry[1],
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  if (origin && allowCors) applyCors(headers, origin);
  return new Response(file, { headers });
}

function imageResponse(db: Db, project: Project, imageId: string, origin: string | null): Response {
  const row = db.query(
    "SELECT mime, size, data FROM images WHERE project_id = ? AND id = ? LIMIT 1",
  ).get(project.id, imageId) as { mime: string; size: number; data: Uint8Array | ArrayBuffer } | null;
  if (!row) httpError(404, "not_found", "image not found");
  const data = row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data);
  const headers = new Headers({
    "content-type": row.mime,
    "content-length": String(row.size),
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
  });
  if (origin) applyCors(headers, origin);
  return new Response(data, { status: 200, headers });
}

function listComments(db: Db, project: Project, page: string, origin: string | null): Response {
  const rows = db.query(
    "SELECT * FROM comments WHERE project_id = ? AND page = ? ORDER BY created_at ASC",
  ).all(project.id, page) as CommentRow[];
  return jsonResponse({ comments: rows.map((row) => toComment(db, project, row)) }, 200, origin);
}

async function createComment(db: Db, project: Project, request: Request, origin: string | null): Promise<Response> {
  const body = await jsonBody(request);
  const page = requiredString(body.page, "page", MAX_PAGE);
  const text = requiredString(body.text, "text", MAX_TEXT);
  const author = requiredString(body.author ?? body.name ?? "Anonymous", "author", MAX_NAME);
  const url = optionalString(body.url, "url", MAX_URL);
  const type = body.type == null ? "note" : requiredString(body.type, "type", 40);
  if (!COMMENT_TYPES.has(type)) httpError(400, "invalid_input", "type is not supported");
  const color = body.color == null ? DEFAULT_COLOR : validateColor(body.color);
  const anchor = structuredJson(body.anchor, "anchor");
  const geom = structuredJson(body.geom, "geom");
  const requestedId = body.id == null ? null : requiredString(body.id, "id", 80);
  if (requestedId && !/^c[a-z0-9-]{10,79}$/.test(requestedId)) {
    httpError(400, "invalid_input", "id has an invalid format");
  }
  const commentId = requestedId || id("c");
  const existing = requestedId
    ? db.query("SELECT * FROM comments WHERE id = ? LIMIT 1").get(requestedId) as CommentRow | null
    : null;
  if (existing) {
    if (existing.project_id !== project.id || existing.page !== page || existing.url !== url ||
      existing.type !== type || existing.author !== author || existing.text !== text ||
      existing.color !== color || existing.anchor_json !== anchor || existing.geom_json !== geom) {
      httpError(409, "id_conflict", "comment id was already used for different content");
    }
    return jsonResponse(toComment(db, project, existing), 200, origin);
  }
  const timestamp = now();
  db.query(
    `INSERT INTO comments
      (id, project_id, page, url, type, author, text, color, anchor_json, geom_json, resolved, replies_json, images_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '[]', '[]', ?, ?)`,
  ).run(commentId, project.id, page, url, type, author, text, color, anchor, geom, timestamp, timestamp);
  const row = getComment(db, project.id, commentId)!;
  return jsonResponse(toComment(db, project, row), 201, origin);
}

async function patchComment(db: Db, project: Project, commentId: string, request: Request, origin: string | null): Promise<Response> {
  const body = await jsonBody(request);
  const allowed = new Set(["text", "resolved", "color", "reply", "editReply", "deleteReply"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) httpError(400, "invalid_input", `${key} cannot be changed`);
  }
  const row = getComment(db, project.id, commentId);
  if (!row) httpError(404, "not_found", "comment not found");
  const timestamp = now();
  withTransaction(db, () => {
    let text = row.text;
    let color = row.color;
    let resolved = Boolean(row.resolved);
    const replies = parseJson<Reply[]>(row.replies_json, []);

    if (body.text !== undefined) text = requiredString(body.text, "text", MAX_TEXT);
    if (body.color !== undefined) color = validateColor(body.color);
    if (body.resolved !== undefined) {
      if (typeof body.resolved !== "boolean") httpError(400, "invalid_input", "resolved must be a boolean");
      resolved = body.resolved;
    }
    if (body.reply !== undefined) replies.push(validateReply(body.reply));
    if (body.editReply !== undefined) {
      if (!isRecord(body.editReply)) httpError(400, "invalid_input", "editReply must be an object");
      const replyId = requiredString(body.editReply.id, "editReply.id", 200);
      const reply = replies.find((candidate) => candidate.id === replyId);
      if (!reply) httpError(404, "not_found", "reply not found");
      if (body.editReply.text !== undefined) reply.text = requiredString(body.editReply.text, "editReply.text", MAX_TEXT);
      reply.updatedAt = timestamp;
    }
    if (body.deleteReply !== undefined) {
      const replyId = typeof body.deleteReply === "string"
        ? requiredString(body.deleteReply, "deleteReply", 200)
        : isRecord(body.deleteReply) ? requiredString(body.deleteReply.id, "deleteReply.id", 200) : "";
      if (!replyId) httpError(400, "invalid_input", "deleteReply is invalid");
      if (!replies.some((reply) => reply.id === replyId)) httpError(404, "not_found", "reply not found");
      replies.splice(replies.findIndex((reply) => reply.id === replyId), 1);
      db.query("DELETE FROM images WHERE project_id = ? AND comment_id = ? AND reply_id = ?")
        .run(project.id, commentId, replyId);
    }
    db.query(
      "UPDATE comments SET text = ?, color = ?, resolved = ?, replies_json = ?, updated_at = ? WHERE project_id = ? AND id = ?",
    ).run(text, color, resolved ? 1 : 0, JSON.stringify(replies), timestamp, project.id, commentId);
  });
  const updated = getComment(db, project.id, commentId)!;
  return jsonResponse(toComment(db, project, updated), 200, origin);
}

function deleteComment(db: Db, project: Project, commentId: string, origin: string | null): Response {
  const row = getComment(db, project.id, commentId);
  if (!row) httpError(404, "not_found", "comment not found");
  withTransaction(db, () => {
    db.query("DELETE FROM images WHERE project_id = ? AND comment_id = ?").run(project.id, commentId);
    db.query("DELETE FROM comments WHERE project_id = ? AND id = ?").run(project.id, commentId);
  });
  return jsonResponse({ deleted: true, id: commentId }, 200, origin);
}

export type CommentApp = {
  db: Db;
  fetch: (request: Request) => Promise<Response>;
  close: () => void;
};

export function createApp(options: AppOptions = {}): CommentApp {
  const db = createDatabase(options.dbPath);
  const staticRoot = options.staticRoot || resolve(import.meta.dir, "..");

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = originFromRequest(request);
    const routeIsApi = url.pathname.startsWith("/v1/");
    const allowCors = origin ? hasOrigin(db, origin) : false;
    let authorizedOrigin: string | null = null;
    const requireAuthorization = (imageQuery = false): Authorized => {
      const auth = authorize(db, request, imageQuery);
      authorizedOrigin = auth.origin;
      return auth;
    };

    try {
      if (request.method === "OPTIONS") {
        if (origin && !allowCors) httpError(403, "origin_not_allowed", "origin is not allowed");
        const headers = new Headers();
        if (origin) applyCors(headers, origin);
        return new Response(null, { status: 204, headers });
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }
      if (request.method === "GET" && ["/", "/index.html", "/embed.js", "/embed.css", "/emoji-data.json", "/annotate.js"].includes(url.pathname)) {
        return await staticResponse(staticRoot, url.pathname, origin, allowCors);
      }
      if (!routeIsApi) return jsonResponse({ error: { code: "not_found", message: "route not found" } }, 404);

      const parts = parsePath(url.pathname);
      if (parts[0] !== "v1") return jsonResponse({ error: { code: "not_found", message: "route not found" } }, 404);

      if (parts[1] === "comments" && parts.length === 2) {
        const auth = requireAuthorization();
        if (request.method === "GET") {
          const page = url.searchParams.get("page");
          if (!page) httpError(400, "invalid_input", "page is required");
          if (characterCount(page) > MAX_PAGE) httpError(400, "invalid_input", "page is too long");
          return listComments(db, auth.project, page, auth.origin);
        }
        if (request.method === "POST") return await createComment(db, auth.project, request, auth.origin);
        httpError(405, "method_not_allowed", "method is not allowed");
      }

      if (parts[1] === "comments" && parts.length === 3) {
        const auth = requireAuthorization();
        const commentId = parts[2];
        if (!commentId) httpError(400, "invalid_path", "comment id is required");
        if (request.method === "PATCH") return await patchComment(db, auth.project, commentId, request, auth.origin);
        if (request.method === "DELETE") return deleteComment(db, auth.project, commentId, auth.origin);
        httpError(405, "method_not_allowed", "method is not allowed");
      }

      if (parts[1] === "comments" && parts.length === 4 && parts[3] === "images") {
        const auth = requireAuthorization();
        if (request.method !== "POST") httpError(405, "method_not_allowed", "method is not allowed");
        return await uploadImage(db, auth.project, parts[2], request, auth.origin);
      }

      if (parts[1] === "images" && parts.length === 3) {
        const auth = requireAuthorization(true);
        if (request.method !== "GET") httpError(405, "method_not_allowed", "method is not allowed");
        return imageResponse(db, auth.project, parts[2], auth.origin);
      }

      return jsonResponse({ error: { code: "not_found", message: "route not found" } }, 404, origin && allowCors ? origin : null);
    } catch (error) {
      if (!(error instanceof HttpError) && error instanceof Error) {
        // Keep internals out of the public response; the process supervisor owns logging.
      }
      return errorResponse(error, authorizedOrigin, Boolean(authorizedOrigin));
    }
  };

  return { db, fetch, close: () => db.close() };
}
