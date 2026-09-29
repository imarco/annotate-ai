import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createApp, type CommentApp } from "../server/app";
import { createProject, type Project } from "../server/db";

const ALPHA_ORIGIN = "https://alpha.example";
const BETA_ORIGIN = "https://beta.example";

let app: CommentApp;
let alpha: Project;
let beta: Project;

beforeEach(() => {
  app = createApp({ dbPath: ":memory:" });
  alpha = createProject(app.db, "Alpha", [ALPHA_ORIGIN]);
  beta = createProject(app.db, "Beta", [BETA_ORIGIN]);
});

afterEach(() => app.close());

function call(path: string, key = alpha.siteKey, origin: string | null = ALPHA_ORIGIN, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (key) headers.set("X-Annotate-Key", key);
  if (origin) headers.set("Origin", origin);
  return app.fetch(new Request(`http://service.test${path}`, { ...init, headers }));
}

async function createAlphaComment(text = "Needs a closer look") {
  const response = await call("/v1/comments", alpha.siteKey, ALPHA_ORIGIN, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      page: "/review",
      author: "Reviewer",
      text,
      type: "note",
      color: "#123456",
      anchor: { exact: "A sentence" },
      geom: { x: 0.1, y: 0.2 },
    }),
  });
  expect(response.status).toBe(201);
  return await response.json();
}

describe("comment service authorization", () => {
  test("requires the project key and enforces the registered origin", async () => {
    const allowed = await call("/v1/comments?page=%2Freview");
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALPHA_ORIGIN);

    const missing = await app.fetch(new Request("http://service.test/v1/comments?page=%2Freview", {
      headers: { Origin: ALPHA_ORIGIN },
    }));
    expect(missing.status).toBe(401);

    const wrongKey = await call("/v1/comments?page=%2Freview", "not-a-key", ALPHA_ORIGIN);
    expect(wrongKey.status).toBe(401);

    const wrongOrigin = await call("/v1/comments?page=%2Freview", alpha.siteKey, BETA_ORIGIN);
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await app.fetch(new Request("http://service.test/v1/comments", {
      method: "OPTIONS",
      headers: {
        Origin: ALPHA_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-annotate-key",
      },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(ALPHA_ORIGIN);

    const cliRequest = await call("/v1/comments?page=%2Freview", alpha.siteKey, null);
    expect(cliRequest.status).toBe(200);
  });
});

describe("comment and reply CRUD", () => {
  test("isolates projects and supports reply, edit, resolve and delete operations", async () => {
    const comment = await createAlphaComment();

    const alphaList = await call("/v1/comments?page=%2Freview");
    expect((await alphaList.json()).comments).toHaveLength(1);

    const betaList = await call("/v1/comments?page=%2Freview", beta.siteKey, BETA_ORIGIN);
    expect((await betaList.json()).comments).toHaveLength(0);

    const foreignPatch = await call(`/v1/comments/${comment.id}`, beta.siteKey, BETA_ORIGIN, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resolved: true }),
    });
    expect(foreignPatch.status).toBe(404);

    const addReply = await call(`/v1/comments/${comment.id}`, alpha.siteKey, ALPHA_ORIGIN, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: { author: "Second reviewer", text: "I agree." } }),
    });
    expect(addReply.status).toBe(200);
    const withReply = await addReply.json();
    expect(withReply.replies).toHaveLength(1);
    const replyId = withReply.replies[0].id;

    const edit = await call(`/v1/comments/${comment.id}`, alpha.siteKey, ALPHA_ORIGIN, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ editReply: { id: replyId, text: "Updated reply" }, resolved: true }),
    });
    expect(edit.status).toBe(200);
    const edited = await edit.json();
    expect(edited.resolved).toBe(true);
    expect(edited.replies[0].text).toBe("Updated reply");

    const forbiddenChange = await call(`/v1/comments/${comment.id}`, alpha.siteKey, ALPHA_ORIGIN, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "/other-page" }),
    });
    expect(forbiddenChange.status).toBe(400);

    const removeReply = await call(`/v1/comments/${comment.id}`, alpha.siteKey, ALPHA_ORIGIN, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deleteReply: replyId }),
    });
    expect((await removeReply.json()).replies).toHaveLength(0);

    const deleted = await call(`/v1/comments/${comment.id}`, alpha.siteKey, ALPHA_ORIGIN, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, id: comment.id });

    const afterDelete = await call("/v1/comments?page=%2Freview");
    expect((await afterDelete.json()).comments).toHaveLength(0);
  });

  test("rejects invalid comment fields at the trust boundary", async () => {
    const tooLong = await call("/v1/comments", alpha.siteKey, ALPHA_ORIGIN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "/review", author: "A", text: "x".repeat(5001) }),
    });
    expect(tooLong.status).toBe(400);

    const invalidType = await call("/v1/comments", alpha.siteKey, ALPHA_ORIGIN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "/review", author: "A", text: "x", type: "script" }),
    });
    expect(invalidType.status).toBe(400);

    const invalidColor = await call("/v1/comments", alpha.siteKey, ALPHA_ORIGIN, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ page: "/review", author: "A", text: "x", color: "red" }),
    });
    expect(invalidColor.status).toBe(400);
  });
});

describe("SQLite image blobs", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

  test("stores comment and reply images in SQLite and serves the BLOB back", async () => {
    const comment = await createAlphaComment();
    const addReply = await call(`/v1/comments/${comment.id}`, alpha.siteKey, ALPHA_ORIGIN, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reply: { author: "Reply author", text: "Reply" } }),
    });
    const replyId = (await addReply.json()).replies[0].id;

    const form = new FormData();
    form.set("image", new File([png], "comment.png", { type: "image/png" }));
    const upload = await call(`/v1/comments/${comment.id}/images`, alpha.siteKey, ALPHA_ORIGIN, {
      method: "POST",
      body: form,
    });
    expect(upload.status).toBe(201);
    const image = await upload.json();
    expect(image.mime).toBe("image/png");
    expect(image.size).toBe(png.byteLength);

    const replyForm = new FormData();
    replyForm.set("image", new File([png], "reply.png", { type: "image/png" }));
    replyForm.set("replyId", replyId);
    const replyUpload = await call(`/v1/comments/${comment.id}/images`, alpha.siteKey, ALPHA_ORIGIN, {
      method: "POST",
      body: replyForm,
    });
    expect(replyUpload.status).toBe(201);

    const read = await app.fetch(new Request(`http://service.test${image.url}`, {
      headers: { Origin: ALPHA_ORIGIN },
    }));
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(png);

    const attached = await call("/v1/comments?page=%2Freview");
    const stored = (await attached.json()).comments[0];
    expect(stored.images).toHaveLength(1);
    expect(stored.replies[0].images).toHaveLength(1);

    const foreignImage = await app.fetch(new Request(`http://service.test${image.url.replace(alpha.siteKey, beta.siteKey)}`, {
      headers: { Origin: BETA_ORIGIN },
    }));
    expect(foreignImage.status).toBe(404);
  });

  test("rejects SVG, mismatched magic and oversized images", async () => {
    const comment = await createAlphaComment();
    const svg = new FormData();
    svg.set("image", new File(["<svg></svg>"], "x.svg", { type: "image/svg+xml" }));
    const svgResponse = await call(`/v1/comments/${comment.id}/images`, alpha.siteKey, ALPHA_ORIGIN, { method: "POST", body: svg });
    expect(svgResponse.status).toBe(415);

    const mismatch = new FormData();
    mismatch.set("image", new File([png], "x.jpg", { type: "image/jpeg" }));
    const mismatchResponse = await call(`/v1/comments/${comment.id}/images`, alpha.siteKey, ALPHA_ORIGIN, { method: "POST", body: mismatch });
    expect(mismatchResponse.status).toBe(415);

    const oversized = new FormData();
    oversized.set("image", new File([new Uint8Array(5 * 1024 * 1024 + 1)], "x.png", { type: "image/png" }));
    const oversizedResponse = await call(`/v1/comments/${comment.id}/images`, alpha.siteKey, ALPHA_ORIGIN, { method: "POST", body: oversized });
    expect(oversizedResponse.status).toBe(413);
  });
});

