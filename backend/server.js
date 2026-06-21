// ============================================================
//  NoteNest Backend  ·  Node.js + Express + MongoDB + Multer
//  File: server.js
// ============================================================

const express    = require('express');
const mongoose   = require('mongoose');
const multer     = require('multer');
const path       = require('path');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const fs         = require('fs');
require('dotenv').config();

const app = express();

// ── MIDDLEWARE ──────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_URL || '*' }));
app.use(express.json());
app.use('/uploads', express.static('uploads')); // serve files

// ── MONGODB CONNECTION ──────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/notenest')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ── SCHEMAS ────────────────────────────────────────────────

// User Schema
const userSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true },
  branch:    { type: String },
  createdAt: { type: Date, default: Date.now }
});

// Note Schema
const noteSchema = new mongoose.Schema({
  title:     { type: String, required: true },
  subject:   { type: String, required: true },
  branch:    { type: String, required: true },
  semester:  { type: String },
  tags:      [String],
  files: [{
    originalName: String,
    filename:     String,  // saved filename on disk
    mimetype:     String,
    size:         Number,
    fileType:     String,  // PDF | Image | PPTX | DOCX | Other
    path:         String,
  }],
  uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  downloads:  { type: Number, default: 0 },
  likes:      { type: Number, default: 0 },
  createdAt:  { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Note = mongoose.model('Note', noteSchema);

// ── MULTER STORAGE (disk) ───────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads/';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = [
    'application/pdf',
    'image/png','image/jpeg','image/jpg','image/gif','image/webp',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'video/mp4','video/webm',
    'application/zip'
  ];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('File type not allowed'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 50 * 1024 * 1024 } // 50 MB
});

// Helper to derive fileType label
function getFileType(mimetype) {
  if (mimetype === 'application/pdf') return 'PDF';
  if (mimetype.startsWith('image/')) return 'Image';
  if (mimetype.includes('presentation')) return 'PPTX';
  if (mimetype.includes('wordprocessing')) return 'DOCX';
  if (mimetype.includes('spreadsheet')) return 'XLSX';
  if (mimetype.startsWith('video/')) return 'Video';
  return 'Other';
}

// ── AUTH MIDDLEWARE ─────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || 'notenest_secret_key');
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── AUTH ROUTES ─────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, branch } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing fields' });

    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed, branch });
    const token = jwt.sign({ id: user._id, name: user.name, email: user.email }, process.env.JWT_SECRET || 'notenest_secret_key', { expiresIn: '7d' });

    res.status(201).json({ token, user: { id: user._id, name, email, branch } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Wrong password' });

    const token = jwt.sign({ id: user._id, name: user.name, email: user.email }, process.env.JWT_SECRET || 'notenest_secret_key', { expiresIn: '7d' });
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, branch: user.branch } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── NOTE ROUTES ─────────────────────────────────────────────

// GET /api/notes — list with filters
app.get('/api/notes', async (req, res) => {
  try {
    const { branch, sem, type, search, page = 1, limit = 20 } = req.query;
    const query = {};
    if (branch) query.branch = branch;
    if (sem)    query.semester = sem;
    if (type)   query['files.fileType'] = type;
    if (search) query.$or = [
      { title:   new RegExp(search, 'i') },
      { subject: new RegExp(search, 'i') },
      { tags:    new RegExp(search, 'i') },
    ];
    const notes = await Note.find(query)
      .populate('uploadedBy', 'name branch')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await Note.countDocuments(query);
    res.json({ notes, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notes/upload — upload note with files (auth required)
app.post('/api/notes/upload', authMiddleware, upload.array('files', 10), async (req, res) => {
  try {
    const { title, subject, branch, semester, tags } = req.body;
    if (!title || !branch) return res.status(400).json({ error: 'Title and branch are required' });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'At least one file required' });

    const filesData = req.files.map(f => ({
      originalName: f.originalname,
      filename:     f.filename,
      mimetype:     f.mimetype,
      size:         f.size,
      fileType:     getFileType(f.mimetype),
      path:         f.path
    }));

    const note = await Note.create({
      title, subject, branch, semester,
      tags: tags ? tags.split(',').map(t => t.trim()) : [],
      files: filesData,
      uploadedBy: req.user.id
    });

    await note.populate('uploadedBy', 'name branch');
    res.status(201).json({ message: 'Uploaded successfully', note });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notes/:id — single note detail
app.get('/api/notes/:id', async (req, res) => {
  try {
    const note = await Note.findById(req.params.id).populate('uploadedBy', 'name branch');
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json(note);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notes/:id/download/:fileIndex — download a specific file
app.get('/api/notes/:id/download/:fileIndex', async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });

    const fileIdx = parseInt(req.params.fileIndex) || 0;
    const file = note.files[fileIdx];
    if (!file) return res.status(404).json({ error: 'File not found in this note' });

    const filePath = path.resolve(file.path);

    // Check file actually exists on disk before trying to send
    if (!fs.existsSync(filePath)) {
      console.error('Missing file on disk:', filePath);
      return res.status(404).json({ error: 'File is missing from server storage' });
    }

    // Increment download counter (fire and forget)
    Note.findByIdAndUpdate(req.params.id, { $inc: { downloads: 1 } }).catch(() => {});

    // Set headers so browser downloads with original filename
    const safeName = file.originalName.replace(/[^\w.\-\s]/g, '_');
    res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + safeName + '"');
    res.setHeader('Content-Length', file.size);
    res.setHeader('Cache-Control', 'no-cache');

    // Stream the file
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      console.error('File stream error:', err);
      if (!res.headersSent) res.status(500).json({ error: 'Failed to stream file' });
    });
    stream.pipe(res);

  } catch (err) {
    console.error('Download route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notes/:id/like — like a note
app.post('/api/notes/:id/like', async (req, res) => {
  try {
    const note = await Note.findByIdAndUpdate(req.params.id, { $inc: { likes: 1 } }, { new: true });
    if (!note) return res.status(404).json({ error: 'Note not found' });
    res.json({ likes: note.likes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notes/:id — delete note (auth + owner check)
app.delete('/api/notes/:id', authMiddleware, async (req, res) => {
  try {
    const note = await Note.findById(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    if (note.uploadedBy.toString() !== req.user.id) return res.status(403).json({ error: 'Not authorized' });

    // Delete files from disk
    note.files.forEach(f => {
      if (fs.existsSync(f.path)) fs.unlinkSync(f.path);
    });
    await note.deleteOne();
    res.json({ message: 'Note deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — dashboard stats
app.get('/api/stats', async (req, res) => {
  try {
    const totalNotes = await Note.countDocuments();
    const totalUsers = await User.countDocuments();
    const totalDownloads = await Note.aggregate([{ $group: { _id: null, total: { $sum: '$downloads' } } }]);
    res.json({
      notes: totalNotes, users: totalUsers,
      downloads: totalDownloads[0]?.total || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SERVE FRONTEND (must be AFTER all API routes) ──────────
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return res.status(404).json({ error: 'Route not found' });
  }
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── ERROR HANDLING ──────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'File too large. Max 50MB.' });
  if (err.message === 'File type not allowed') return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── START ───────────────────────────────────────────────────
const PORT = process.env.PORT || 5500;
app.listen(PORT, () => {
  console.log('');
  console.log('  🚀 NoteNest is running!');
  console.log('  👉 Open: http://localhost:' + PORT);
  console.log('  📁 Files saved to: ./uploads/');
  console.log('  🗄️  DB: ' + (process.env.MONGO_URI || 'mongodb://localhost:27017/notenest'));
  console.log('');
});
