const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id        SERIAL PRIMARY KEY,
      usuario   TEXT NOT NULL UNIQUE,
      password  TEXT NOT NULL,
      rol       TEXT NOT NULL DEFAULT 'consulta',
      creado_en TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS socios (
      id            SERIAL PRIMARY KEY,
      nombre        TEXT NOT NULL,
      apellido      TEXT NOT NULL,
      dni           TEXT NOT NULL UNIQUE,
      telefono      TEXT NOT NULL,
      email         TEXT,
      direccion     TEXT,
      fecha_nac     TEXT,
      fecha_ingreso TEXT NOT NULL DEFAULT to_char(CURRENT_DATE, 'YYYY-MM-DD'),
      categoria     TEXT NOT NULL DEFAULT 'general',
      estado        TEXT NOT NULL DEFAULT 'al-dia',
      observaciones TEXT,
      creado_en     TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS cuotas (
      id          SERIAL PRIMARY KEY,
      socio_id    INTEGER NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
      mes         TEXT NOT NULL,
      monto       REAL NOT NULL DEFAULT 0,
      pagado      INTEGER NOT NULL DEFAULT 0,
      fecha_pago  TEXT,
      comprobante TEXT,
      notas       TEXT,
      creado_en   TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS solicitudes (
      id               SERIAL PRIMARY KEY,
      nombre           TEXT NOT NULL,
      apellido         TEXT NOT NULL,
      dni              TEXT NOT NULL,
      telefono         TEXT NOT NULL,
      mp_preference_id TEXT,
      mp_payment_id    TEXT,
      estado           TEXT NOT NULL DEFAULT 'pendiente',
      creado_en        TEXT NOT NULL DEFAULT to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );
  `);

  // Seed usuarios por defecto
  const { rows } = await pool.query('SELECT COUNT(*) as c FROM usuarios');
  if (parseInt(rows[0].c) === 0) {
    await pool.query('INSERT INTO usuarios (usuario, password, rol) VALUES ($1, $2, $3)',
      ['admin', bcrypt.hashSync('refc2024', 10), 'admin']);
    await pool.query('INSERT INTO usuarios (usuario, password, rol) VALUES ($1, $2, $3)',
      ['puerta', bcrypt.hashSync('puerta123', 10), 'consulta']);
    console.log('✅ Usuarios seed creados');
  }
}

module.exports = { pool, initDB };
