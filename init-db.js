// AIfunny — load schema.sql into the database (no psql needed).
//   DATABASE_URL=... PGSSL=require node init-db.js
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql); // runs the whole file (multi-statement, no params)
  console.log("Schema loaded.");
  await pool.end();
})().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
