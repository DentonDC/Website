const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  child_name TEXT,
  group_name TEXT,
  role TEXT NOT NULL,
  login_code_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  role TEXT NOT NULL,
  created_by TEXT,
  used_by TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS collections (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  amount_cents INTEGER NOT NULL,
  due_date TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  collection_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS treasury (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  receipt_url TEXT,
  payment_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  url TEXT,
  body TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS students (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  birthdate TEXT NOT NULL,
  group_name TEXT,
  parent_id TEXT,
  created_at TEXT NOT NULL
);
`;

async function ensureColumn(db, table, column, type) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  } catch {
    /* column already exists */
  }
}

export async function ensureSchema(db) {
  const statements = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
  for (const sql of statements) {
    await db.prepare(sql).run();
  }
  await ensureColumn(db, "users", "phone", "TEXT");
  await ensureColumn(db, "users", "child_birthdate", "TEXT");
}

export function parseBirthdate(value) {
  const raw = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const stamp = Date.parse(raw + "T00:00:00Z");
  if (!Number.isFinite(stamp)) return null;
  const now = Date.now();
  if (stamp > now) return null;
  if (stamp < Date.parse("1995-01-01T00:00:00Z")) return null;
  return raw;
}

export function parsePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return raw;
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId() {
  return crypto.randomUUID();
}

export function rublesToCents(value) {
  const n = Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    child_name: row.child_name || "",
    group_name: row.group_name || "",
    role: row.role,
    created_at: row.created_at,
  };
}

export async function logAction(db, actorId, action, entity, entityId, details) {
  await db
    .prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(newId(), actorId, action, entity, entityId || null, details || null, nowIso())
    .run();
}
