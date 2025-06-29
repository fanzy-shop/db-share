const express = require('express');
const { MongoClient } = require('mongodb');
const { EJSON } = require('bson');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: process.env.FRONTEND_URL || '*'
}));
app.use(express.json());

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

const correctPassword = process.env.AUTH_PASSWORD || 'secureMongo2025';
const tokens = new Set(); // In-memory token store (use Redis in production)

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token || !tokens.has(token)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
};

app.post('/api/authenticate', (req, res) => {
  const { password } = req.body;
  if (password === correctPassword) {
    const token = Math.random().toString(36).substring(2) + Date.now();
    tokens.add(token);
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'Invalid password' });
  }
});

app.post('/api/verify-token', (req, res) => {
  const { token } = req.body;
  if (tokens.has(token)) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
});

app.post('/api/export', authenticateToken, async (req, res) => {
  const { uri } = req.body;
  if (!uri) {
    return res.status(400).json({ success: false, message: 'MongoDB URI is required' });
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const adminDb = client.db().admin();
    const { databases } = await adminDb.listDatabases();

    const results = [];
    for (const dbInfo of databases) {
      const dbName = dbInfo.name;
      if (['admin', 'local', 'config'].includes(dbName)) continue;

      const db = client.db(dbName);
      const collections = await db.listCollections().toArray();

      for (const { name: collName } of collections) {
        const collection = db.collection(collName);
        const docs = await collection.find({}).toArray();
        const serialized = EJSON.stringify(docs, { relaxed: false }, 2);

        const outputDir = path.join(__dirname, 'mongo-exports', dbName);
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const fileName = `${collName}.json`;
        const filePath = path.join(outputDir, fileName);
        fs.writeFileSync(filePath, serialized);
        results.push(`${fileName} (${dbName}) ✅${docs.length === 0 ? ' (0 documents exported)' : ''}`);
      }
    }
    res.json({ success: true, message: results.join('\n') });
  } catch (err) {
    res.status(500).json({ success: false, message: `Error: ${err.message}` });
  } finally {
    await client.close();
  }
});

app.post('/api/import', authenticateToken, async (req, res) => {
  const { uri } = req.body;
  if (!uri) {
    return res.status(400).json({ success: false, message: 'MongoDB URI is required' });
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const baseDir = path.resolve('./mongo-exports');
    const files = [];

    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          files.push(fullPath);
        }
      }
    }

    walk(baseDir);

    const results = [];
    for (const filePath of files) {
      const relativePath = path.relative(baseDir, filePath);
      const [dbName, collectionFile] = relativePath.split(path.sep);
      const collectionName = collectionFile.replace('.json', '');
      const fileName = collectionFile;

      const jsonData = fs.readFileSync(filePath, 'utf8');
      let documents;
      try {
        documents = EJSON.parse(jsonData);
      } catch (err) {
        results.push(`${fileName} (${dbName}) ❌ JSON parse error: ${err.message}`);
        continue;
      }

      if (!Array.isArray(documents)) {
        results.push(`${fileName} (${dbName}) ❌ Data is not an array, skipping`);
        continue;
      }

      if (documents.length === 0) {
        results.push(`${fileName} (${dbName}) ✅ (0 documents imported)`);
        continue;
      }

      const db = client.db(dbName);
      const collection = db.collection(collectionName);
      const result = await collection.insertMany(documents);
      results.push(`${fileName} (${dbName}) ✅`);
    }
    res.json({ success: true, message: results.join('\n') });
  } catch (err) {
    res.status(500).json({ success: false, message: `Error: ${err.message}` });
  } finally {
    await client.close();
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));