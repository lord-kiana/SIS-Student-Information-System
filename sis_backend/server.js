const express = require("express");
const mysql = require("mysql");
const cors = require("cors");
const bcrypt = require("bcrypt");

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MySQL connection
const db = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "sis_db",
  port: 3306
});

db.connect(err => {
  if (err) {
    console.error("MySQL connection error:", err);
    process.exit(1);
  }
  console.log("✅ Connected to MySQL database");
});

// Routes
app.get("/", (_req, res) => {
  res.send("Welcome to the Student Information System API");
});

// Get student info by name
app.get("/api/students/name/:name", (req, res) => {
  const name = req.params.name;
  const sql = "SELECT * FROM students WHERE name = ?";
  db.query(sql, [name], (err, results) => {
    if (err) return res.status(500).json({ error: "Database error" });
    if (results.length === 0) return res.status(404).json({ error: "Student not found" });
    res.json(results[0]); // return the first match
  });
});


// ===============================
// 🧑‍🎓 STUDENTS CRUD ROUTES
// ===============================

// 🔎 Get students (with optional search)
app.get("/api/students", (req, res) => {
  const q = (req.query.q || "").trim();
  if (q) {
    db.query(
      "SELECT * FROM students WHERE name LIKE ? ORDER BY id DESC",
      [`%${q}%`],
      (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
      }
    );
  } else {
    db.query("SELECT * FROM students ORDER BY id DESC", (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    });
  }
});

// ➕ Create student
app.post("/api/students", (req, res) => {
  const { name, course, year, grade } = req.body;
  if (!name || !course || !year || !grade) {
    return res.status(400).json({ error: "All fields are required" });
  }
  db.query(
    "INSERT INTO students (name, course, year, grade) VALUES (?, ?, ?, ?)",
    [name, course, year, grade],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: result.insertId, name, course, year, grade });
    }
  );
});

// ✏️ Update student
app.put("/api/students/:id", (req, res) => {
  const { id } = req.params;
  const { name, course, year, grade } = req.body;
  if (!name || !course || !year || !grade) {
    return res.status(400).json({ error: "All fields are required" });
  }
  db.query(
    "UPDATE students SET name=?, course=?, year=?, grade=? WHERE id=?",
    [name, course, year, grade, id],
    (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      if (result.affectedRows === 0)
        return res.status(404).json({ error: "Student not found" });
      res.json({ id: Number(id), name, course, year, grade });
    }
  );
});

// 🗑️ Delete student
app.delete("/api/students/:id", (req, res) => {
  const { id } = req.params;
  db.query("DELETE FROM students WHERE id=?", [id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Student not found" });
    res.json({ success: true });
  });
});


// ===============================
// 👤 USER AUTHENTICATION ROUTES
// ===============================

// 📝 REGISTER (Sign Up)
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });

  db.query("SELECT * FROM users WHERE email = ?", [email], async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (rows.length > 0)
      return res.status(400).json({ error: "Email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    db.query(
      "INSERT INTO users (email, password_hash, role, created_at) VALUES (?, ?, 'student', NOW())",
      [email, hashedPassword],
      err2 => {
        if (err2) return res.status(500).json({ error: err2.message });
        res.status(201).json({ message: "User registered successfully" });
      }
    );
  });
});

// 🔑 LOGIN
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required" });

  db.query("SELECT * FROM users WHERE email = ?", [email], async (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    if (rows.length === 0)
      return res.status(401).json({ error: "Invalid email or password" });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match)
      return res.status(401).json({ error: "Invalid email or password" });

    res.json({
      message: "Login successful",
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    });
  });
});



// ===============================
// 🚀 START SERVER
// ===============================
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
