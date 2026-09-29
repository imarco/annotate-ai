import { createDatabase, createProject } from "./db";

function usage(): never {
  console.error("Usage: bun server/cli.ts create-project --name <name> --origin <origin> [--origin <origin> ...]");
  process.exit(2);
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("origin must be a valid http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("origin must contain only an http(s) origin");
  }
  return parsed.origin;
}

function parseArgs(args: string[]): { name: string; origins: string[] } {
  if (args.shift() !== "create-project") usage();
  let name = "";
  const origins: string[] = [];
  while (args.length) {
    const flag = args.shift();
    if (flag === "--name") {
      name = args.shift() || "";
      continue;
    }
    if (flag === "--origin") {
      const origin = args.shift();
      if (!origin) usage();
      origins.push(normalizeOrigin(origin));
      continue;
    }
    if (flag?.startsWith("--name=")) {
      name = flag.slice("--name=".length);
      continue;
    }
    if (flag?.startsWith("--origin=")) {
      origins.push(normalizeOrigin(flag.slice("--origin=".length)));
      continue;
    }
    usage();
  }
  if (!name.trim() || Array.from(name).length > 100) throw new Error("name is required and must be at most 100 characters");
  const uniqueOrigins = [...new Set(origins)];
  if (!uniqueOrigins.length) throw new Error("at least one --origin is required");
  return { name, origins: uniqueOrigins };
}

if (import.meta.main) {
  try {
    const { name, origins } = parseArgs(process.argv.slice(2));
    const db = createDatabase();
    try {
      const project = createProject(db, name, origins);
      console.log(JSON.stringify({
        id: project.id,
        name: project.name,
        origins: project.origins,
        key: project.siteKey,
        createdAt: project.createdAt,
      }));
      const publicUrl = (process.env.ANNOTATE_PUBLIC_URL || "https://<comment-service-host>:18767").replace(/\/$/, "");
      console.log(`<script src="${publicUrl}/embed.js" data-key="${project.siteKey}" defer></script>`);
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "could not create project");
    process.exit(1);
  }
}
