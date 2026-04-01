const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const db = new Database(path.join(__dirname, 'refc.db'));

// Pragmas de performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── SCHEMA ───
db.exec(`
  CREATE TABLE IF NOT EXISTS usuarios (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    usuario   TEXT NOT NULL UNIQUE,
    password  TEXT NOT NULL,
    rol       TEXT NOT NULL DEFAULT 'consulta',
    creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS socios (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre        TEXT NOT NULL,
    apellido      TEXT NOT NULL,
    dni           TEXT NOT NULL UNIQUE,
    telefono      TEXT NOT NULL,
    email         TEXT,
    direccion     TEXT,
    fecha_nac     TEXT,
    fecha_ingreso TEXT NOT NULL DEFAULT (date('now','localtime')),
    categoria     TEXT NOT NULL DEFAULT 'general',
    estado        TEXT NOT NULL DEFAULT 'al-dia',
    observaciones TEXT,
    creado_en     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS cuotas (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    socio_id   INTEGER NOT NULL REFERENCES socios(id) ON DELETE CASCADE,
    mes        TEXT NOT NULL,
    monto      REAL NOT NULL DEFAULT 0,
    pagado     INTEGER NOT NULL DEFAULT 0,
    fecha_pago TEXT,
    comprobante TEXT,
    notas      TEXT,
    creado_en  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
`);

// ─── SEED: usuarios por defecto ───
const seedUsuarios = () => {
  const count = db.prepare('SELECT COUNT(*) as c FROM usuarios').get().c;
  if (count > 0) return;

  const insert = db.prepare('INSERT INTO usuarios (usuario, password, rol) VALUES (?, ?, ?)');
  insert.run('admin',  bcrypt.hashSync('refc2024',   10), 'admin');
  insert.run('puerta', bcrypt.hashSync('puerta123',  10), 'consulta');

  console.log('✅ Usuarios seed creados');
};

seedUsuarios();

module.exports = db;
