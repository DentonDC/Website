import { canInvite, canManageMoney, canPublish, codeHint, getSessionUser, hashCode, isRole, makeCode, requireRole, requireUser } from "../functions/_lib/auth.js";
import { ensureSchema, logAction, newId, nowIso, publicUser, rublesToCents } from "../functions/_lib/db.js";
import { clearCookie, cookieHeader, errorResponse, HttpError, json, readBody } from "../functions/_lib/http.js";

export async function handleApi(request, env) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (!env.DB) {
    return json({ error: "db_unavailable", local: true }, 503);
  }

  try {
    await ensureSchema(env.DB);
    const url = new URL(request.url);
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const key = `${request.method}:${parts.join("/")}`;
    const body = request.method === "GET" || request.method === "HEAD" ? {} : await readBody(request);
    return await route(env, request, parts, key, body, url);
  } catch (error) {
    return errorResponse(error);
  }
}

async function route(env, request, parts, key, body, url) {
  if (key === "GET:session") return session(env, request);
  if (key === "POST:setup") return setup(env, request, body);
  if (key === "POST:join") return join(env, request, body);
  if (key === "POST:login") return login(env, request, body);
  if (key === "POST:logout") return logout(request);

  const user = await requireUser(env, request);

  if (key === "GET:members") return members(env);
  if (key === "POST:invites") return createInvite(env, user, body);
  if (key === "GET:invites") return listInvites(env, user);

  if (key === "GET:announcements") return listAnnouncements(env);
  if (key === "POST:announcements") return createAnnouncement(env, user, body);
  if (request.method === "DELETE" && parts[0] === "announcements" && parts[1]) {
    return deleteAnnouncement(env, user, parts[1]);
  }

  if (key === "GET:collections") return listCollections(env);
  if (key === "POST:collections") return createCollection(env, user, body);
  if (request.method === "GET" && parts[0] === "collections" && parts[1] && !parts[2]) {
    return collectionDetail(env, parts[1]);
  }
  if (request.method === "POST" && parts[0] === "collections" && parts[2] === "payments") {
    return addPayment(env, user, parts[1], body);
  }
  if (request.method === "POST" && parts[0] === "collections" && parts[2] === "close") {
    return closeCollection(env, user, parts[1]);
  }

  if (key === "GET:treasury") return listTreasury(env);
  if (key === "POST:treasury") return addTreasury(env, user, body);

  if (key === "GET:documents") return listDocuments(env);
  if (key === "POST:documents") return createDocument(env, user, body);
  if (request.method === "DELETE" && parts[0] === "documents" && parts[1]) {
    return deleteDocument(env, user, parts[1]);
  }

  if (key === "GET:log") return listLog(env, user, url);

  throw new HttpError(404, "not_found");
}

function isSecure(request) {
  return new URL(request.url).protocol === "https:";
}

async function createSession(env, request, userId) {
  const token = newId();
  const created = nowIso();
  const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  )
    .bind(token, userId, created, expires)
    .run();
  return json(
    { ok: true, user: publicUser(await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first()) },
    200,
    { "Set-Cookie": cookieHeader(token, isSecure(request)) }
  );
}

async function userCount(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  return Number(row?.n || 0);
}

async function session(env, request) {
  const user = await getSessionUser(env, request);
  return json({
    user: publicUser(user),
    needs_setup: (await userCount(env)) === 0,
    db: true,
  });
}

async function setup(env, request, body) {
  if ((await userCount(env)) > 0) throw new HttpError(409, "already_setup");
  const name = String(body.name || "").trim();
  if (name.length < 2) throw new HttpError(400, "name_required");
  const id = newId();
  const loginCode = makeCode();
  await env.DB.prepare(
    `INSERT INTO users (id, name, child_name, group_name, role, login_code_hash, created_at)
     VALUES (?, ?, ?, ?, 'admin', ?, ?)`
  )
    .bind(id, name, String(body.child_name || "").trim(), String(body.group_name || "").trim(), await hashCode(loginCode), nowIso())
    .run();
  await logAction(env.DB, id, "setup", "user", id, name);
  const response = await createSession(env, request, id);
  const data = await response.json();
  return json(
    { ...data, login_code: loginCode },
    200,
    { "Set-Cookie": response.headers.get("Set-Cookie") }
  );
}

async function join(env, request, body) {
  const code = String(body.code || "").trim();
  const name = String(body.name || "").trim();
  if (!code || name.length < 2) throw new HttpError(400, "invalid_join");
  const invite = await env.DB.prepare("SELECT * FROM invites WHERE code_hash = ? AND used_at IS NULL")
    .bind(await hashCode(code))
    .first();
  if (!invite) throw new HttpError(404, "invite_not_found");
  const id = newId();
  const loginCode = makeCode();
  await env.DB.prepare(
    `INSERT INTO users (id, name, child_name, group_name, role, login_code_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, name, String(body.child_name || "").trim(), String(body.group_name || "").trim(), invite.role, await hashCode(loginCode), nowIso())
    .run();
  await env.DB.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?")
    .bind(id, nowIso(), invite.id)
    .run();
  await logAction(env.DB, id, "join", "user", id, `${name} (${invite.role})`);
  const response = await createSession(env, request, id);
  const data = await response.json();
  return json(
    { ...data, login_code: loginCode },
    200,
    { "Set-Cookie": response.headers.get("Set-Cookie") }
  );
}

async function login(env, request, body) {
  const hash = await hashCode(body.code);
  const user = await env.DB.prepare("SELECT * FROM users WHERE login_code_hash = ?").bind(hash).first();
  if (!user) throw new HttpError(401, "invalid_code");
  await logAction(env.DB, user.id, "login", "session", user.id, null);
  return createSession(env, request, user.id);
}

async function logout(request) {
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie(isSecure(request)) });
}

async function members(env) {
  const rows = await env.DB.prepare("SELECT id, name, child_name, group_name, role, created_at FROM users ORDER BY created_at").all();
  return json({ members: rows.results || [] });
}

async function createInvite(env, user, body) {
  requireRole(user, canInvite);
  const role = isRole(body.role) ? body.role : "parent";
  const code = makeCode();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO invites (id, code_hash, code_hint, role, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, await hashCode(code), codeHint(code), role, user.id, nowIso())
    .run();
  await logAction(env.DB, user.id, "invite_create", "invite", id, role);
  return json({ id, code, role });
}

async function listInvites(env, user) {
  requireRole(user, canInvite);
  const rows = await env.DB.prepare(
    `SELECT id, code_hint, role, used_at, created_at FROM invites ORDER BY created_at DESC LIMIT 50`
  ).all();
  return json({ invites: rows.results || [] });
}

async function listAnnouncements(env) {
  const rows = await env.DB.prepare(
    `SELECT a.*, u.name AS author_name
     FROM announcements a JOIN users u ON u.id = a.author_id
     ORDER BY a.created_at DESC LIMIT 100`
  ).all();
  return json({ announcements: rows.results || [] });
}

async function createAnnouncement(env, user, body) {
  requireRole(user, canPublish);
  const title = String(body.title || "").trim();
  const text = String(body.body || "").trim();
  if (!title || !text) throw new HttpError(400, "invalid_announcement");
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO announcements (id, title, body, author_id, created_at) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, title, text, user.id, nowIso())
    .run();
  await logAction(env.DB, user.id, "announce_create", "announcement", id, title);
  return json({ id });
}

async function deleteAnnouncement(env, user, id) {
  requireRole(user, canPublish);
  await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(id).run();
  await logAction(env.DB, user.id, "announce_delete", "announcement", id, null);
  return json({ ok: true });
}

async function collectionProgress(env, collection) {
  const paid = await env.DB.prepare(
    `SELECT user_id, SUM(amount_cents) AS paid_cents FROM payments WHERE collection_id = ? GROUP BY user_id`
  )
    .bind(collection.id)
    .all();
  const people = await env.DB.prepare("SELECT id, name, child_name, role FROM users ORDER BY name").all();
  const byUser = new Map((paid.results || []).map((row) => [row.user_id, Number(row.paid_cents || 0)]));
  const members = (people.results || []).map((person) => {
    const paidCents = byUser.get(person.id) || 0;
    const status = paidCents >= collection.amount_cents ? "paid" : paidCents > 0 ? "partial" : "unpaid";
    return { ...person, paid_cents: paidCents, status };
  });
  const totalPaid = members.reduce((sum, person) => sum + person.paid_cents, 0);
  return { ...collection, members, total_paid_cents: totalPaid };
}

async function listCollections(env) {
  const rows = await env.DB.prepare("SELECT * FROM collections ORDER BY created_at DESC").all();
  const items = [];
  for (const collection of rows.results || []) {
    items.push(await collectionProgress(env, collection));
  }
  return json({ collections: items });
}

async function createCollection(env, user, body) {
  requireRole(user, canManageMoney);
  const title = String(body.title || "").trim();
  const amountCents = rublesToCents(body.amount);
  if (!title || amountCents === null || amountCents <= 0) throw new HttpError(400, "invalid_collection");
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO collections (id, title, description, amount_cents, due_date, created_by, created_at, closed)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  )
    .bind(id, title, String(body.description || "").trim(), amountCents, body.due_date || null, user.id, nowIso())
    .run();
  await logAction(env.DB, user.id, "collection_create", "collection", id, title);
  return json({ id });
}

async function collectionDetail(env, id) {
  const collection = await env.DB.prepare("SELECT * FROM collections WHERE id = ?").bind(id).first();
  if (!collection) throw new HttpError(404, "not_found");
  return json({ collection: await collectionProgress(env, collection) });
}

async function addPayment(env, user, collectionId, body) {
  requireRole(user, canManageMoney);
  const collection = await env.DB.prepare("SELECT * FROM collections WHERE id = ?").bind(collectionId).first();
  if (!collection || collection.closed) throw new HttpError(400, "collection_closed");
  const amountCents = rublesToCents(body.amount);
  const payerId = String(body.user_id || "").trim();
  if (!payerId || amountCents === null || amountCents <= 0) throw new HttpError(400, "invalid_payment");
  const payer = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(payerId).first();
  if (!payer) throw new HttpError(404, "member_not_found");
  const paymentId = newId();
  const created = nowIso();
  await env.DB.prepare(
    `INSERT INTO payments (id, collection_id, user_id, amount_cents, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(paymentId, collectionId, payerId, amountCents, user.id, created)
    .run();
  await env.DB.prepare(
    `INSERT INTO treasury (id, kind, title, amount_cents, receipt_url, payment_id, created_by, created_at)
     VALUES (?, 'income', ?, ?, NULL, ?, ?, ?)`
  )
    .bind(newId(), `${collection.title} — ${payer.name}`, amountCents, paymentId, user.id, created)
    .run();
  await logAction(env.DB, user.id, "payment_add", "payment", paymentId, `${payer.name}: ${amountCents}`);
  return json({ id: paymentId });
}

async function closeCollection(env, user, id) {
  requireRole(user, canManageMoney);
  await env.DB.prepare("UPDATE collections SET closed = 1 WHERE id = ?").bind(id).run();
  await logAction(env.DB, user.id, "collection_close", "collection", id, null);
  return json({ ok: true });
}

async function listTreasury(env) {
  const rows = await env.DB.prepare(
    `SELECT t.*, u.name AS author_name FROM treasury t
     JOIN users u ON u.id = t.created_by
     ORDER BY t.created_at DESC LIMIT 200`
  ).all();
  const items = rows.results || [];
  const balance = items.reduce((sum, row) => sum + (row.kind === "income" ? row.amount_cents : -row.amount_cents), 0);
  return json({ items, balance_cents: balance });
}

async function addTreasury(env, user, body) {
  requireRole(user, canManageMoney);
  const title = String(body.title || "").trim();
  const kind = body.kind === "expense" ? "expense" : "income";
  const amountCents = rublesToCents(body.amount);
  if (!title || amountCents === null || amountCents <= 0) throw new HttpError(400, "invalid_treasury");
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO treasury (id, kind, title, amount_cents, receipt_url, payment_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(id, kind, title, amountCents, String(body.receipt_url || "").trim() || null, user.id, nowIso())
    .run();
  await logAction(env.DB, user.id, "treasury_add", "treasury", id, `${kind} ${title}`);
  return json({ id });
}

async function listDocuments(env) {
  const rows = await env.DB.prepare(
    `SELECT d.*, u.name AS author_name FROM documents d
     JOIN users u ON u.id = d.created_by
     ORDER BY d.created_at DESC`
  ).all();
  return json({ documents: rows.results || [] });
}

async function createDocument(env, user, body) {
  requireRole(user, canPublish);
  const title = String(body.title || "").trim();
  if (!title) throw new HttpError(400, "invalid_document");
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO documents (id, title, description, url, body, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      title,
      String(body.description || "").trim(),
      String(body.url || "").trim(),
      String(body.body || "").trim(),
      user.id,
      nowIso()
    )
    .run();
  await logAction(env.DB, user.id, "document_create", "document", id, title);
  return json({ id });
}

async function deleteDocument(env, user, id) {
  requireRole(user, canPublish);
  await env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(id).run();
  await logAction(env.DB, user.id, "document_delete", "document", id, null);
  return json({ ok: true });
}

async function listLog(env, user, url) {
  requireRole(user, (u) => u.role === "admin" || u.role === "treasurer" || u.role === "member");
  const limit = Math.min(200, Number(url.searchParams.get("limit") || 100));
  const rows = await env.DB.prepare(
    `SELECT l.*, u.name AS actor_name FROM audit_log l
     JOIN users u ON u.id = l.actor_id
     ORDER BY l.created_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return json({ items: rows.results || [] });
}
