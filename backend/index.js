const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const db      = require('./db');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const BASE_URL = process.env.BASE_URL || 'https://recreativo-estrellas-fc-production.up.railway.app';

function getMPClient() {
  const token = process.env.MP_ACCESS_TOKEN;
  if (!token) return null;
  return new MercadoPagoConfig({ accessToken: token });
}

const app    = express();
const PORT   = process.env.PORT || 3001;
const SECRET = process.env.JWT_SECRET || 'refc_secret_2024';

app.use(cors());
app.use(express.json());

// ─── SERVIR FRONTEND ───
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));

// ─── MIDDLEWARE AUTH ───
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

function soloAdmin(req, res, next) {
  if (req.user?.rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
  next();
}

// ═══════════════════════════════════
//  AUTH
// ═══════════════════════════════════
app.post('/api/login', (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });

  const user = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(usuario);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  const token = jwt.sign({ id: user.id, usuario: user.usuario, rol: user.rol }, SECRET, { expiresIn: '8h' });
  res.json({ token, usuario: user.usuario, rol: user.rol });
});

// ═══════════════════════════════════
//  STATS
// ═══════════════════════════════════
app.get('/api/stats', auth, (req, res) => {
  const total   = db.prepare('SELECT COUNT(*) as c FROM socios').get().c;
  const alDia   = db.prepare("SELECT COUNT(*) as c FROM socios WHERE estado = 'al-dia'").get().c;
  const deuda   = db.prepare("SELECT COUNT(*) as c FROM socios WHERE estado = 'deuda'").get().c;
  const recaud  = db.prepare("SELECT COALESCE(SUM(monto),0) as total FROM cuotas WHERE pagado = 1 AND mes LIKE ?").get(`${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}%`).total;

  res.json({ total, alDia, deuda, recaudadoMes: recaud });
});

// ═══════════════════════════════════
//  SOCIOS
// ═══════════════════════════════════
app.get('/api/socios', auth, (req, res) => {
  const { q, estado } = req.query;
  let sql = 'SELECT * FROM socios WHERE 1=1';
  const params = [];

  if (q) {
    sql += ' AND (nombre || " " || apellido LIKE ? OR dni LIKE ?)';
    params.push(`%${q}%`, `%${q}%`);
  }
  if (estado) {
    sql += ' AND estado = ?';
    params.push(estado);
  }

  sql += ' ORDER BY id DESC';
  const socios = db.prepare(sql).all(...params);

  // Agregar conteo de cuotas pagas
  const withCuotas = socios.map(s => ({
    ...s,
    cuotas_pagas: db.prepare('SELECT COUNT(*) as c FROM cuotas WHERE socio_id = ? AND pagado = 1').get(s.id).c
  }));

  res.json(withCuotas);
});

app.get('/api/socios/dni/:dni', auth, (req, res) => {
  const socio = db.prepare('SELECT * FROM socios WHERE dni = ?').get(req.params.dni);
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const cuotas_pagas = db.prepare('SELECT COUNT(*) as c FROM cuotas WHERE socio_id = ? AND pagado = 1').get(socio.id).c;
  const cuotas = db.prepare('SELECT * FROM cuotas WHERE socio_id = ? ORDER BY mes DESC').all(socio.id);

  res.json({ ...socio, cuotas_pagas, cuotas });
});

app.get('/api/socios/:id', auth, (req, res) => {
  const socio = db.prepare('SELECT * FROM socios WHERE id = ?').get(req.params.id);
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const cuotas_pagas = db.prepare('SELECT COUNT(*) as c FROM cuotas WHERE socio_id = ? AND pagado = 1').get(socio.id).c;
  const cuotas = db.prepare('SELECT * FROM cuotas WHERE socio_id = ? ORDER BY mes DESC').all(socio.id);

  res.json({ ...socio, cuotas_pagas, cuotas });
});

app.post('/api/socios', auth, soloAdmin, (req, res) => {
  const { nombre, apellido, dni, telefono, email, direccion, fecha_nac, fecha_ingreso, categoria, estado, observaciones } = req.body;

  if (!nombre || !apellido || !dni || !telefono) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const existe = db.prepare('SELECT id FROM socios WHERE dni = ?').get(dni);
  if (existe) return res.status(409).json({ error: 'Ya existe un socio con ese DNI' });

  const result = db.prepare(`
    INSERT INTO socios (nombre, apellido, dni, telefono, email, direccion, fecha_nac, fecha_ingreso, categoria, estado, observaciones)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nombre, apellido, dni, telefono, email || null, direccion || null, fecha_nac || null,
         fecha_ingreso || new Date().toISOString().split('T')[0],
         categoria || 'general', estado || 'al-dia', observaciones || null);

  res.status(201).json({ id: result.lastInsertRowid, mensaje: 'Socio registrado' });
});

app.put('/api/socios/:id', auth, soloAdmin, (req, res) => {
  const { nombre, apellido, dni, telefono, email, direccion, fecha_nac, categoria, estado, observaciones } = req.body;

  const socio = db.prepare('SELECT id FROM socios WHERE id = ?').get(req.params.id);
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  db.prepare(`
    UPDATE socios SET nombre=?, apellido=?, dni=?, telefono=?, email=?, direccion=?, fecha_nac=?, categoria=?, estado=?, observaciones=?
    WHERE id=?
  `).run(nombre, apellido, dni, telefono, email || null, direccion || null, fecha_nac || null,
         categoria, estado, observaciones || null, req.params.id);

  res.json({ mensaje: 'Socio actualizado' });
});

app.delete('/api/socios/:id', auth, soloAdmin, (req, res) => {
  const socio = db.prepare('SELECT id FROM socios WHERE id = ?').get(req.params.id);
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  db.prepare('DELETE FROM socios WHERE id = ?').run(req.params.id);
  res.json({ mensaje: 'Socio eliminado' });
});

// ═══════════════════════════════════
//  CUOTAS
// ═══════════════════════════════════
app.post('/api/cuotas', auth, soloAdmin, (req, res) => {
  const { socio_id, mes, monto, pagado, fecha_pago, notas } = req.body;
  if (!socio_id || !mes) return res.status(400).json({ error: 'Faltan datos' });

  const result = db.prepare(`
    INSERT INTO cuotas (socio_id, mes, monto, pagado, fecha_pago, notas)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(socio_id, mes, monto || 0, pagado ? 1 : 0, fecha_pago || null, notas || null);

  // Actualizar estado del socio automáticamente
  if (pagado) {
    db.prepare("UPDATE socios SET estado = 'al-dia' WHERE id = ?").run(socio_id);
  }

  res.status(201).json({ id: result.lastInsertRowid });
});

app.put('/api/cuotas/:id/pagar', auth, soloAdmin, (req, res) => {
  const { monto, fecha_pago, comprobante } = req.body;
  const cuota = db.prepare('SELECT * FROM cuotas WHERE id = ?').get(req.params.id);
  if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' });

  db.prepare('UPDATE cuotas SET pagado=1, monto=?, fecha_pago=?, comprobante=? WHERE id=?')
    .run(monto || cuota.monto, fecha_pago || new Date().toISOString().split('T')[0], comprobante || null, req.params.id);

  db.prepare("UPDATE socios SET estado='al-dia' WHERE id=?").run(cuota.socio_id);
  res.json({ mensaje: 'Cuota registrada como pagada' });
});

// ═══════════════════════════════════
//  HACERSE SOCIO — MERCADO PAGO
// ═══════════════════════════════════

// Crear solicitud y preferencia de pago
app.post('/api/solicitudes', async (req, res) => {
  const { nombre, apellido, dni, telefono } = req.body;
  if (!nombre || !apellido || !dni || !telefono) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  // Verificar que no exista ya un socio con ese DNI
  const existeSocio = db.prepare('SELECT id FROM socios WHERE dni = ?').get(dni);
  if (existeSocio) return res.status(409).json({ error: 'Ya existe un socio registrado con ese DNI' });

  // Verificar que no haya una solicitud pendiente con ese DNI
  const existeSolicitud = db.prepare("SELECT id FROM solicitudes WHERE dni = ? AND estado = 'pendiente'").get(dni);
  if (existeSolicitud) return res.status(409).json({ error: 'Ya existe una solicitud pendiente con ese DNI' });

  // Guardar solicitud
  const result = db.prepare(`
    INSERT INTO solicitudes (nombre, apellido, dni, telefono)
    VALUES (?, ?, ?, ?)
  `).run(nombre, apellido, dni, telefono);
  const solicitudId = result.lastInsertRowid;

  const mpClient = getMPClient();
  if (!mpClient) {
    // MP no configurado aún — devolver URL de pendiente
    return res.json({ init_point: `${BASE_URL}/pago-pendiente.html`, mp_configurado: false });
  }

  try {
    const preference = new Preference(mpClient);
    const pref = await preference.create({
      body: {
        items: [{
          title: 'Cuota de ingreso - Recreativo Estrellas F.C.',
          quantity: 1,
          unit_price: 10000,
          currency_id: 'ARS'
        }],
        payer: { name: nombre, surname: apellido },
        external_reference: String(solicitudId),
        back_urls: {
          success: `${BASE_URL}/pago-exitoso.html`,
          failure: `${BASE_URL}/pago-fallido.html`,
          pending: `${BASE_URL}/pago-pendiente.html`
        },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/mp-webhook`
      }
    });

    db.prepare('UPDATE solicitudes SET mp_preference_id = ? WHERE id = ?').run(pref.id, solicitudId);
    res.json({ init_point: pref.init_point });
  } catch (err) {
    console.error('Error MP:', err);
    res.status(500).json({ error: 'Error al crear preferencia de pago. Intentá de nuevo.' });
  }
});

// Webhook de Mercado Pago
app.post('/api/mp-webhook', async (req, res) => {
  res.sendStatus(200); // MP requiere respuesta 200 inmediata

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;

  const mpClient = getMPClient();
  if (!mpClient) return;

  try {
    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: data.id });

    if (payment.status !== 'approved') return;

    const solicitudId = payment.external_reference;
    const solicitud = db.prepare('SELECT * FROM solicitudes WHERE id = ?').get(solicitudId);
    if (!solicitud || solicitud.estado === 'aprobado') return;

    // Crear socio
    const socioResult = db.prepare(`
      INSERT INTO socios (nombre, apellido, dni, telefono, categoria, estado)
      VALUES (?, ?, ?, ?, 'general', 'al-dia')
    `).run(solicitud.nombre, solicitud.apellido, solicitud.dni, solicitud.telefono);

    // Registrar cuota pagada
    const now = new Date();
    const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    db.prepare(`
      INSERT INTO cuotas (socio_id, mes, monto, pagado, fecha_pago, comprobante, notas)
      VALUES (?, ?, 10000, 1, ?, ?, 'Pago via Mercado Pago — cuota de ingreso')
    `).run(socioResult.lastInsertRowid, mes, now.toISOString().split('T')[0], String(payment.id));

    // Marcar solicitud como aprobada
    db.prepare("UPDATE solicitudes SET estado = 'aprobado', mp_payment_id = ? WHERE id = ?")
      .run(String(payment.id), solicitudId);

    console.log(`✅ Nuevo socio registrado: ${solicitud.nombre} ${solicitud.apellido} (DNI ${solicitud.dni})`);
  } catch (err) {
    console.error('Error procesando webhook MP:', err);
  }
});

// ─── CATCH-ALL → login ───
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ─── START ───
app.listen(PORT, () => {
  console.log(`\n🚀 REFC Backend corriendo en http://localhost:${PORT}`);
  console.log(`   Usuarios disponibles:`);
  console.log(`   • admin  / refc2024   (administrador)`);
  console.log(`   • puerta / puerta123  (consulta en puerta)\n`);
});
