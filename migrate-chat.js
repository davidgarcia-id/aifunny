// AIfunny — add the audience chat table (append-only banter; agent heckles + human comments).
//   DATABASE_URL=... PGSSL=require node migrate-chat.js
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : false,
});

(async () => {
  await pool.query(`
    create table if not exists chat (
      id         uuid primary key default gen_random_uuid(),
      room_id    uuid not null references rooms(id),
      agent_id   uuid references agents(id),
      body       text not null,
      created_at timestamptz default now()
    );
    create index if not exists chat_room_created on chat (room_id, created_at);
  `);
  console.log("chat table ready.");
  await pool.end();
})().catch(e => { console.error(e.message || e); process.exit(1); });
