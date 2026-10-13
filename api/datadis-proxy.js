/**
 * Proxy para la API privada de Datadis.es — versión Vercel (Node.js Serverless Function)
 * ----------------------------------------------------------------------------------------
 * Mismo comportamiento que el Worker de Cloudflare, pero corre en la red de Vercel
 * (AWS Lambda), evitando el conflicto Cloudflare-a-Cloudflare que provoca el error 530
 * al llamar a api.datadis.es desde un Worker.
 *
 * Ruta del archivo importante para Vercel: api/datadis-proxy.js
 * Una vez desplegado, la URL pública será:
 *   https://<tu-proyecto>.vercel.app/api/datadis-proxy
 */

import { setDefaultResultOrder } from 'node:dns';

// Fix conocido: Node 18/20 a veces falla con ENOTFOUND al intentar
// resolver IPv6 primero en entornos serverless. Forzamos IPv4 primero.
setDefaultResultOrder('ipv4first');

// Cambia '*' por tu dominio real para restringir quién puede llamar al proxy.
const ALLOWED_ORIGIN = '*';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usa POST.' });
  }

  const { username, password, cups, startDate, endDate } = req.body || {};

  if (!username || !password || !startDate || !endDate) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: username, password, startDate, endDate.',
    });
  }

  const cabecerasNavegador = { 'User-Agent': 'Mozilla/5.0 (compatible; AnalizadorConsumo/1.0)' };

  try {
    // 1. Login -> obtener token
    const loginResp = await fetch('https://datadis.es/nikola-auth/tokens/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...cabecerasNavegador,
      },
      body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
    });

    if (!loginResp.ok) {
      return res.status(401).json({
        error: `Login rechazado por Datadis (código ${loginResp.status}). Revisa usuario/contraseña.`,
      });
    }

    const token = (await loginResp.text()).trim();
    if (!token) {
      return res.status(401).json({ error: 'Datadis no devolvió un token válido.' });
    }

    const authHeaders = { Authorization: `Bearer ${token}`, ...cabecerasNavegador };

    // 2. Suministros -> localizar CUPS
    const suppliesResp = await fetch('https://datadis.es/api-private/api/get-supplies', {
      headers: authHeaders,
    });
    if (!suppliesResp.ok) {
      const detalle = await suppliesResp.text();
      return res.status(502).json({
        error: `Error al consultar suministros (código ${suppliesResp.status}): ${detalle}`,
      });
    }
    const supplies = await suppliesResp.json();
    if (!Array.isArray(supplies) || supplies.length === 0) {
      return res.status(404).json({ error: 'No se encontraron suministros en la cuenta.' });
    }

    const supply = cups ? supplies.find((s) => s.cups === cups) || supplies[0] : supplies[0];

    // 3. Lecturas de consumo
    const params = new URLSearchParams({
      cups: supply.cups,
      distributorCode: supply.distributorCode || '',
      startDate, // formato esperado por Datadis: YYYY/MM/DD
      endDate,
      measurementType: '0',
      pointType: String(supply.pointType || 5),
    });

    const consumptionResp = await fetch(
      `https://datadis.es/api-private/api/get-consumption-data?${params.toString()}`,
      { headers: authHeaders }
    );

    if (!consumptionResp.ok) {
      const detalle = await consumptionResp.text();
      return res.status(502).json({
        error: `Error al descargar lecturas (código ${consumptionResp.status}): ${detalle}`,
      });
    }

    const consumptionData = await consumptionResp.json();
    if (!Array.isArray(consumptionData) || consumptionData.length === 0) {
      return res.status(404).json({ error: 'No hay lecturas disponibles para ese período.' });
    }

    return res.status(200).json({
      cups: supply.cups,
      supplies: supplies.map((s) => s.cups),
      consumptionData,
    });
  } catch (err) {
    const causa = err.cause
      ? ` | causa: ${err.cause.code || err.cause.message || err.cause}${err.cause.hostname ? ` (host: ${err.cause.hostname})` : ''}`
      : '';
    return res.status(500).json({ error: `Error inesperado en el proxy: ${err.message}${causa}` });
  }
}
