const express = require('express');
const http = require('http');
const crypto = require('crypto');
const multer = require('multer');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const PORT = process.env.PORT || 10000;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_BUFFERED = 50 * 1024 * 1024;
const FILE_TTL_MS = 10 * 60 * 1000;
const files = new Map();
let bufferedBytes = 0;

app.set('trust proxy', 1);
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE, files: 1 }
});

function validRoom(room) {
  return typeof room === 'string' && /^[a-f0-9-]{20,40}$/i.test(room);
}
function cleanExpired() {
  const now = Date.now();
  for (const [id, item] of files) {
    if (item.expiresAt <= now) {
      bufferedBytes -= item.buffer.length;
      files.delete(id);
    }
  }
}
setInterval(cleanExpired, 60_000).unref();

io.on('connection', (socket) => {
  socket.on('join-room', (room, callback) => {
    if (!validRoom(room)) {
      if (typeof callback === 'function') callback({ ok: false, error: 'Неверный код сеанса.' });
      return;
    }
    socket.join(room);
    if (typeof callback === 'function') callback({ ok: true });
  });
});

app.get('/api/qr', async (req, res) => {
  const text = String(req.query.text || '');
  if (!text || text.length > 2000) return res.status(400).send('Invalid QR text');
  try {
    const png = await QRCode.toBuffer(text, { type: 'png', width: 320, margin: 2, errorCorrectionLevel: 'M' });
    res.type('png').set('Cache-Control', 'no-store').send(png);
  } catch { res.status(500).send('QR generation failed'); }
});

app.get('/api/files', (req, res) => {
  const room = String(req.query.room || '');
  if (!validRoom(room)) return res.status(400).json({ error: 'Неверный код сеанса.' });
  cleanExpired();
  const list = [...files.values()].filter(f => f.room === room).map(f => ({
    id: f.id, name: f.name, size: f.buffer.length, uploadedAt: f.uploadedAt,
    downloadUrl: `/api/download/${f.id}?room=${encodeURIComponent(room)}`
  }));
  res.set('Cache-Control', 'no-store').json({ files: list });
});

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 20 МБ.' : 'Не удалось принять файл.';
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }
    const room = String(req.query.room || '');
    if (!validRoom(room)) return res.status(400).json({ error: 'Неверный код сеанса.' });
    if (!req.file) return res.status(400).json({ error: 'Выбери файл.' });
    cleanExpired();
    if (bufferedBytes + req.file.buffer.length > MAX_BUFFERED) {
      return res.status(429).json({ error: 'Сервер временно занят файлами. Скачай предыдущие файлы и попробуй снова.' });
    }
    const id = crypto.randomUUID();
    const safeName = Buffer.from(req.file.originalname, 'utf8').toString('utf8').replace(/[\r\n\0]/g, '_').slice(0, 240) || 'file';
    const item = {
      id, room, name: safeName, mime: req.file.mimetype || 'application/octet-stream',
      buffer: req.file.buffer, uploadedAt: Date.now(), expiresAt: Date.now() + FILE_TTL_MS
    };
    files.set(id, item);
    bufferedBytes += item.buffer.length;
    const metadata = { id, name: item.name, size: item.buffer.length, uploadedAt: item.uploadedAt,
      downloadUrl: `/api/download/${id}?room=${encodeURIComponent(room)}` };
    io.to(room).emit('file-ready', metadata);
    res.json({ ok: true, file: metadata, message: 'Файл отправлен.' });
  });
});

app.get('/api/download/:id', (req, res) => {
  cleanExpired();
  const room = String(req.query.room || '');
  const item = files.get(req.params.id);
  if (!item || item.room !== room || !validRoom(room)) return res.status(404).send('Файл не найден или срок хранения истёк.');
  res.setHeader('Content-Type', item.mime);
  res.setHeader('Content-Length', item.buffer.length);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(item.buffer);
  // Remove after a successful response has been handed to the HTTP stack.
  res.on('finish', () => {
    const current = files.get(item.id);
    if (current) { bufferedBytes -= current.buffer.length; files.delete(item.id); }
    io.to(room).emit('file-removed', { id: item.id });
  });
});

app.get('/health', (_req, res) => res.json({ ok: true }));
server.listen(PORT, '0.0.0.0', () => console.log(`QR File Transfer listening on ${PORT}`));
