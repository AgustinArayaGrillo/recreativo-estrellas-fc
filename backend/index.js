const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const path    = require('path');
const { pool, initDB } = require('./db');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const BASE_URL = process.env.BASE_URL || 'https://recreativo-estrellas-fc.onrender.com';

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
app.post('/api/login', async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Faltan datos' });

  const { rows } = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
  const user = rows[0];
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }

  const token = jwt.sign({ id: user.id, usuario: user.usuario, rol: user.rol }, SECRET, { expiresIn: '8h' });
  res.json({ token, usuario: user.usuario, rol: user.rol });
});

// ═══════════════════════════════════
//  STATS
// ═══════════════════════════════════
app.get('/api/stats', auth, async (req, res) => {
  const mes = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  const total  = parseInt((await pool.query('SELECT COUNT(*) as c FROM socios')).rows[0].c);
  const alDia  = parseInt((await pool.query(
    "SELECT COUNT(DISTINCT socio_id) as c FROM cuotas WHERE pagado = 1 AND mes LIKE $1", [`${mes}%`]
  )).rows[0].c);
  const deuda  = total - alDia;
  const recaud = parseFloat((await pool.query(
    "SELECT COALESCE(SUM(monto),0) as total FROM cuotas WHERE pagado = 1 AND mes LIKE $1",
    [`${mes}%`]
  )).rows[0].total);

  res.json({ total, alDia, deuda, recaudadoMes: recaud });
});

// ═══════════════════════════════════
//  SOCIOS
// ═══════════════════════════════════
app.get('/api/socios', auth, async (req, res) => {
  const { q, estado } = req.query;
  let sql = 'SELECT * FROM socios WHERE 1=1';
  const params = [];
  let idx = 1;

  if (q) {
    sql += ` AND (nombre || ' ' || apellido ILIKE $${idx} OR dni ILIKE $${idx + 1})`;
    params.push(`%${q}%`, `%${q}%`);
    idx += 2;
  }
  if (estado) {
    sql += ` AND estado = $${idx}`;
    params.push(estado);
    idx++;
  }

  sql += ' ORDER BY id DESC';
  const socios = (await pool.query(sql, params)).rows;

  const mesActual = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const withCuotas = await Promise.all(socios.map(async s => {
    const cuotas_pagas = parseInt((await pool.query(
      'SELECT COUNT(*) as c FROM cuotas WHERE socio_id = $1 AND pagado = 1', [s.id]
    )).rows[0].c);
    const tieneCuotaMes = (await pool.query(
      'SELECT id FROM cuotas WHERE socio_id = $1 AND pagado = 1 AND mes LIKE $2', [s.id, `${mesActual}%`]
    )).rows.length > 0;
    return { ...s, estado: tieneCuotaMes ? 'al-dia' : 'deuda', cuotas_pagas };
  }));

  res.json(withCuotas);
});

app.get('/api/socios/dni/:dni', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM socios WHERE dni = $1', [req.params.dni]);
  const socio = rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const mesActual = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const cuotas_pagas = parseInt((await pool.query(
    'SELECT COUNT(*) as c FROM cuotas WHERE socio_id = $1 AND pagado = 1', [socio.id]
  )).rows[0].c);
  const cuotas = (await pool.query(
    'SELECT * FROM cuotas WHERE socio_id = $1 ORDER BY mes DESC', [socio.id]
  )).rows;
  const tieneCuotaMes = cuotas.some(c => c.mes && c.mes.startsWith(mesActual) && c.pagado);

  res.json({ ...socio, estado: tieneCuotaMes ? 'al-dia' : 'deuda', cuotas_pagas, cuotas });
});

app.get('/api/socios/:id', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM socios WHERE id = $1', [req.params.id]);
  const socio = rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const mesActual = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const cuotas_pagas = parseInt((await pool.query(
    'SELECT COUNT(*) as c FROM cuotas WHERE socio_id = $1 AND pagado = 1', [socio.id]
  )).rows[0].c);
  const cuotas = (await pool.query(
    'SELECT * FROM cuotas WHERE socio_id = $1 ORDER BY mes DESC', [socio.id]
  )).rows;
  const tieneCuotaMes = cuotas.some(c => c.mes && c.mes.startsWith(mesActual) && c.pagado);

  res.json({ ...socio, estado: tieneCuotaMes ? 'al-dia' : 'deuda', cuotas_pagas, cuotas });
});

// ─── CONSULTA PÚBLICA (sin auth) — para la web recreativoestrellas.com ───
app.get('/api/public/socio', async (req, res) => {
  const { dni, q } = req.query;
  const mesActual = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;

  try {
    let socios;
    if (dni) {
      socios = (await pool.query('SELECT * FROM socios WHERE dni = $1', [dni])).rows;
    } else if (q) {
      socios = (await pool.query(
        "SELECT * FROM socios WHERE apellido ILIKE $1 OR (nombre || ' ' || apellido) ILIKE $1",
        [`%${q}%`]
      )).rows;
    } else {
      return res.status(400).json({ error: 'Ingresá DNI o apellido' });
    }

    if (!socios.length) return res.status(404).json({ error: 'No encontrado' });

    const result = await Promise.all(socios.map(async s => {
      const cuotas_pagas = parseInt((await pool.query(
        'SELECT COUNT(*) as c FROM cuotas WHERE socio_id = $1 AND pagado = 1', [s.id]
      )).rows[0].c);
      const tieneCuotaMes = (await pool.query(
        'SELECT id FROM cuotas WHERE socio_id = $1 AND pagado = 1 AND mes LIKE $2', [s.id, `${mesActual}%`]
      )).rows.length > 0;
      return {
        id: s.id,
        nombre: s.nombre,
        apellido: s.apellido,
        dni: s.dni,
        estado: tieneCuotaMes ? 'al-dia' : 'deuda',
        cuotas_pagas
      };
    }));

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/socios', auth, soloAdmin, async (req, res) => {
  const { nombre, apellido, dni, telefono, email, direccion, fecha_nac, fecha_ingreso, categoria, estado, observaciones } = req.body;

  if (!nombre || !apellido || !dni) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const existe = (await pool.query('SELECT id FROM socios WHERE dni = $1', [dni])).rows[0];
  if (existe) return res.status(409).json({ error: 'Ya existe un socio con ese DNI' });

  const result = await pool.query(`
    INSERT INTO socios (nombre, apellido, dni, telefono, email, direccion, fecha_nac, fecha_ingreso, categoria, estado, observaciones)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [
    nombre, apellido, dni, telefono,
    email || null, direccion || null, fecha_nac || null,
    fecha_ingreso || new Date().toISOString().split('T')[0],
    categoria || 'general', estado || 'deuda', observaciones || null
  ]);

  res.status(201).json({ id: result.rows[0].id, mensaje: 'Socio registrado' });
});

app.put('/api/socios/:id', auth, soloAdmin, async (req, res) => {
  const { nombre, apellido, dni, telefono, email, direccion, fecha_nac, categoria, estado, observaciones } = req.body;

  const socio = (await pool.query('SELECT id FROM socios WHERE id = $1', [req.params.id])).rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  await pool.query(`
    UPDATE socios SET nombre=$1, apellido=$2, dni=$3, telefono=$4, email=$5,
      direccion=$6, fecha_nac=$7, categoria=$8, estado=$9, observaciones=$10
    WHERE id=$11
  `, [nombre, apellido, dni, telefono, email || null, direccion || null,
      fecha_nac || null, categoria, estado, observaciones || null, req.params.id]);

  res.json({ mensaje: 'Socio actualizado' });
});

app.delete('/api/socios/:id', auth, soloAdmin, async (req, res) => {
  const socio = (await pool.query('SELECT id FROM socios WHERE id = $1', [req.params.id])).rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  await pool.query('DELETE FROM socios WHERE id = $1', [req.params.id]);
  res.json({ mensaje: 'Socio eliminado' });
});

// ═══════════════════════════════════
//  CUOTAS
// ═══════════════════════════════════
app.post('/api/cuotas', auth, soloAdmin, async (req, res) => {
  const { socio_id, mes, monto, pagado, fecha_pago, notas } = req.body;
  if (!socio_id || !mes) return res.status(400).json({ error: 'Faltan datos' });

  const result = await pool.query(`
    INSERT INTO cuotas (socio_id, mes, monto, pagado, fecha_pago, notas)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [socio_id, mes, monto || 0, pagado ? 1 : 0, fecha_pago || null, notas || null]);

  if (pagado) {
    await pool.query("UPDATE socios SET estado = 'al-dia' WHERE id = $1", [socio_id]);
  }

  res.status(201).json({ id: result.rows[0].id });
});

app.put('/api/cuotas/:id/pagar', auth, soloAdmin, async (req, res) => {
  const { monto, fecha_pago, comprobante } = req.body;
  const cuota = (await pool.query('SELECT * FROM cuotas WHERE id = $1', [req.params.id])).rows[0];
  if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' });

  await pool.query(
    'UPDATE cuotas SET pagado=1, monto=$1, fecha_pago=$2, comprobante=$3 WHERE id=$4',
    [monto || cuota.monto, fecha_pago || new Date().toISOString().split('T')[0], comprobante || null, req.params.id]
  );

  await pool.query("UPDATE socios SET estado='al-dia' WHERE id=$1", [cuota.socio_id]);
  res.json({ mensaje: 'Cuota registrada como pagada' });
});

// ═══════════════════════════════════
//  HACERSE SOCIO — MERCADO PAGO
// ═══════════════════════════════════
app.post('/api/solicitudes', async (req, res) => {
  const { nombre, apellido, dni, telefono } = req.body;
  if (!nombre || !apellido || !dni || !telefono) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const existeSocio = (await pool.query('SELECT id FROM socios WHERE dni = $1', [dni])).rows[0];
  if (existeSocio) return res.status(409).json({ error: 'Ya existe un socio registrado con ese DNI' });

  // Si hay una solicitud pendiente anterior, la eliminamos para permitir reintentar
  await pool.query("DELETE FROM solicitudes WHERE dni = $1 AND estado = 'pendiente'", [dni]);

  const result = await pool.query(
    'INSERT INTO solicitudes (nombre, apellido, dni, telefono) VALUES ($1, $2, $3, $4) RETURNING id',
    [nombre, apellido, dni, telefono]
  );
  const solicitudId = result.rows[0].id;

  const mpClient = getMPClient();
  if (!mpClient) {
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

    await pool.query('UPDATE solicitudes SET mp_preference_id = $1 WHERE id = $2', [pref.id, solicitudId]);
    res.json({ init_point: pref.init_point });
  } catch (err) {
    console.error('Error MP:', err);
    res.status(500).json({ error: 'Error al crear preferencia de pago. Intentá de nuevo.' });
  }
});

app.post('/api/mp-webhook', async (req, res) => {
  res.sendStatus(200);

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;

  const mpClient = getMPClient();
  if (!mpClient) return;

  try {
    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: data.id });

    if (payment.status !== 'approved') return;

    const externalRef = String(payment.external_reference || '');

    // ── PAGO DE CUOTA de socio existente ──
    if (externalRef.startsWith('cuota:')) {
      const [, socioId, cuotaId] = externalRef.split(':');
      const cuota = (await pool.query('SELECT * FROM cuotas WHERE id = $1', [cuotaId])).rows[0];
      if (!cuota || cuota.pagado) return;

      const fechaHoy = new Date().toISOString().split('T')[0];
      await pool.query(
        'UPDATE cuotas SET pagado=1, fecha_pago=$1, comprobante=$2 WHERE id=$3',
        [fechaHoy, String(payment.id), cuotaId]
      );
      await pool.query("UPDATE socios SET estado='al-dia' WHERE id=$1", [socioId]);
      console.log(`✅ Cuota pagada (webhook): socio ${socioId}, cuota ${cuotaId}, fecha ${fechaHoy}`);
      return;
    }

    // ── INSCRIPCIÓN de nuevo socio ──
    const solicitudId = externalRef;
    const solicitud = (await pool.query('SELECT * FROM solicitudes WHERE id = $1', [solicitudId])).rows[0];
    if (!solicitud || solicitud.estado === 'aprobado') return;

    const now = new Date();
    const fechaHoy = now.toISOString().split('T')[0];
    const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const socioResult = await pool.query(`
      INSERT INTO socios (nombre, apellido, dni, telefono, categoria, estado, fecha_ingreso)
      VALUES ($1, $2, $3, $4, 'general', 'al-dia', $5)
      RETURNING id
    `, [solicitud.nombre, solicitud.apellido, solicitud.dni, solicitud.telefono, fechaHoy]);

    await pool.query(`
      INSERT INTO cuotas (socio_id, mes, monto, pagado, fecha_pago, comprobante, notas)
      VALUES ($1, $2, 10000, 1, $3, $4, 'Pago via Mercado Pago — cuota de ingreso')
    `, [socioResult.rows[0].id, mes, fechaHoy, String(payment.id)]);

    await pool.query(
      "UPDATE solicitudes SET estado = 'aprobado', mp_payment_id = $1 WHERE id = $2",
      [String(payment.id), solicitudId]
    );

    console.log(`✅ Nuevo socio registrado: ${solicitud.nombre} ${solicitud.apellido} (DNI ${solicitud.dni}) — Fecha: ${fechaHoy}`);
  } catch (err) {
    console.error('Error procesando webhook MP:', err);
  }
});

// ═══════════════════════════════════
//  PAGAR CUOTA — socio existente
// ═══════════════════════════════════
app.post('/api/socio-pagar-cuota', async (req, res) => {
  const { dni, cuota_id } = req.body;
  if (!dni || !cuota_id) return res.status(400).json({ error: 'Faltan datos' });

  const socio = (await pool.query('SELECT * FROM socios WHERE dni = $1', [dni.trim()])).rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const cuota = (await pool.query('SELECT * FROM cuotas WHERE id = $1 AND socio_id = $2', [cuota_id, socio.id])).rows[0];
  if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' });
  if (cuota.pagado) return res.status(400).json({ error: 'Esta cuota ya está pagada' });

  const mpClient = getMPClient();
  if (!mpClient) return res.status(503).json({ error: 'Pagos no disponibles' });

  try {
    const preference = new Preference(mpClient);
    const monto = cuota.monto && cuota.monto > 0 ? Number(cuota.monto) : 10000;
    const pref = await preference.create({
      body: {
        items: [{
          title: `Cuota ${cuota.mes} — Recreativo Estrellas F.C.`,
          quantity: 1,
          unit_price: monto,
          currency_id: 'ARS'
        }],
        payer: { name: socio.nombre, surname: socio.apellido },
        external_reference: `cuota:${socio.id}:${cuota.id}`,
        back_urls: {
          success: `${BASE_URL}/pago-cuota-exitoso.html`,
          failure:  `${BASE_URL}/pago-fallido.html`,
          pending:  `${BASE_URL}/pago-pendiente.html`
        },
        auto_return: 'approved'
      }
    });
    res.json({ init_point: pref.init_point });
  } catch (err) {
    console.error('Error MP cuota:', err);
    res.status(500).json({ error: 'Error al generar el pago' });
  }
});

// ─── Confirmar pago de cuota (respaldo al webhook) ───
app.post('/api/mp-cuota-confirmar', async (req, res) => {
  const { payment_id, socio_id, cuota_id } = req.body;
  if (!payment_id || !socio_id || !cuota_id) return res.status(400).json({ error: 'Faltan datos' });

  const mpClient = getMPClient();
  if (!mpClient) return res.status(503).json({ error: 'MP no configurado' });

  try {
    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: payment_id });

    if (payment.status !== 'approved') {
      return res.status(400).json({ error: 'El pago no está aprobado', status: payment.status });
    }

    const cuota = (await pool.query('SELECT * FROM cuotas WHERE id = $1 AND socio_id = $2', [cuota_id, socio_id])).rows[0];
    if (!cuota) return res.status(404).json({ error: 'Cuota no encontrada' });

    if (cuota.pagado) return res.json({ ok: true, ya_registrado: true });

    const fechaHoy = new Date().toISOString().split('T')[0];
    await pool.query(
      'UPDATE cuotas SET pagado=1, fecha_pago=$1, comprobante=$2 WHERE id=$3',
      [fechaHoy, String(payment.id), cuota_id]
    );
    await pool.query("UPDATE socios SET estado='al-dia' WHERE id=$1", [socio_id]);

    const socio = (await pool.query('SELECT nombre, apellido FROM socios WHERE id = $1', [socio_id])).rows[0];
    console.log(`✅ [CONFIRMAR] Cuota pagada: socio ${socio_id}, cuota ${cuota_id} — ${fechaHoy}`);
    res.json({ ok: true, ya_registrado: false, socio, mes: cuota.mes });
  } catch (err) {
    console.error('Error en mp-cuota-confirmar:', err);
    res.status(500).json({ error: 'Error verificando el pago' });
  }
});

// ═══════════════════════════════════
//  PORTAL SOCIO
// ═══════════════════════════════════
app.post('/api/socio-login', async (req, res) => {
  const { dni } = req.body;
  if (!dni) return res.status(400).json({ error: 'Ingresá tu DNI' });

  const { rows } = await pool.query('SELECT * FROM socios WHERE dni = $1', [dni.trim()]);
  const socio = rows[0];
  if (!socio) return res.status(404).json({ error: 'No encontramos un socio con ese DNI' });

  const cuotas = (await pool.query(
    'SELECT * FROM cuotas WHERE socio_id = $1 ORDER BY mes DESC', [socio.id]
  )).rows;

  const mesActual = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const estadoReal = cuotas.some(c => c.mes && c.mes.startsWith(mesActual) && c.pagado) ? 'al-dia' : 'deuda';

  const token = jwt.sign({ id: socio.id, dni: socio.dni, rol: 'socio' }, SECRET, { expiresIn: '4h' });
  res.json({ token, socio: { nombre: socio.nombre, apellido: socio.apellido, dni: socio.dni, categoria: socio.categoria, estado: estadoReal, fecha_ingreso: socio.fecha_ingreso }, cuotas });
});

app.get('/api/socio-perfil', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No autorizado' });
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { return res.status(401).json({ error: 'Token inválido' }); }
  if (payload.rol !== 'socio') return res.status(403).json({ error: 'Acceso denegado' });

  const { rows } = await pool.query('SELECT * FROM socios WHERE id = $1', [payload.id]);
  const socio = rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const cuotas = (await pool.query(
    'SELECT * FROM cuotas WHERE socio_id = $1 ORDER BY mes DESC', [socio.id]
  )).rows;

  const mesActual = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const estadoReal = cuotas.some(c => c.mes && c.mes.startsWith(mesActual) && c.pagado) ? 'al-dia' : 'deuda';

  res.json({ socio: { nombre: socio.nombre, apellido: socio.apellido, dni: socio.dni, categoria: socio.categoria, estado: estadoReal, fecha_ingreso: socio.fecha_ingreso }, cuotas });
});

// ═══════════════════════════════════
//  CONFIRMAR PAGO — respaldo al webhook
//  MP lo llama desde pago-exitoso.html con los params de la URL
// ═══════════════════════════════════
app.post('/api/mp-confirmar', async (req, res) => {
  const { payment_id, solicitud_id } = req.body;
  if (!payment_id || !solicitud_id) return res.status(400).json({ error: 'Faltan datos' });

  const mpClient = getMPClient();
  if (!mpClient) return res.status(503).json({ error: 'MP no configurado' });

  try {
    const paymentClient = new Payment(mpClient);
    const payment = await paymentClient.get({ id: payment_id });

    if (payment.status !== 'approved') {
      return res.status(400).json({ error: 'El pago no está aprobado', status: payment.status });
    }

    const solicitud = (await pool.query('SELECT * FROM solicitudes WHERE id = $1', [solicitud_id])).rows[0];
    if (!solicitud) return res.status(404).json({ error: 'Solicitud no encontrada' });

    // Si ya fue procesado por el webhook, devuelvo ok igual
    if (solicitud.estado === 'aprobado') {
      const socio = (await pool.query('SELECT id, nombre, apellido FROM socios WHERE dni = $1', [solicitud.dni])).rows[0];
      return res.json({ ok: true, ya_registrado: true, socio });
    }

    // Verificar que el payment pertenece a esta solicitud
    if (String(payment.external_reference) !== String(solicitud_id)) {
      return res.status(400).json({ error: 'El pago no coincide con la solicitud' });
    }

    // Verificar si el socio ya existe (por si el webhook lo creó a medias)
    const socioExiste = (await pool.query('SELECT id FROM socios WHERE dni = $1', [solicitud.dni])).rows[0];
    if (socioExiste) {
      await pool.query(
        "UPDATE solicitudes SET estado = 'aprobado', mp_payment_id = $1 WHERE id = $2",
        [String(payment.id), solicitud_id]
      );
      return res.json({ ok: true, ya_registrado: true });
    }

    const now = new Date();
    const fechaHoy = now.toISOString().split('T')[0];
    const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const socioResult = await pool.query(`
      INSERT INTO socios (nombre, apellido, dni, telefono, categoria, estado, fecha_ingreso)
      VALUES ($1, $2, $3, $4, 'general', 'al-dia', $5)
      RETURNING id, nombre, apellido
    `, [solicitud.nombre, solicitud.apellido, solicitud.dni, solicitud.telefono, fechaHoy]);

    await pool.query(`
      INSERT INTO cuotas (socio_id, mes, monto, pagado, fecha_pago, comprobante, notas)
      VALUES ($1, $2, 10000, 1, $3, $4, 'Pago via Mercado Pago — cuota de ingreso')
    `, [socioResult.rows[0].id, mes, fechaHoy, String(payment.id)]);

    await pool.query(
      "UPDATE solicitudes SET estado = 'aprobado', mp_payment_id = $1 WHERE id = $2",
      [String(payment.id), solicitud_id]
    );

    console.log(`✅ [CONFIRMAR] Socio registrado: ${solicitud.nombre} ${solicitud.apellido} — Fecha: ${fechaHoy}`);
    res.json({ ok: true, ya_registrado: false, socio: socioResult.rows[0] });
  } catch (err) {
    console.error('Error en mp-confirmar:', err);
    res.status(500).json({ error: 'Error verificando el pago' });
  }
});

// ═══════════════════════════════════
//  PAGAR CUOTA MES ACTUAL — crea la cuota si no existe todavía
// ═══════════════════════════════════
app.post('/api/socio-pagar-mes-actual', async (req, res) => {
  const { dni, mes } = req.body;
  if (!dni) return res.status(400).json({ error: 'Faltan datos' });

  const socio = (await pool.query('SELECT * FROM socios WHERE dni = $1', [dni.trim()])).rows[0];
  if (!socio) return res.status(404).json({ error: 'Socio no encontrado' });

  const now = new Date();
  const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Validar mes si se envía
  const mesTarget = mes || mesActual;
  if (!/^\d{4}-\d{2}$/.test(mesTarget)) {
    return res.status(400).json({ error: 'Formato de mes inválido' });
  }
  if (mesTarget > mesActual) {
    return res.status(400).json({ error: 'No se puede pagar un mes futuro' });
  }

  // Verificar si ya existe cuota para ese mes
  const cuotaExistente = (await pool.query(
    'SELECT * FROM cuotas WHERE socio_id = $1 AND mes = $2', [socio.id, mesTarget]
  )).rows[0];

  if (cuotaExistente?.pagado) {
    return res.status(400).json({ error: 'Esta cuota ya está pagada' });
  }

  // Usar la existente (no pagada) o crear una nueva
  let cuota = cuotaExistente;
  if (!cuota) {
    const result = await pool.query(
      'INSERT INTO cuotas (socio_id, mes, monto, pagado) VALUES ($1, $2, 10000, 0) RETURNING *',
      [socio.id, mesTarget]
    );
    cuota = result.rows[0];
  }

  const mpClient = getMPClient();
  if (!mpClient) return res.status(503).json({ error: 'Pagos no disponibles' });

  try {
    const preference = new Preference(mpClient);
    const monto = cuota.monto && cuota.monto > 0 ? Number(cuota.monto) : 10000;
    const pref = await preference.create({
      body: {
        items: [{
          title: `Cuota ${cuota.mes} — Recreativo Estrellas F.C.`,
          quantity: 1,
          unit_price: monto,
          currency_id: 'ARS'
        }],
        payer: { name: socio.nombre, surname: socio.apellido },
        external_reference: `cuota:${socio.id}:${cuota.id}`,
        back_urls: {
          success: `${BASE_URL}/pago-cuota-exitoso.html`,
          failure:  `${BASE_URL}/pago-fallido.html`,
          pending:  `${BASE_URL}/pago-pendiente.html`
        },
        auto_return: 'approved',
        notification_url: `${BASE_URL}/api/mp-webhook`
      }
    });
    res.json({ init_point: pref.init_point });
  } catch (err) {
    console.error('Error MP cuota mes actual:', err);
    res.status(500).json({ error: 'Error al generar el pago' });
  }
});

// ─── CATCH-ALL → login ───
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

// ─── START ───
initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 REFC Backend corriendo en http://localhost:${PORT}`);
      console.log(`   Usuarios disponibles:`);
      console.log(`   • admin  / refc2024   (administrador)`);
      console.log(`   • puerta / puerta123  (consulta en puerta)\n`);
    });
  })
  .catch(err => {
    console.error('Error inicializando DB:', err);
    process.exit(1);
  });
