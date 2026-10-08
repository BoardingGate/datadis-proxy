/**
 * Proxy para la API privada de Datadis.es y el Comparador Oficial CNMC
 * versión Vercel (Node.js Serverless Function)
 * ----------------------------------------------------------------------------------------
 * Ruta: api/datadis-proxy.js
 */

import { setDefaultResultOrder } from 'node:dns';

// Fix conocido: Node 18/20 en serverless
setDefaultResultOrder('ipv4first');

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

  const body = req.body || {};
  const { username, password, cups, startDate, endDate, action } = body;

  const cabecerasNavegador = { 'User-Agent': 'Mozilla/5.0 (compatible; AnalizadorConsumo/1.0)' };

// =========================================================================
  // BIFURCACIÓN 1: COMPARADOR OFICIAL CNMC (GET con parámetros)
  // =========================================================================
// =========================================================================
  // BIFURCACIÓN 1: COMPARADOR OFICIAL CNMC (Con gestión de sesión JSESSIONID)
  // =========================================================================
  if (action === 'cnmc') {
    try {
      const cp = body.codigoPostal || '28001';
      const p1 = parseFloat(body.potenciaP1) || 4.60;
      const p2 = parseFloat(body.potenciaP2) || 4.60;
      const cPunta = Math.round(parseFloat(body.consumoPunta) || 0);
      const cLlano = Math.round(parseFloat(body.consumoLlano) || 0);
      const cValle = Math.round(parseFloat(body.consumoValle) || 0);

      const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

      // 1. OBTENER SESIÓN DE LA CNMC (Recoger cookie JSESSIONID)
      let cookieSession = '';
      try {
        const initResp = await fetch('https://comparador.cnmc.gob.es/comparador/inicio', {
          headers: { 'User-Agent': userAgent }
        });
        const rawCookie = initResp.headers.get('set-cookie');
        if (rawCookie) {
          cookieSession = rawCookie.split(';')[0];
        }
      } catch (e) {
        console.warn('No se pudo inicializar cookie de CNMC:', e);
      }

      // 2. PARÁMETROS DE LA CONSULTA
      const cnmcPayload = {
        tipoConsumidor: 'DOMESTICO',
        tipoOferta: 'E',
        codigoPostal: cp,
        peaje: '2.0TD',
        potenciaP1: p1,
        potenciaP2: p2,
        consumoPunta: cPunta,
        consumoLlano: cLlano,
        consumoValle: cValle,
        filtroPermanencia: false,
        filtroFacturaElectronica: false
      };

      const requestHeaders = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://comparador.cnmc.gob.es',
        'Referer': 'https://comparador.cnmc.gob.es/comparador/inicio',
        'User-Agent': userAgent
      };

      if (cookieSession) {
        requestHeaders['Cookie'] = cookieSession;
      }

      // 3. CONSULTA A LA API DE LA CNMC
      let cnmcResp = await fetch('https://comparador.cnmc.gob.es/comparador/rest/ofertas/electricidad/buscar', {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(cnmcPayload)
      });

      const rawText = await cnmcResp.text();

      // Comprobar si la respuesta es HTML (bloqueo) o JSON válido
      if (rawText.trim().startsWith('<')) {
        // Si el cortafuegos de la CNMC devuelve HTML, usamos el catálogo oficial consolidado
        const backupResp = await fetch('https://raw.githubusercontent.com/BoardingGate/INDEXADA/main/cnmc_catalogo_oficial.json');
        if (backupResp.ok) {
          const backupData = await backupResp.json();
          return res.status(200).json(backupData);
        }
        return res.status(502).json({
          error: 'El cortafuegos de la CNMC solicita verificación interactiva. Por favor, abre el comparador manualmente.'
        });
      }

      const cnmcData = JSON.parse(rawText);
      return res.status(200).json(cnmcData);

    } catch (err) {
      return res.status(500).json({
        error: `Error al procesar la respuesta de la CNMC: ${err.message}`
      });
    }
  }

  // =========================================================================
  // BIFURCACIÓN 2: DATADIS (Requiere credenciales)
  // =========================================================================
  if (!username || !password || !startDate || !endDate) {
    return res.status(400).json({
      error: 'Faltan campos obligatorios: username, password, startDate, endDate.',
    });
  }

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


    // --- ACCIONES ESPECÍFICAS DE DATADIS ---

    if (action === 'max-power') {
      const paramsMaxPower = new URLSearchParams({
        cups: supply.cups,
        distributorCode: supply.distributorCode || '',
        startDate,
        endDate,
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
      // Flujo de consumo estándar
      const params = new URLSearchParams({
        cups: supply.cups,
        distributorCode: supply.distributorCode || '',
        startDate,
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
    }

  } catch (err) {
    const causa = err.cause
      ? ` | causa: ${err.cause.code || err.cause.message || err.cause}${err.cause.hostname ? ` (host: ${err.cause.hostname})` : ''}`
      : '';
    return res.status(500).json({ error: `Error inesperado en el proxy: ${err.message}${causa}` });
  }
}
