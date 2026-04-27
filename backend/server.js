const express = require('express');
const cors = require('cors');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { scrapeReceipts } = require('./scraper');
const { scrapeArticles } = require('./scraper_article');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Helper to parse barcodes from file
async function parseBarcodes(filePath, originalName) {
  const barcodes = new Set();
  const fileExt = path.extname(originalName || filePath).toLowerCase();
  console.log(`Parsing barcodes from ${fileExt} file: ${originalName}`);

  try {
    if (fileExt === '.csv') {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
      
      // Look for 'Barcode' header in first 10 lines
      const headerFound = lines.slice(0, 10).some(line => line.toLowerCase().includes('barcode'));
      if (!headerFound) {
        throw new Error("Invalid CSV: Could not find 'Barcode' header in the first few lines.");
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
      
      // Look for 'Barcode' header anywhere in the first 20 rows
      let headerRowIndex = -1;
      for (let i = 0; i < Math.min(data.length, 20); i++) {
        if (data[i] && Array.isArray(data[i]) && data[i].some(cell => String(cell || '').toLowerCase().includes('barcode'))) {
          headerRowIndex = i;
          break;
        }
      }
      
      if (headerRowIndex === -1) {
        throw new Error("Invalid Excel: Could not find 'Barcode' header in the first 20 rows.");
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

app.post('/api/scrape', upload.single('barcodeFile'), async (req, res) => {
  const { username, password, date, bookingType } = req.body;
  let barcodeList = [];

  try {
    if (req.file) {
      console.log(`Uploaded file: ${req.file.originalname}`);
      barcodeList = await parseBarcodes(req.file.path, req.file.originalname);
      fs.unlinkSync(req.file.path); // Cleanup
    }
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    
    const zipPath = await scrapeReceipts({ username, password, date, bookingType, barcodeList });
    res.download(zipPath, 'receipts.zip', (err) => {
      if (err) console.error("Error downloading file:", err);
      // The frontend handles the file stream
    });
  } catch (error) {
    console.error("Scraping error:", error);
    res.status(500).json({ error: error.message || "Failed to scrape receipts" });
  }
});

app.post('/api/scrape-articles', upload.single('barcodeFile'), async (req, res) => {
  const { username, password } = req.body;
  let barcodeList = [];

  try {
    if (req.file) {
      barcodeList = await parseBarcodes(req.file.path, req.file.originalname);
      fs.unlinkSync(req.file.path); // Cleanup
    }

    if (!username || !password) {
      return res.status(400).json({ error: 'Missing required fields.' });
    }
    
    const zipPath = await scrapeArticles({ username, password, barcodeList });
    res.download(zipPath, 'articles.zip', (err) => {
      if (err) console.error("Error downloading file:", err);
    });
  } catch (error) {
    console.error("Scraping articles error:", error);
    res.status(500).json({ error: error.message || "Failed to scrape articles" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}...`);
});
