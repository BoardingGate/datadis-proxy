/**
 * Proxy para la API privada de Datadis.es — versión Vercel (Node.js Serverless Function)
 * ----------------------------------------------------------------------------------------
 * Mismo comportamiento que el Worker de Cloudflare, pero corre en la red de Vercel
 * (AWS Lambda), evitando el conflicto Cloudflare-a-Cloudflare que provoca el error 530
 * al llamar a api.datadis.es desde un Worker.
 *
 * Ruta del archivo en tu repositorio/proyecto: api/datadis-proxy.js
 * URL pública en Vercel:
 *   https://<tu-proyecto>.vercel.app/api/datadis-proxy
 */

import { setDefaultResultOrder } from 'node:dns';

// Fix conocido: Node 18/20 a veces falla con ENOTFOUND al intentar
// resolver IPv6 primero en entornos serverless. Forzamos IPv4 primero.
setDefaultResultOrder('ipv4first');

// Cambia '*' por tu dominio real si deseas restringir quién puede llamar al proxy.
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

  // Destructuramos los campos enviados por el frontend
  const { username, password, cups, startDate, endDate, action } = req.body || {};

  // Para 'contracts' las fechas no son estrictamente obligatorias; para el resto sí
  if (!username || !password || ((!startDate || !endDate) && action !== 'contracts')) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: username, password, startDate, endDate.',
    });
  }

  const cabecerasNavegador = { 'User-Agent': 'Mozilla/5.0 (compatible; AnalizadorConsumo/1.0)' };

  // Helper para asegurar fechas con barras requeridas por Datadis
  const toSlashDate = (str) => (str ? String(str).replace(/-/g, '/').trim() : '');

  try {
    // 1. Login -> obtener token Bearer
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

    // 2. Suministros -> localizar CUPS y distributorCode
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


    // --- BIFURCACIÓN SEGÚN LA ACCIÓN ---

    if (action === 'max-power') {
      // 3. FLUJO DE POTENCIAS MÁXIMAS (Manual API Datadis: formato mensual YYYY/MM)
      const cleanStart = toSlashDate(startDate).substring(0, 7);
      const cleanEnd = toSlashDate(endDate).substring(0, 7);

      const paramsMaxPower = new URLSearchParams({
        cups: supply.cups,
        distributorCode: supply.distributorCode || '',
        startDate: cleanStart, // YYYY/MM
        endDate: cleanEnd,     // YYYY/MM
      });

      const maxPowerResp = await fetch(
        `https://datadis.es/api-private/api/get-max-power?${paramsMaxPower.toString()}`,
        { headers: authHeaders }
      );

      if (!maxPowerResp.ok) {
        const detalle = await maxPowerResp.text();
        return res.status(502).json({
          error: `Error al consultar potencias máximas (código ${maxPowerResp.status}): ${detalle}`,
        });
      }

      const maxPowerData = await maxPowerResp.json();
      return res.status(200).json(maxPowerData);

    } else if (action === 'contracts') {
      // 3. FLUJO DE CONTRATO (Manual API Datadis: get-contract-detail con cups y distributorCode)
      const paramsContrato = new URLSearchParams({
        cups: supply.cups,
        distributorCode: supply.distributorCode || '',
      });

      const contractResp = await fetch(
        `https://datadis.es/api-private/api/get-contract-detail?${paramsContrato.toString()}`,
        { headers: authHeaders }
      );

      if (!contractResp.ok) {
        const detalle = await contractResp.text();
        return res.status(502).json({
          error: `Error al consultar detalle del contrato (código ${contractResp.status}): ${detalle}`,
        });
      }

      const contractData = await contractResp.json();
      return res.status(200).json(contractData);

    } else {
      // 3. FLUJO DE CONSUMO HORARIO ESTÁNDAR (Manual API Datadis: get-consumption-data exige YYYY/MM/DD)
      const cleanStart = toSlashDate(startDate);
      const cleanEnd = toSlashDate(endDate);

      const params = new URLSearchParams({
        cups: supply.cups,
        distributorCode: supply.distributorCode || '',
        startDate: cleanStart, // YYYY/MM/DD con barras
        endDate: cleanEnd,     // YYYY/MM/DD con barras
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

      // Aseguramos que sea un array válido antes de responder
      if (!Array.isArray(consumptionData)) {
        return res.status(400).json({
          error: 'Datadis devolvió una respuesta no válida para el consumo.',
          raw: consumptionData,
        });
      }

      if (consumptionData.length === 0) {
        return res.status(404).json({ error: 'No hay lecturas disponibles para ese período.' });
      }

      return res.status(200).json({
        cups: supply.cups,
        supplies: supplies.map((s) => s.cups),
        consumptionData,
      });
    }

  } catch (err) {
    const causa = err.cause
      ? ` | causa: ${err.cause.code || err.cause.message || err.cause}${err.cause.hostname ? ` (host: ${err.cause.hostname})` : ''}`
      : '';
    return res.status(500).json({ error: `Error inesperado en el proxy: ${err.message}${causa}` });
  }
}
