import { HttpError, readCookie } from "./http.js";
import { nowIso } from "./db.js";

const ROLES = new Set(["admin", "treasurer", "member", "parent"]);

export function isRole(value) {
  return ROLES.has(value);
}

export function canManageMoney(user) {
  return user.role === "admin" || user.role === "treasurer";
}

export function canInvite(user) {
  return user.role === "admin";
}

export function canPublish(user) {
  return user.role === "admin" || user.role === "treasurer" || user.role === "member";
}

export async function hashCode(code) {
  const normalized = String(code || "").replace(/\s+/g, "").toUpperCase();
  const data = new TextEncoder().encode(normalized);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += chars[byte % chars.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export function codeHint(code) {
  return String(code).slice(-4);
}

export async function getSessionUser(env, request) {
  const token = readCookie(request, "sid");
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT users.* FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token = ? AND sessions.expires_at > ?`
  )
    .bind(token, nowIso())
    .first();
  return row || null;
}

export async function requireUser(env, request) {
  const user = await getSessionUser(env, request);
  if (!user) throw new HttpError(401, "unauthorized");
  return user;
}

export function requireRole(user, check) {
  if (!check(user)) throw new HttpError(403, "forbidden");
}
