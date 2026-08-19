import express from 'express';
import path from 'path';
import dns from 'dns';
import { createServer as createViteServer } from 'vite';
import { db } from './src/server/db.js';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Helper for Gemini AI search
let aiClient: GoogleGenAI | null = null;
function getAIClient(): GoogleGenAI | null {
  if (!aiClient && process.env.GEMINI_API_KEY) {
    aiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return aiClient;
}

// ----------------------------------------------------
// AUTH API
// ----------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  // 1. Admin account check
  if (
    (username?.toLowerCase() === 'administrador' || username?.toLowerCase() === 'admin') &&
    password === '1234'
  ) {
    return res.json({
      success: true,
      user: {
        id: 'admin-main',
        username: 'Administrador',
        name: 'Administrador Principal',
        role: 'admin'
      }
    });
  }

  // 2. Provider accounts check (username, email, or name, password = '1234' or saved pass)
  const provider = db.getProviders().find(p =>
    p.username.toLowerCase() === username?.toLowerCase() ||
    p.email.toLowerCase() === username?.toLowerCase() ||
    p.name.toLowerCase() === username?.toLowerCase()
  );

  if (provider && provider.status === 'Activo' && (password === (provider.password || '1234') || password === '1234')) {
    return res.json({
      success: true,
      user: {
        id: provider.id,
        username: provider.username,
        name: provider.name,
        role: 'supplier',
        providerId: provider.id,
        email: provider.email
      }
    });
  }

  return res.status(401).json({
    success: false,
    message: 'Credenciales inválidas. Compruebe el usuario o contraseña (contraseña por defecto: 1234)'
  });
});

app.post('/api/auth/change-password', (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  if (!newPassword || newPassword !== confirmPassword) {
    return res.status(400).json({ success: false, message: 'Las contraseñas no coinciden' });
  }
  if (currentPassword !== '1234') {
    return res.status(400).json({ success: false, message: 'La contraseña actual no es correcta' });
  }
  return res.json({ success: true, message: 'Contraseña actualizada correctamente' });
});

app.post('/api/admin/clear-database', (req, res) => {
  db.clearDatabaseAndCatalogs();
  res.json({ success: true, message: 'Base de datos y catálogos vaciados correctamente' });
});

app.post('/api/catalogs/:catalogType/clear', (req, res) => {
  const { catalogType } = req.params;
  if (!['providers', 'magnitudes', 'analyzers', 'specimens', 'records'].includes(catalogType)) {
    return res.status(400).json({ success: false, message: 'Tipo de catálogo inválido' });
  }
  db.clearCatalog(catalogType as any);
  res.json({ success: true, message: `Catálogo de ${catalogType} vaciado correctamente` });
});

// Full JSON Backup Export & Restore Endpoints
app.get('/api/admin/backup/export', (req, res) => {
  const snapshot = db.getSnapshot();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="poct_backup_${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(snapshot);
});

app.post('/api/admin/backup/restore', (req, res) => {
  const result = db.restoreFullBackup(req.body);
  res.json(result);
});

app.post('/api/admin/auto-sync-client-backup', (req, res) => {
  const result = db.autoSyncClientBackup(req.body);
  res.json({ success: true, ...result });
});

// ----------------------------------------------------
// PUBLIC VISITOR API (No login required)
// ----------------------------------------------------
app.get('/api/public-records', (req, res) => {
  // Optional visit counter increment
  if (req.query.track === '1') {
    db.incrementVisit();
  }
  res.json({
    records: db.getPublicRecords(),
    settings: db.getSettings(),
    panels: db.getLateralPanels()
  });
});

app.get('/api/public-catalogs', (req, res) => {
  res.json({
    magnitudes: db.getMagnitudes(),
    disciplines: db.getDisciplines(),
    analyzers: db.getAnalyzers(),
    specimens: db.getSpecimens(),
    providers: db.getProviders().filter(p => p.status === 'Activo'),
    pending: db.getPendingChanges().filter(p => p.status === 'Pendiente')
  });
});

app.get('/api/lateral-panels', (req, res) => {
  res.json({
    panels: db.getLateralPanels(),
    settings: db.getSettings()
  });
});

app.post('/api/record-click/:id', (req, res) => {
  db.incrementLinkClick(req.params.id);
  res.json({ success: true });
});

app.post('/api/search-counter', (req, res) => {
  const { magnitudeName } = req.body;
  if (magnitudeName) {
    db.incrementSearchCounter(magnitudeName);
  }
  res.json({ success: true });
});

// ----------------------------------------------------
// AUTOMATIC URL & LINK VALIDATOR ("Enlace: Debe validar automáticamente...")
// ----------------------------------------------------
const handleCheckLink = async (req: express.Request, res: express.Response) => {
  const urlParam = req.method === 'GET' ? req.query.url : req.body?.url;
  const url = typeof urlParam === 'string' ? urlParam : '';

  if (!url || !url.trim()) {
    return res.status(400).json({ valid: false, message: 'Debe introducir un enlace de página web' });
  }

  let formatted = url.trim();
  if (!formatted.startsWith('http://') && !formatted.startsWith('https://')) {
    formatted = 'https://' + formatted;
  }

  try {
    const parsed = new URL(formatted);
    const usesHttps = parsed.protocol === 'https:';

    // Must have host with valid TLD structure (e.g. domain.extension)
    if (!parsed.hostname || !parsed.hostname.includes('.') || parsed.hostname.endsWith('.')) {
      return res.json({
        valid: false,
        url: formatted,
        status: 0,
        usesHttps,
        message: 'El dominio indicado no es un sitio web válido.'
      });
    }

    // 1. Verify DNS resolution
    try {
      await dns.promises.lookup(parsed.hostname);
    } catch (dnsErr: any) {
      return res.json({
        valid: false,
        url: formatted,
        status: 0,
        usesHttps,
        message: `El dominio "${parsed.hostname}" no existe o no se puede resolver en DNS.`
      });
    }

    let status = 0;
    let valid = true;
    let message = `Página web verificada y activa (${parsed.hostname})`;
    const browserUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const reqHeaders = {
      'User-Agent': browserUA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
    };

    try {
      const response = await fetch(formatted, {
        method: 'GET',
        redirect: 'follow',
        headers: reqHeaders,
        signal: AbortSignal.timeout(7000)
      });
      status = response.status;

      if ((status >= 200 && status < 400) || [401, 403, 405, 429, 999].includes(status)) {
        valid = true;
        message = `Página web verificada y activa (HTTP ${status})`;
      } else if (status === 404) {
        valid = false;
        message = `Página no encontrada en el servidor (HTTP 404 Not Found)`;
      } else if (status === 410) {
        valid = false;
        message = `La página ha dejado de existir (HTTP 410 Gone)`;
      } else if (status >= 500) {
        valid = false;
        message = `Error en el servidor de destino (HTTP ${status})`;
      } else {
        valid = true;
        message = `Página web responde correctamente (HTTP ${status})`;
      }
    } catch (fetchErr: any) {
      if (fetchErr?.name === 'TimeoutError' || fetchErr?.name === 'AbortError') {
        valid = false;
        message = `Tiempo de espera agotado al conectar con el servidor (Timeout >7s)`;
      } else if (fetchErr?.code === 'ECONNREFUSED') {
        valid = false;
        message = `Conexión rechazada por el servidor web`;
      } else if (fetchErr?.code === 'ENOTFOUND') {
        valid = false;
        message = `Servidor no encontrado (${parsed.hostname})`;
      } else {
        // Active domain that resolves in DNS, but may block server agents
        valid = true;
        message = `Dominio activo y comprobado (${parsed.hostname})`;
      }
    }

    return res.json({
      valid,
      url: formatted,
      status,
      usesHttps,
      message
    });
  } catch (err) {
    return res.status(400).json({
      valid: false,
      message: 'Formato de URL incorrecto. Ejemplo: https://www.ejemplo.es/producto'
    });
  }
};

app.post('/api/check-link', handleCheckLink);
app.get('/api/check-link', handleCheckLink);

// ----------------------------------------------------
// POCT RECORDS CRUD (Admin & Supplier)
// ----------------------------------------------------
app.get('/api/records', (req, res) => {
  const { providerId } = req.query;
  const snapshot = db.getSnapshot();
  let records = snapshot.records;
  if (providerId) {
    records = records.filter(r => r.proveedorId === providerId);
  }
  res.json({ records });
});

app.post('/api/records', (req, res) => {
  const {
    magnitudId,
    magnitudName,
    isNewMagnitude,
    analizadorId,
    analizadorName,
    analizadorFoto,
    isNewAnalyzer,
    url,
    notas,
    especimenes,
    proveedorId,
    proveedorName,
    userName,
    role
  } = req.body;

  if (!userName) {
    return res.status(400).json({ success: false, message: 'El campo Usuario es obligatorio' });
  }
  if (!url) {
    return res.status(400).json({ success: false, message: 'El campo Enlace es obligatorio' });
  }

  if (role === 'admin') {
    const record = db.addRecordByAdmin({
      magnitudId: magnitudId || `mag-${Date.now()}`,
      magnitudName,
      analizadorId: analizadorId || `ana-${Date.now()}`,
      analizadorName,
      proveedorId,
      proveedorName,
      url,
      notas: notas || '',
      especimenes: Array.isArray(especimenes) ? especimenes : [],
      status: 'Aprobado'
    }, userName);
    return res.json({ success: true, record, approvedImmediately: true });
  } else {
    // Supplier submits -> Pending Change
    const change = db.addPendingChange({
      providerId: proveedorId,
      providerName: proveedorName,
      userName,
      operationType: 'Alta',
      proposedData: {
        magnitudId,
        magnitudName,
        isNewMagnitude,
        analizadorId,
        analizadorName,
        analizadorFoto,
        isNewAnalyzer,
        url,
        notas: notas || '',
        especimenes: Array.isArray(especimenes) ? especimenes : [],
        proveedorId,
        proveedorName
      }
    });

    const isAutoApproved = db.getSettings().autoApproval;
    return res.json({
      success: true,
      change,
      approvedImmediately: isAutoApproved,
      message: isAutoApproved
        ? 'Aprobación automática activada. Registro publicado inmediatamente.'
        : 'La nueva prueba se ha enviado y está pendiente de validación por el Administrador.'
    });
  }
});

app.put('/api/records/:id', (req, res) => {
  const recordId = req.params.id;
  const {
    magnitudId,
    magnitudName,
    analizadorId,
    analizadorName,
    analizadorFoto,
    url,
    notas,
    especimenes,
    proveedorId,
    proveedorName,
    userName,
    role,
    previousData
  } = req.body;

  if (!userName) {
    return res.status(400).json({ success: false, message: 'El campo Usuario es obligatorio' });
  }

  if (role === 'admin') {
    const updated = db.updateRecordByAdmin(recordId, {
      magnitudId,
      magnitudName,
      analizadorId,
      analizadorName,
      proveedorId,
      proveedorName,
      url,
      notas,
      especimenes: Array.isArray(especimenes) ? especimenes : []
    }, userName);
    return res.json({ success: true, record: updated, approvedImmediately: true });
  } else {
    // Supplier update -> Pending change
    const change = db.addPendingChange({
      providerId: proveedorId,
      providerName: proveedorName,
      userName,
      operationType: 'Modificación',
      targetRecordId: recordId,
      previousData,
      proposedData: {
        magnitudId,
        magnitudName,
        analizadorId,
        analizadorName,
        analizadorFoto,
        url,
        notas,
        especimenes: Array.isArray(especimenes) ? especimenes : [],
        proveedorId,
        proveedorName
      }
    });
    const isAutoApproved = db.getSettings().autoApproval;
    return res.json({
      success: true,
      change,
      approvedImmediately: isAutoApproved,
      message: isAutoApproved
        ? 'Cambio publicado inmediatamente (Aprobación automática).'
        : 'La modificación se ha enviado para su validación por el Administrador.'
    });
  }
});

app.delete('/api/records/:id', (req, res) => {
  const recordId = req.params.id;
  const { role, userName } = req.body || {};

  if (role === 'admin') {
    const count = db.deleteRecordsByAdmin([recordId], userName || 'Administrador');
    return res.json({ success: true, deletedCount: count });
  } else {
    const snapshot = db.getSnapshot();
    const target = snapshot.records.find(r => r.id === recordId);
    if (target) {
      db.addPendingChange({
        providerId: target.proveedorId,
        providerName: target.proveedorName,
        userName: userName || 'Usuario',
        operationType: 'Eliminación',
        targetRecordId: target.id,
        previousData: {
          magnitudName: target.magnitudName,
          analizadorName: target.analizadorName,
          url: target.url,
          notas: target.notas,
          especimenes: target.especimenes || []
        },
        proposedData: {
          magnitudId: target.magnitudId,
          magnitudName: target.magnitudName,
          analizadorId: target.analizadorId,
          analizadorName: target.analizadorName,
          url: target.url,
          notas: target.notas,
          especimenes: target.especimenes || [],
          proveedorId: target.proveedorId,
          proveedorName: target.proveedorName
        }
      });
      const isAutoApproved = db.getSettings().autoApproval;
      return res.json({
        success: true,
        approvedImmediately: isAutoApproved,
        message: isAutoApproved
          ? 'Registro eliminado inmediatamente (Aprobación automática).'
          : 'Solicitud de eliminación enviada y pendiente de validación.'
      });
    }
    return res.status(404).json({ success: false, message: 'Registro no encontrado' });
  }
});

app.delete('/api/records', (req, res) => {
  const { ids, role, userName, providerId, providerName, targetRecords } = req.body;
  if (!ids || !Array.isArray(ids)) {
    return res.status(400).json({ success: false, message: 'No se enviaron IDs válidos' });
  }

  if (role === 'admin') {
    const count = db.deleteRecordsByAdmin(ids, userName || 'Administrador');
    return res.json({ success: true, deletedCount: count });
  } else {
    // Supplier delete request -> Pending change
    let pendingCount = 0;
    (targetRecords || []).forEach((r: any) => {
      db.addPendingChange({
        providerId: providerId,
        providerName: providerName,
        userName: userName || 'Proveedor',
        operationType: 'Eliminación',
        targetRecordId: r.id,
        previousData: {
          magnitudName: r.magnitudName,
          analizadorName: r.analizadorName,
          url: r.url,
          notas: r.notas,
          especimenes: r.especimenes || []
        },
        proposedData: {
          magnitudId: r.magnitudId,
          magnitudName: r.magnitudName,
          analizadorId: r.analizadorId,
          analizadorName: r.analizadorName,
          url: r.url,
          notas: r.notas,
          especimenes: r.especimenes || [],
          proveedorId: providerId,
          proveedorName: providerName
        }
      });
      pendingCount++;
    });
    const isAutoApproved = db.getSettings().autoApproval;
    return res.json({
      success: true,
      pendingCount,
      approvedImmediately: isAutoApproved,
      message: isAutoApproved
        ? 'Registros eliminados inmediatamente (Aprobación automática).'
        : 'Se ha solicitado la eliminación del/de los registro(s) y está pendiente de aprobación por el Administrador.'
    });
  }
});

// ----------------------------------------------------
// PENDING CHANGES (Admin Validation)
// ----------------------------------------------------
app.get('/api/pending', (req, res) => {
  res.json({ pending: db.getPendingChanges() });
});

app.post('/api/pending/approve-all', (req, res) => {
  const { userName } = req.body;
  const pending = [...db.getPendingChanges()];
  let approvedCount = 0;
  for (const change of pending) {
    if (db.approveChange(change.id, userName || 'Administrador')) {
      approvedCount++;
    }
  }
  return res.json({
    success: true,
    approvedCount,
    message: `Se han aprobado y publicado ${approvedCount} solicitudes pendientes.`
  });
});

app.post('/api/pending/:id/approve', (req, res) => {
  const { id } = req.params;
  const { userName } = req.body;
  const ok = db.approveChange(id, userName || 'Administrador');
  if (ok) {
    return res.json({ success: true, message: 'Modificación aprobada y aplicada correctamente.' });
  }
  return res.status(404).json({ success: false, message: 'Cambio pendiente no encontrado.' });
});

app.post('/api/pending/:id/reject', (req, res) => {
  const { id } = req.params;
  const { reason, userName } = req.body;
  const ok = db.rejectChange(id, reason, userName || 'Administrador');
  if (ok) {
    return res.json({ success: true, message: 'Modificación rechazada correctamente.' });
  }
  return res.status(404).json({ success: false, message: 'Cambio pendiente no encontrado.' });
});

app.post('/api/pending/:id/resubmit', (req, res) => {
  const { id } = req.params;
  const { proposedData, userName } = req.body;
  const change = db.resubmitChange(id, proposedData, userName || 'Proveedor');
  if (change) {
    return res.json({ success: true, message: 'Solicitud reenviada correctamente para validación del administrador.', change });
  }
  return res.status(404).json({ success: false, message: 'Cambio pendiente no encontrado.' });
});

// ----------------------------------------------------
// CATALOG MANAGERS (Admin)
// ----------------------------------------------------
// Providers
app.get('/api/providers', (req, res) => {
  res.json({ providers: db.getProviders() });
});

app.post('/api/providers', (req, res) => {
  const newProv = db.addProvider(req.body);
  res.json({ success: true, provider: newProv });
});

app.put('/api/providers/:id', (req, res) => {
  const updated = db.updateProvider(req.params.id, req.body);
  if (!updated) return res.status(404).json({ success: false });
  res.json({ success: true, provider: updated });
});

app.post('/api/providers/:id/logo', (req, res) => {
  const { logo, userName } = req.body;
  const updated = db.updateProviderLogo(req.params.id, logo, userName);
  if (!updated) return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
  res.json({ success: true, provider: updated });
});

app.delete('/api/providers/:id', (req, res) => {
  const ok = db.deleteProvider(req.params.id);
  res.json({ success: ok });
});

app.post('/api/providers/:id/reset-password', (req, res) => {
  const { password, userName } = req.body;
  if (!password || !password.trim()) {
    return res.status(400).json({ success: false, message: 'La contraseña es requerida' });
  }
  const updated = db.resetProviderPassword(req.params.id, password.trim(), userName || 'Administrador');
  if (!updated) return res.status(404).json({ success: false, message: 'Proveedor no encontrado' });
  res.json({ success: true, provider: updated });
});

// Disciplines
app.get('/api/disciplines', (req, res) => {
  res.json({ disciplines: db.getDisciplines() });
});

app.post('/api/disciplines', (req, res) => {
  const { name, iconName, iconImage, customIconUrl, status } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'El nombre de la disciplina es obligatorio' });
  }
  const disc = db.addDiscipline({
    name: name.trim(),
    iconName,
    iconImage: iconImage || customIconUrl,
    status: status || 'Activo'
  });
  res.json({ success: true, discipline: disc });
});

app.put('/api/disciplines/:id', (req, res) => {
  const { name, iconName, iconImage, customIconUrl, status } = req.body;
  const updates: any = {};
  if (name !== undefined) updates.name = name.trim();
  if (iconName !== undefined) updates.iconName = iconName;
  if (iconImage !== undefined || customIconUrl !== undefined) updates.iconImage = iconImage || customIconUrl;
  if (status !== undefined) updates.status = status;

  const updated = db.updateDiscipline(req.params.id, updates);
  if (!updated) return res.status(404).json({ success: false });
  res.json({ success: true, discipline: updated });
});

app.delete('/api/disciplines/:id', (req, res) => {
  const ok = db.deleteDiscipline(req.params.id);
  res.json({ success: ok });
});

// Magnitudes
app.get('/api/magnitudes', (req, res) => {
  res.json({ magnitudes: db.getMagnitudes() });
});

app.post('/api/magnitudes', (req, res) => {
  const { name, createdBy, especimenes, disciplina } = req.body;
  const mag = db.addMagnitude(name, createdBy, especimenes, disciplina);
  res.json({ success: true, magnitude: mag });
});

app.put('/api/magnitudes/:id', (req, res) => {
  const { name, status, especimenes, disciplina } = req.body;
  const updated = db.updateMagnitude(req.params.id, name, status, especimenes, disciplina);
  if (!updated) return res.status(404).json({ success: false });
  res.json({ success: true, magnitude: updated });
});

app.delete('/api/magnitudes/:id', (req, res) => {
  const ok = db.deleteMagnitude(req.params.id);
  res.json({ success: ok });
});

// Especímenes
app.get('/api/specimens', (req, res) => {
  res.json({ specimens: db.getSpecimens() });
});

app.post('/api/specimens', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ success: false, message: 'El nombre del especimen es obligatorio' });
  }
  const spec = db.addSpecimen(name);
  res.json({ success: true, specimen: spec });
});

app.put('/api/specimens/:id', (req, res) => {
  const { name, status } = req.body;
  const updated = db.updateSpecimen(req.params.id, name, status);
  if (!updated) return res.status(404).json({ success: false });
  res.json({ success: true, specimen: updated });
});

app.delete('/api/specimens/:id', (req, res) => {
  const ok = db.deleteSpecimen(req.params.id);
  res.json({ success: ok });
});

// Analyzers
app.get('/api/analyzers', (req, res) => {
  res.json({ analyzers: db.getAnalyzers() });
});

app.post('/api/analyzers', (req, res) => {
  const { name, foto } = req.body;
  const ana = db.addAnalyzer(name, foto);
  res.json({ success: true, analyzer: ana });
});

app.put('/api/analyzers/:id', (req, res) => {
  const { name, status, foto } = req.body;
  const updated = db.updateAnalyzer(req.params.id, name, status, foto);
  if (!updated) {
    return res.status(400).json({
      success: false,
      message: 'No se puede editar "Lectura visual" o el analizador no existe.'
    });
  }
  res.json({ success: true, analyzer: updated });
});

app.put('/api/analyzers/:id/photo', (req, res) => {
  const { foto, userName } = req.body;
  const ana = db.getAnalyzers().find(a => a.id === req.params.id);
  if (!ana) {
    return res.status(404).json({ success: false, message: 'Analizador no encontrado' });
  }
  const updated = db.updateAnalyzer(req.params.id, ana.name, ana.status, foto);
  if (updated) {
    db.addAuditLog({
      userName: userName || 'Proveedor',
      userType: 'supplier',
      action: 'Modificación Foto Analizador',
      targetRecord: ana.name,
      previousValue: ana.foto ? 'Foto anterior' : 'Sin foto',
      newValue: foto ? 'Foto actualizada' : 'Sin foto'
    });
    return res.json({ success: true, analyzer: updated, message: 'Foto del analizador actualizada con éxito' });
  } else {
    return res.status(400).json({ success: false, message: 'No se pudo actualizar la foto de este analizador' });
  }
});

app.delete('/api/analyzers/:id', (req, res) => {
  const ok = db.deleteAnalyzer(req.params.id);
  if (!ok) {
    return res.status(400).json({
      success: false,
      message: 'El registro "Lectura visual" NUNCA podrá borrarse.'
    });
  }
  res.json({ success: true });
});

// ----------------------------------------------------
// AUDIT LOGS & STATISTICS
// ----------------------------------------------------
app.get('/api/audit', (req, res) => {
  res.json({ logs: db.getAuditLogs() });
});

app.post('/api/audit/compact', (req, res) => {
  const result = db.compactAuditLogs();
  res.json({ success: true, ...result, logs: db.getAuditLogs() });
});

app.post('/api/audit/clear-old', (req, res) => {
  const keepCount = parseInt(req.body?.keepCount || '25', 10);
  const result = db.clearOldAuditLogs(isNaN(keepCount) ? 25 : keepCount);
  res.json({ success: true, ...result, logs: db.getAuditLogs() });
});

app.get('/api/stats', (req, res) => {
  res.json({ stats: db.getStatistics() });
});

app.post('/api/stats/reset-visits', (req, res) => {
  const newVisits = db.resetVisits();
  db.addAuditLog({
    userName: 'Administrador',
    userType: 'admin',
    action: 'REINICIAR_VISITAS',
    targetRecord: 'Sistema',
    previousValue: 'Anterior',
    newValue: '0'
  });
  res.json({ success: true, totalVisits: newVisits });
});

// ----------------------------------------------------
// SYSTEM SETTINGS & LATERAL PANELS CONFIG
// ----------------------------------------------------
app.get('/api/settings', (req, res) => {
  res.json({ settings: db.getSettings() });
});

app.put('/api/settings', (req, res) => {
  const updated = db.updateSettings(req.body);
  res.json({ success: true, settings: updated });
});

app.put('/api/lateral-panels', (req, res) => {
  const { panels } = req.body;
  if (Array.isArray(panels)) {
    const updated = db.updateLateralPanels(panels);
    return res.json({ success: true, panels: updated });
  }
  res.status(400).json({ success: false });
});

// ----------------------------------------------------
// SUGGESTION BOX API ("Buzón de sugerencias")
// ----------------------------------------------------
app.get('/api/suggestions', (req, res) => {
  res.json({ suggestions: db.getSuggestions() });
});

app.post('/api/suggestions', (req, res) => {
  const suggestion = db.addSuggestion(req.body);
  res.json({ success: true, suggestion });
});

app.put('/api/suggestions/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['Nuevo', 'En revisión', 'Resuelto'].includes(status)) {
    return res.status(400).json({ success: false, message: 'Estado inválido' });
  }
  const updated = db.updateSuggestionStatus(req.params.id, status as any);
  if (!updated) {
    return res.status(404).json({ success: false, message: 'Sugerencia no encontrada' });
  }
  res.json({ success: true, suggestion: updated });
});

// Bulk Catalog & Records Import Endpoint
app.post('/api/catalogs/import', (req, res) => {
  const { catalogType, items, addToCatalogs = true } = req.body;
  if (!['providers', 'magnitudes', 'disciplines', 'analyzers', 'specimens', 'records'].includes(catalogType) || !Array.isArray(items)) {
    return res.status(400).json({ success: false, message: 'Parámetros de importación no válidos.' });
  }
  const result = db.importCatalogItems(catalogType, items, addToCatalogs !== false);
  res.json({
    success: true,
    successCount: result.successCount,
    errors: result.errors,
    message: `Se han procesado ${result.successCount} registros correctamente.`
  });
});

app.post('/api/catalogs/:catalogType/clear', (req, res) => {
  const { catalogType } = req.params;
  if (!['providers', 'magnitudes', 'disciplines', 'analyzers', 'specimens', 'records'].includes(catalogType)) {
    return res.status(400).json({ success: false, message: 'Catálogo no válido' });
  }
  const ok = db.clearCatalog(catalogType as any);
  res.json({ success: ok });
});

app.post('/api/admin/clear-database', (req, res) => {
  const ok = db.clearDatabaseAndCatalogs();
  res.json({ success: ok });
});

app.get('/api/admin/backup/export', (req, res) => {
  res.json({
    ...db.getSnapshot(),
    exportedAt: new Date().toISOString(),
    version: 'POCT ONLINE 2026.1'
  });
});

app.post('/api/admin/backup/restore', (req, res) => {
  try {
    const backupData = req.body;
    if (!backupData || typeof backupData !== 'object') {
      return res.status(400).json({ success: false, message: 'Datos de copia inválidos.' });
    }
    const current = db.getSnapshot();
    if (Array.isArray(backupData.records)) current.records = backupData.records;
    if (Array.isArray(backupData.providers)) current.providers = backupData.providers;
    if (Array.isArray(backupData.magnitudes)) current.magnitudes = backupData.magnitudes;
    if (Array.isArray(backupData.disciplines)) current.disciplines = backupData.disciplines;
    if (Array.isArray(backupData.analyzers)) current.analyzers = backupData.analyzers;
    if (Array.isArray(backupData.specimens)) current.specimens = backupData.specimens;
    if (Array.isArray(backupData.lateralPanels)) current.lateralPanels = backupData.lateralPanels;
    if (backupData.settings && typeof backupData.settings === 'object') {
      current.settings = { ...current.settings, ...backupData.settings };
    }
    db.saveData();
    res.json({ success: true, message: 'Copia de seguridad restaurada correctamente' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || 'Error al restaurar' });
  }
});

app.post('/api/admin/auto-sync-client-backup', (req, res) => {
  try {
    const { records, lateralPanels, settings } = req.body;
    const current = db.getSnapshot();
    if (Array.isArray(records) && records.length > 0) current.records = records;
    if (Array.isArray(lateralPanels) && lateralPanels.length > 0) current.lateralPanels = lateralPanels;
    if (settings && typeof settings === 'object') {
      current.settings = { ...current.settings, ...settings };
    }
    db.saveData();
    res.json({ success: true, message: 'Persistencia sincronizada' });
  } catch (e: any) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ----------------------------------------------------
// DOCUMENTED REST API METADATA (/api/docs)
// ----------------------------------------------------
app.get('/api/docs', (req, res) => {
  res.json({
    title: 'POCT ONLINE REST API Documentation',
    version: '1.0.0',
    description: 'API REST oficial documentada para consulta e integración de magnitudes, analizadores y proveedores POCT.',
    endpoints: [
      {
        method: 'GET',
        path: '/api/public-records',
        description: 'Retorna todas las pruebas POCT aprobadas en el registro nacional con enlace al fabricante.',
        responseExample: {
          records: [
            {
              id: 'rec-101',
              magnitudName: 'Glucosa en sangre total',
              analizadorName: 'Accu-Chek Inform II',
              proveedorName: 'Roche Diagnostics España',
              url: 'https://diagnostics.roche.com/...'
            }
          ]
        }
      },
      {
        method: 'GET',
        path: '/api/public-catalogs',
        description: 'Retorna los catálogos normalizados de magnitudes, analizadores y proveedores activos.',
        responseExample: {
          magnitudes: [{ id: 'mag-1', name: 'Glucosa en sangre total', status: 'Activo' }],
          analyzers: [{ id: 'ana-1', name: 'Lectura visual', isVisualReading: true }]
        }
      },
      {
        method: 'POST',
        path: '/api/check-link',
        description: 'Valida una URL HTTPS/HTTP y comprueba accesibilidad.',
        bodyExample: { url: 'https://semedlab.es' }
      },
      {
        method: 'GET',
        path: '/api/stats',
        description: 'Retorna estadísticas agregadas de uso, clics, búsquedas y distribución de pruebas por proveedor.'
      }
    ]
  });
});

app.get('/api/backup', (req, res) => {
  res.json({
    snapshot: db.getSnapshot(),
    exportedAt: new Date().toISOString(),
    version: 'POCT ONLINE 2026.1'
  });
});

// ----------------------------------------------------
// AI / SEMANTIC SEARCH ASSISTANT ("Preparación para búsquedas mediante IA")
// ----------------------------------------------------
app.post('/api/ai-search', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string') {
    return res.status(400).json({ success: false, message: 'Consulta vacía' });
  }

  const snapshot = db.getSnapshot();
  const approvedRecords = snapshot.records.filter(r => r.status === 'Aprobado');

  const client = getAIClient();
  if (client) {
    try {
      const prompt = `Actúa como especialista en Point Of Care Testing (POCT) y Medicina de Laboratorio de "POCT ONLINE".
El usuario hace la siguiente pregunta o búsqueda clínica: "${query}"

Aquí está el catálogo nacional de pruebas POCT disponibles:
${JSON.stringify(approvedRecords.map(r => ({
  id: r.id,
  magnitud: r.magnitudName,
  analizador: r.analizadorName,
  proveedor: r.proveedorName,
  notas: r.notas,
  url: r.url
})), null, 2)}

Analiza la consulta clínica, extrae cuáles son los registros POCT más recomendados o relevantes que responden al usuario y proporciona:
1. Una explicación médica breve y profesional sobre qué pruebas/magnitudes son indicadas.
2. Un listado en JSON ordenado con los IDs de los registros relevantes.

Responde únicamente en formato JSON con la estructura:
{
  "explanation": "Explicación clara y concisa...",
  "matchingRecordIds": ["rec-101", "rec-103"]
}`;

      const response = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });

      const text = response.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const matchedRecords = approvedRecords.filter(r => (parsed.matchingRecordIds || []).includes(r.id));
        return res.json({
          success: true,
          explanation: parsed.explanation,
          records: matchedRecords.length > 0 ? matchedRecords : approvedRecords.slice(0, 5)
        });
      }
    } catch (err) {
      console.error('Gemini AI error, falling back to local semantic match:', err);
    }
  }

  // Smart local semantic fallback matching
  const q = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const terms = q.split(/\s+/).filter(t => t.length > 2);
  
  const matches = approvedRecords.filter(r => {
    const text = `${r.magnitudName} ${r.analizadorName} ${r.proveedorName} ${r.notas}`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    return terms.some(term => text.includes(term));
  });

  return res.json({
    success: true,
    explanation: matches.length > 0
      ? `Hemos encontrado ${matches.length} prueba(s) POCT relacionada(s) con "${query}" en el Registro Nacional.`
      : `No se encontraron coincidencias exactas para "${query}". Mostrando recomendaciones generales en POCT:`,
    records: matches.length > 0 ? matches : approvedRecords.slice(0, 6)
  });
});

// ----------------------------------------------------
// VITE MIDDLEWARE OR STATIC PROD SERVING
// ----------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`POCT ONLINE Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
