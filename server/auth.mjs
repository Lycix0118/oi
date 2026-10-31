import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
export const tokenHash = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

export function credentials(body) {
  const username =
    typeof body?.username === "string"
      ? body.username.trim().normalize("NFKC")
      : "";
  const password = body?.password;
  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username))
    throw new Error("用户名需为 2–32 个中文、字母、数字、下划线或短横线");
  if (
    typeof password !== "string" ||
    password.length < 6 ||
    password.length > 128
  )
    throw new Error("密码需为 6–128 个字符");
  return { username, key: username.toLowerCase(), password };
}
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64, options);
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password, hash) {
  const [salt, expected] = (
    hash || `${"0".repeat(32)}:${"0".repeat(128)}`
  ).split(":");
  const key = await scrypt(password, salt, 64, options);
  return crypto.timingSafeEqual(key, Buffer.from(expected, "hex"));
}
export function readSession(req) {
  const cookie = (req.headers.cookie || "")
    .split(";")
    .find((part) => part.trim().startsWith("oi_session="));
  const token = cookie?.trim().slice("oi_session=".length);
  return token && /^[a-f0-9]{64}$/.test(token) ? tokenHash(token) : null;
}
export function setSessionCookie(req, res, token, maxAge = sessionLifetime) {
  res.cookie("oi_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    path: "/",
    maxAge,
  });
}
