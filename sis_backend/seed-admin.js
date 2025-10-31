// seed-admin.js
require("dotenv").config();
const bcrypt = require("bcrypt");
const mysql = require("mysql2/promise");

(async () => {
  const pool = await mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    database: process.env.DB_NAME || "sis_db",  // uses your .env
    port: Number(process.env.DB_PORT || 3306),
  });

  // change passwords if you want
  const adminPass = await bcrypt.hash("Admin#12345", 10);
  await pool.query(
    "INSERT IGNORE INTO users (email, password_hash, role) VALUES (?,?, 'admin')",
    ["admin@sis.local", adminPass]
  );

  // Bind to existing student row id=1 (you have one in your dump)
  const studentPass = await bcrypt.hash("Student#12345", 10);
  await pool.query(
    "INSERT IGNORE INTO users (email, password_hash, role, student_id) VALUES (?,?, 'student', ?)",
    ["student1@sis.local", studentPass, 1]
  );

  console.log("Seed complete.");
  process.exit(0);
})();
