const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { scrapeReceipts } = require('./scraper');
const { scrapeArticles } = require('./scraper_article');

const app = express();
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

function cleanupUploadedFile(file) {
  if (file?.path && fs.existsSync(file.path)) {
    fs.unlinkSync(file.path);
  }
}

function cleanupGeneratedArchive(result, options = {}) {
  const zipPath = typeof result === 'string' ? result : result?.zipPath;
  const cleanupDirs = Array.isArray(result?.cleanupDirs) ? result.cleanupDirs : [];
  const keepZip = Boolean(options.keepZip);

  for (const dir of cleanupDirs) {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Deleted temporary download folder: ${dir}`);
    }
  }

  if (zipPath && keepZip && fs.existsSync(zipPath)) {
    console.log(`Kept generated ZIP for manual retry: ${zipPath}`);
  } else if (zipPath && fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
    console.log(`Deleted temporary ZIP file: ${zipPath}`);
  }
}

function sendArchiveDownload(res, scrapeResult, downloadName) {
  const zipPath = typeof scrapeResult === 'string' ? scrapeResult : scrapeResult?.zipPath;

  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error('Generated ZIP file was not found.');
  }

  res.download(zipPath, downloadName, (err) => {
    const downloadFailed = Boolean(err);

    if (err?.code === 'ECONNABORTED') {
      console.warn(`Download was cancelled by the browser/client. Generated ZIP will be kept at: ${zipPath}`);
    } else if (err) {
      console.error('Error downloading file:', err);
    } else {
      console.log(`Download completed successfully: ${downloadName}`);
    }

    cleanupGeneratedArchive(scrapeResult, { keepZip: downloadFailed });
  });
}

function looksLikeBarcodeHeader(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('barcode')
    || normalized.includes('article number')
    || normalized.includes('article no')
    || normalized.includes('article')
    || normalized.includes('consignment');
}

// Helper to parse barcodes from file
async function parseBarcodes(filePath, originalName) {
  const barcodes = new Set();
  const fileExt = path.extname(originalName || filePath).toLowerCase();
  console.log(`Parsing barcodes from ${fileExt} file: ${originalName}`);

  try {
    if (fileExt === '.csv') {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
      
      // Look for a barcode/article/consignment header in first 10 lines
      const headerFound = lines.slice(0, 10).some(looksLikeBarcodeHeader);
      if (!headerFound) {
        throw new Error("Invalid CSV: Could not find a Barcode, Article Number, or Consignment header in the first few lines.");
      }

      lines.forEach(line => {
        // Strip everything except letters and numbers for matching
        const cleanLine = line.replace(/[^a-zA-Z0-9]/g, '');
        const matches = cleanLine.match(/[a-z]{2}\d{9}[a-z]{2}/gi);
        if (matches) {
          matches.forEach(m => barcodes.add(m.toUpperCase().trim()));
        } else {
            // Also try matching within the raw line in case of weird spacing
            const rawMatches = line.match(/[a-z]{2}\s?\d{9}\s?[a-z]{2}/gi);
            if (rawMatches) rawMatches.forEach(m => barcodes.add(m.replace(/\s/g, '').toUpperCase().trim()));
        }
      });
    } else if (fileExt === '.xlsx' || fileExt === '.xls') {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
      
      // Look for a barcode/article/consignment header anywhere in the first 20 rows
      let headerRowIndex = -1;
      for (let i = 0; i < Math.min(data.length, 20); i++) {
        if (data[i] && Array.isArray(data[i]) && data[i].some(looksLikeBarcodeHeader)) {
          headerRowIndex = i;
          break;
        }
      }
      
      if (headerRowIndex === -1) {
        throw new Error("Invalid Excel: Could not find a Barcode, Article Number, or Consignment header in the first 20 rows.");
      }

      console.log(`Excel validated (Header found at row ${headerRowIndex + 1}).`);
      data.forEach((row) => {
        if (!Array.isArray(row)) return;
        row.forEach(cell => {
           if (cell) {
             const cellStr = String(cell).replace(/[^a-zA-Z0-9]/g, '');
             const matches = cellStr.match(/[a-z]{2}\d{9}[a-z]{2}/gi);
             if (matches) matches.forEach(m => barcodes.add(m.toUpperCase().trim()));
           }
        });
      });
    }
  } catch (err) {
    console.error("Parsing error:", err.message);
    throw err;
  }

  const result = Array.from(barcodes);
  if (result.length === 0) {
    throw new Error("The file is valid, but no barcodes (like JF123456789IN) were detected. Check article number format!");
  }

  console.log(`Found ${result.length} unique barcodes.`);
  return result;
}
app.use(cors());
app.use(express.json());

// Health check routes
app.get('/', (req, res) => {
  res.send('<h1>India Post Automation Backend is Running</h1><p>Send POST requests to <code>/api/scrape</code> or <code>/api/scrape-articles</code></p>');
});

app.get('/api/status', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

app.post('/api/scrape', upload.single('barcodeFile'), async (req, res) => {
  console.log(`[${new Date().toLocaleTimeString()}] POST /api/scrape received`);
  const { username, password, date, bookingType } = req.body;
  let barcodeList = [];

  try {
    if (req.file) {
      console.log(`Uploaded file: ${req.file.originalname}`);
      barcodeList = await parseBarcodes(req.file.path, req.file.originalname);
    }
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    
    const scrapeResult = await scrapeReceipts({ username, password, date, bookingType, barcodeList });
    sendArchiveDownload(res, scrapeResult, 'receipts.zip');
  } catch (error) {
    console.error("Scraping error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || "Failed to scrape receipts" });
    }
  } finally {
    cleanupUploadedFile(req.file);
  }
});

app.post('/api/scrape-articles', upload.single('barcodeFile'), async (req, res) => {
  console.log(`[${new Date().toLocaleTimeString()}] POST /api/scrape-articles received`);
  const { username, password } = req.body;
  let barcodeList = [];

  try {
    if (req.file) {
      barcodeList = await parseBarcodes(req.file.path, req.file.originalname);
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    
    const scrapeResult = await scrapeArticles({ username, password, barcodeList });
    sendArchiveDownload(res, scrapeResult, 'articles.zip');
  } catch (error) {
    console.error("Scraping articles error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message || "Failed to scrape articles" });
    }
  } finally {
    cleanupUploadedFile(req.file);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}...`);
});
