require("dotenv").config();

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { z } = require("zod");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- App & Security ---------- */
app.set("trust proxy", 1); // correct client IPs behind proxies

const originList = (process.env.CORS_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: process.env.NODE_ENV === "production" ? {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "connect-src": ["'self'", ...(process.env.CLIENT_ORIGIN ? [process.env.CLIENT_ORIGIN] : [])],
    }
  } : false
}));

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (originList.includes(origin)) return cb(null, true);
    return cb(new Error("CORS: Origin not allowed"));
  },
  credentials: true,
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

app.use(express.json());
app.use(cookieParser());

/* ---------- DB ---------- */
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASS || "",
  database: process.env.DB_NAME || "sis_db",
  port: Number(process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10
});

/* ---------- Schemas ---------- */
const StudentSchema = z.object({
  name: z.string().trim().min(1).max(100),
  course: z.string().trim().min(1).max(100),
  year: z.enum(["1","2","3","4","5"]),            // stricter
  grade: z.enum(["A","B","C","D","F","INC"]),     // adjust to your scale
});

const AuthSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6)
});

const CreateUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["admin","student"]),
  student_id: z.number().int().positive().nullable().optional()
});

const UpdateUserSchema = z.object({
  role: z.enum(["admin","student"]).optional(),
  student_id: z.union([z.number().int().positive(), z.null()]).optional(),
  password: z.string().min(8).optional()
});

/* ---------- Auth helpers ---------- */
const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || "15m";
const REFRESH_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7);

function signAccessToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_TTL });
}
function signRefreshToken(payload) {
  return jwt.sign(payload, process.env.REFRESH_SECRET, { expiresIn: `${REFRESH_TTL_DAYS}d` });
}
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const cookieOptions = {
  httpOnly: true,
  sameSite: process.env.COOKIE_SAMESITE || "lax",
  secure: String(process.env.COOKIE_SECURE) === "true",
  domain: process.env.COOKIE_DOMAIN || undefined,
  path: "/",
};

// double-submit CSRF helper: issue refresh cookie + non-HttpOnly CSRF
function setRefreshCookies(res, refreshToken) {
  res.cookie("rt", refreshToken, { ...cookieOptions, maxAge: REFRESH_TTL_DAYS*24*60*60*1000 });
  res.cookie("csrf_refresh", sha256(refreshToken).slice(0, 24), { ...cookieOptions, httpOnly: false, maxAge: REFRESH_TTL_DAYS*24*60*60*1000 });
}

// CSRF check for refresh endpoint
function requireCsrf(req, res, next) {
  const header = req.get("x-csrf-refresh");
  const cookie = req.cookies?.csrf_refresh;
  if (!header || !cookie || header !== cookie) return res.status(403).json({ error: "CSRF" });
  next();
}

/* ---------- Audit helper ---------- */
async function audit(req, { action, targetType, targetId, details }) {
  try {
    const actor = req.user ?? null;
    await pool.query(
      "INSERT INTO audit_logs (actor_user_id, actor_role, action, target_type, target_id, ip, user_agent, details) VALUES (?,?,?,?,?,?,?,?)",
      [
        actor?.uid ?? null,
        actor?.role ?? null,
        action,
        targetType || null,
        targetId != null ? String(targetId) : null,
        (req.ip || "").slice(0,45),
        (req.get("user-agent") || "").slice(0,255),
        details ? JSON.stringify(details) : null
      ]
    );
  } catch (e) {
    console.error("Audit log error:", e.message);
  }
}

/* ---------- Middleware ---------- */
function authenticate(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid/expired token" });
  }
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}
function requireAdminOrSelfByParamId(paramName = "id") {
  return (req, res, next) => {
    const id = Number(req.params[paramName]);
    if (req.user.role === "admin") return next();
    if (req.user.role === "student" && req.user.studentId === id) return next();
    return res.status(403).json({ error: "Forbidden" });
  };
}

/* ---------- Rate limiting ---------- */
const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});
const refreshLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

/* ---------- Routes ---------- */
app.get("/", (_req, res) => res.send("Welcome to the Student Information System API"));

/* --- Auth: Login (access + refresh cookie) --- */
app.post("/api/auth/login", loginLimiter, async (req, res) => {
  const parse = AuthSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: "Invalid credentials" });

  const { email, password } = parse.data;
  const [rows] = await pool.query("SELECT * FROM users WHERE email=?", [email]);
  const user = rows[0];
  if (!user) return res.status(401).json({ error: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Invalid credentials" });

  const accessPayload = { uid: user.id, role: user.role, studentId: user.student_id };
  const accessToken = signAccessToken(accessPayload);

  const refreshToken = signRefreshToken({ uid: user.id });
  const tokenHash = sha256(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS*24*60*60*1000);
  await pool.query(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip) VALUES (?,?,?,?,?)",
    [user.id, tokenHash, expiresAt, (req.get("user-agent")||"").slice(0,255), (req.ip||"").slice(0,45)]
  );

  setRefreshCookies(res, refreshToken);
  await audit(req, { action: "AUTH_LOGIN", targetType: "user", targetId: user.id, details: { email } });
  res.json({ token: accessToken, role: user.role });
});

/* --- Auth: Refresh (rotation + CSRF) --- */
app.post("/api/auth/refresh", refreshLimiter, requireCsrf, async (req, res) => {
  const refreshToken = req.cookies?.rt;
  if (!refreshToken) return res.status(401).json({ error: "Missing refresh token" });

  try {
    const decoded = jwt.verify(refreshToken, process.env.REFRESH_SECRET);
    const tokenHash = sha256(refreshToken);
    const [rows] = await pool.query("SELECT * FROM refresh_tokens WHERE token_hash=? AND revoked_at IS NULL", [tokenHash]);
    const record = rows[0];
    if (!record || new Date(record.expires_at) < new Date())
      return res.status(401).json({ error: "Refresh token expired/revoked" });

    // rotate
    await pool.query("UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=?", [record.id]);

    const newRefresh = signRefreshToken({ uid: decoded.uid });
    const newHash = sha256(newRefresh);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS*24*60*60*1000);
    await pool.query(
      "INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent, ip) VALUES (?,?,?,?,?)",
      [decoded.uid, newHash, expiresAt, (req.get("user-agent")||"").slice(0,255), (req.ip||"").slice(0,45)]
    );

    const [urows] = await pool.query("SELECT id, role, student_id FROM users WHERE id=?", [decoded.uid]);
    const u = urows[0];
    const accessToken = signAccessToken({ uid: u.id, role: u.role, studentId: u.student_id });

    setRefreshCookies(res, newRefresh);
    res.json({ token: accessToken, role: u.role });
  } catch {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
});

/* --- Auth: Logout (idempotent) --- */
app.post("/api/auth/logout", async (req, res) => {
  try {
    const refreshToken = req.cookies?.rt;
    if (refreshToken) {
      const tokenHash = sha256(refreshToken);
      await pool.query("UPDATE refresh_tokens SET revoked_at=NOW() WHERE token_hash=?", [tokenHash]);
    }
    res.clearCookie("rt", { ...cookieOptions, maxAge: 0 });
    res.clearCookie("csrf_refresh", { ...cookieOptions, httpOnly: false, maxAge: 0 });
    await audit(req, { action: "AUTH_LOGOUT", targetType: "user", targetId: req.user?.uid });
    return res.json({ success: true });
  } catch {
    return res.json({ success: true });
  }
});

/* --- Health (auth-protected internal) --- */
app.get("/api/health", authenticate, async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true }); }
  catch { res.status(500).json({ ok: false }); }
});

/* --- Students (RBAC) --- */
app.get("/api/students", authenticate, requireAdmin, async (req, res) => {
  const q = String((req.query.q || "")).trim();
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10)));
  const offset = (page - 1) * limit;

  const where = q ? "WHERE name LIKE ?" : "";
  const params = q ? [`%${q}%`] : [];

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) total FROM students ${where}`, params);
  const [rows] = await pool.query(
    `SELECT id, name, course, year, grade FROM students ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    q ? [...params, limit, offset] : [limit, offset]
  );
  res.json({ data: rows, page, limit, total, hasMore: offset + rows.length < total });
});

app.get("/api/students/:id", authenticate, requireAdminOrSelfByParamId("id"), async (req, res) => {
  const id = Number(req.params.id);
  const [rows] = await pool.query("SELECT id, name, course, year, grade FROM students WHERE id=?", [id]);
  if (!rows[0]) return res.status(404).json({ error: "Student not found" });
  res.json(rows[0]);
});

app.get("/api/me/grades", authenticate, async (req, res) => {
  if (req.user.role !== "student") return res.status(403).json({ error: "Students only" });
  if (!req.user.studentId) return res.status(404).json({ error: "No student record bound" });
  const [rows] = await pool.query("SELECT id, name, course, year, grade FROM students WHERE id=?", [req.user.studentId]);
  if (!rows[0]) return res.status(404).json({ error: "Student not found" });
  res.json(rows[0]);
});

app.post("/api/students", authenticate, requireAdmin, async (req, res) => {
  const parse = StudentSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues[0].message });
  const { name, course, year, grade } = parse.data;
  const [result] = await pool.query(
    "INSERT INTO students (name, course, year, grade) VALUES (?, ?, ?, ?)",
    [name, course, year, grade]
  );
  const id = result.insertId;
  await audit(req, { action: "STUDENT_CREATE", targetType: "student", targetId: id, details: { name, course, year, grade } });
  res.status(201).location(`/api/students/${id}`).json({ id, name, course, year, grade });
});

app.put("/api/students/:id", authenticate, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const parse = StudentSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues[0].message });
  const { name, course, year, grade } = parse.data;
  const [r] = await pool.query("UPDATE students SET name=?, course=?, year=?, grade=? WHERE id=?", [name, course, year, grade, id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: "Student not found" });
  await audit(req, { action: "STUDENT_UPDATE", targetType: "student", targetId: id, details: { name, course, year, grade } });
  res.json({ id, name, course, year, grade });
});

app.delete("/api/students/:id", authenticate, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [r] = await pool.query("DELETE FROM students WHERE id=?", [id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: "Student not found" });
  await audit(req, { action: "STUDENT_DELETE", targetType: "student", targetId: id });
  res.json({ success: true });
});

/* --- Admin: Users CRUD --- */
app.get("/api/admin/users", authenticate, requireAdmin, async (_req, res) => {
  const [rows] = await pool.query(
    "SELECT id, email, role, student_id, created_at FROM users ORDER BY id DESC"
  );
  res.json(rows);
});

app.post("/api/admin/users", authenticate, requireAdmin, async (req, res) => {
  const parse = CreateUserSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues[0].message });
  const { email, password, role, student_id } = parse.data;

  // enforce consistent role/binding
  if (role === "student" && !student_id) return res.status(400).json({ error: "student_id is required for student role" });
  if (role === "admin" && student_id)   return res.status(400).json({ error: "admin accounts cannot be bound to a student_id" });

  // verify student exists when provided
  if (student_id) {
    const [s] = await pool.query("SELECT id FROM students WHERE id=?", [student_id]);
    if (!s[0]) return res.status(404).json({ error: "student_id not found" });
  }

  const hash = await bcrypt.hash(password, 10);
  try {
    const [r] = await pool.query(
      "INSERT INTO users (email, password_hash, role, student_id) VALUES (?,?,?,?)",
      [email, hash, role, student_id ?? null]
    );
    await audit(req, { action: "USER_CREATE", targetType: "user", targetId: r.insertId, details: { email, role, student_id } });
    res.status(201).json({ id: r.insertId, email, role, student_id: student_id ?? null });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email already exists" });
    return res.status(500).json({ error: "Create user failed" });
  }
});

app.put("/api/admin/users/:id", authenticate, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const parse = UpdateUserSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: parse.error.issues[0].message });

  // enforce rules if fields provided
  if (parse.data.role === "admin" && Object.prototype.hasOwnProperty.call(parse.data, "student_id") && parse.data.student_id) {
    return res.status(400).json({ error: "admin accounts cannot be bound to a student_id" });
  }
  if (parse.data.role === "student" && Object.prototype.hasOwnProperty.call(parse.data, "student_id") && parse.data.student_id == null) {
    return res.status(400).json({ error: "student_id is required for student role" });
  }
  if (Object.prototype.hasOwnProperty.call(parse.data, "student_id") && parse.data.student_id) {
    const [s] = await pool.query("SELECT id FROM students WHERE id=?", [parse.data.student_id]);
    if (!s[0]) return res.status(404).json({ error: "student_id not found" });
  }

  const fields = [];
  const params = [];
  if (parse.data.role) { fields.push("role=?"); params.push(parse.data.role); }
  if (Object.prototype.hasOwnProperty.call(parse.data, "student_id")) {
    fields.push("student_id=?"); params.push(parse.data.student_id ?? null);
  }
  if (parse.data.password) {
    const hash = await bcrypt.hash(parse.data.password, 10);
    fields.push("password_hash=?"); params.push(hash);
  }
  if (!fields.length) return res.status(400).json({ error: "No changes provided" });

  params.push(id);
  const [r] = await pool.query(`UPDATE users SET ${fields.join(", ")} WHERE id=?`, params);
  if (r.affectedRows === 0) return res.status(404).json({ error: "User not found" });

  await audit(req, { action: "USER_UPDATE", targetType: "user", targetId: id, details: parse.data });
  res.json({ id, ...parse.data });
});

app.delete("/api/admin/users/:id", authenticate, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const [r] = await pool.query("DELETE FROM users WHERE id=?", [id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: "User not found" });
  await audit(req, { action: "USER_DELETE", targetType: "user", targetId: id });
  res.json({ success: true });
});

/* --- Audit: list (admin) --- */
app.get("/api/admin/audit-logs", authenticate, requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10)));
  const offset = (page - 1) * limit;

  const [[{ total }]] = await pool.query("SELECT COUNT(*) total FROM audit_logs");
  const [rows] = await pool.query(
    `SELECT id, occurred_at, actor_user_id, actor_role, action, target_type, target_id, ip, user_agent, details
       FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  res.json({ data: rows, page, limit, total, hasMore: offset + rows.length < total });
});

app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
