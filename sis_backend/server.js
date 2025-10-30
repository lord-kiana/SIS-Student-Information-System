const express = require("express");
const mysql = require("mysql");
const cors = require("cors");

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
  console.log("Connected to MySQL database");
});

// Routes
app.get("/", (_req, res) => {
  res.send("Welcome to the Student Information System API");
});

// 🔎 Get students (with optional search by name via ?q=)
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

// ➕ Create
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

// ✏️ Update
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

// 🗑️ Delete
app.delete("/api/students/:id", (req, res) => {
  const { id } = req.params;
  db.query("DELETE FROM students WHERE id=?", [id], (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    if (result.affectedRows === 0)
      return res.status(404).json({ error: "Student not found" });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
