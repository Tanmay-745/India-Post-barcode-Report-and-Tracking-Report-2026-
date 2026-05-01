const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

function cleanBarcode(value) {
  return String(value || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase().trim();
}

function cleanFilePart(value, fallback = 'Default') {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

async function extractReceiptRowData(link) {
  return link.evaluate(node => {
    const row = node.closest('.rdt_TableRow') || node.closest('tr') || node.closest('[role="row"]') || node.closest('.row') || (node.parentElement ? node.parentElement.parentElement : null);

    if (!row) {
      return { barcode: '', receiverName: '' };
    }

    let article = '';
    const articleCell = row.querySelector('[data-column-id="2"]');
    if (articleCell) {
      article = articleCell.innerText.trim();
    } else {
      const match = row.innerText.match(/[A-Z]{2}[0-9]{9}[A-Z]{2}/i);
      article = match ? match[0] : '';
    }

    let foundReceiver = '';
    const receiverCell = row.querySelector('[data-column-id="6"]');
    if (receiverCell) {
      foundReceiver = receiverCell.innerText.trim();
    } else {
      const cells = row.querySelectorAll('td, .rdt_TableCell, [role="gridcell"]');
      if (cells.length >= 6) {
        foundReceiver = cells[5].innerText.trim();
      } else {
        foundReceiver = row.innerText.split('\t').filter(t => t.trim().length > 3)[5] || '';
      }
    }

    return {
      barcode: article.toUpperCase(),
      receiverName: foundReceiver.replace(/[^a-z0-9 ]/gi, '_').trim()
    };
  });
}

async function downloadReceiptFromLink({ page, link, downloadDir, fallbackBarcode, label }) {
  const { barcode, receiverName } = await extractReceiptRowData(link);
  const finalBarcode = cleanBarcode(barcode) || cleanBarcode(fallbackBarcode) || cleanFilePart(label, 'item');
  const finalPrefix = cleanFilePart(receiverName, 'Default');
  const pdfFileName = `${finalPrefix}_${finalBarcode}_receipt.pdf`;

  let itemDownloaded = false;
  let itemRetries = 0;
  const maxRetries = 3;

  while (!itemDownloaded && itemRetries < maxRetries) {
    let pdfBuffer = null;
    const onResponse = async (response) => {
      try {
        const type = response.headers()['content-type'];
        if ((type && type.includes('application/pdf')) || response.url().toLowerCase().endsWith('.pdf')) {
          pdfBuffer = await response.body();
        }
      } catch(e) {}
    };
    page.context().on('response', onResponse);

    const popupPromise = page.context().waitForEvent('page', { timeout: 30000 }).catch(() => {
      if (itemRetries + 1 < maxRetries) {
        console.log(`${label} - Popup timeout. Will retry...`);
      } else {
        console.log(`${label} - Final timeout (30s) waiting for popup.`);
      }
      return null;
    });

    console.log(`${label} - Clicking Receipt button (Attempt ${itemRetries + 1}/${maxRetries})...`);
    await link.scrollIntoViewIfNeeded().catch(() => null);
    await link.click({ timeout: 10000, force: true }).catch(err => {
      console.log(`${label} - Click failed: ${err.message}`);
    });

    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('load', { timeout: 20000 }).catch(() => null);
      await popup.waitForTimeout(2000).catch(() => null);
      page.context().off('response', onResponse);

      const pdfPath = path.join(downloadDir, pdfFileName);
      let downloadSuccess = false;
      if (pdfBuffer) {
        fs.writeFileSync(pdfPath, pdfBuffer);
        console.log(`${label} - Successfully downloaded original PDF: ${pdfFileName}`);
        downloadSuccess = true;
      } else {
        console.log(`${label} - Missed network PDF, attempting CDP fallback...`);
        try {
          const client = await popup.context().newCDPSession(popup);
          const { data } = await client.send('Page.printToPDF', {
            printBackground: true,
            marginTop: 0.4,
            marginBottom: 0.4,
            marginLeft: 0.4,
            marginRight: 0.4
          });
          fs.writeFileSync(pdfPath, Buffer.from(data, 'base64'));
          console.log(`${label} - Successfully formatted receipt into PDF: ${pdfFileName}`);
          downloadSuccess = true;
        } catch (err) {
          console.log(`${label} - CDP Fallback failure: ${err.message}`);
        }
      }

      if (downloadSuccess) {
        itemDownloaded = true;
      }

      await popup.close().catch(() => null);
    } else {
      page.context().off('response', onResponse);
    }

    if (!itemDownloaded) {
      itemRetries++;
      if (itemRetries < maxRetries) {
        await page.waitForTimeout(3000);
      }
    }
  }

  if (!itemDownloaded) {
    throw new Error(`${label} - Failed after ${maxRetries} attempts`);
  }

  return { barcode: finalBarcode, receiverName: finalPrefix, fileName: pdfFileName };
}

async function searchReceiptByBarcode(page, barcode) {
  const normalizedBarcode = cleanBarcode(barcode);
  const searchInput = page.locator([
    'input[placeholder*="Search article number" i]',
    'input[aria-label*="Search article number" i]',
    'input[placeholder*="article number" i]',
    'input[type="search"]'
  ].join(', ')).first();

  await searchInput.waitFor({ state: 'visible', timeout: 30000 });
  await searchInput.scrollIntoViewIfNeeded().catch(() => null);
  await searchInput.click({ clickCount: 3 });
  await searchInput.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A').catch(() => null);
  await searchInput.fill(normalizedBarcode);
  await searchInput.evaluate((input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: value.slice(-1) || '0' }));
  }, normalizedBarcode);

  const typedValue = cleanBarcode(await searchInput.inputValue().catch(() => ''));
  if (typedValue !== normalizedBarcode) {
    throw new Error(`Could not write ${normalizedBarcode} into the Article Number search box. Current value: ${typedValue || 'EMPTY'}`);
  }

  console.log(`Searching Article Number: ${normalizedBarcode}`);

  const clickedSearch = await searchInput.evaluate((input) => {
    const root = input.closest('form, .input-group, .search, .d-flex, div') || document;
    const localButtons = Array.from(root.querySelectorAll('button, [role="button"], svg, i'));
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"], svg, i'));
    const inputRect = input.getBoundingClientRect();

    const pickClosestSearchControl = (elements) => {
      const candidates = elements.map(el => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
        return {
          el,
          rect,
          text,
          distanceX: rect.left - inputRect.right,
          distanceY: Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2)),
        };
      }).filter(item => (
        item.rect.width > 0
        && item.rect.height > 0
        && item.distanceX >= -10
        && item.distanceX < 100
        && item.distanceY < 32
      ));

      candidates.sort((a, b) => {
        const aSearchScore = a.text.includes('search') ? -100 : 0;
        const bSearchScore = b.text.includes('search') ? -100 : 0;
        return (aSearchScore + a.distanceX + a.distanceY) - (bSearchScore + b.distanceX + b.distanceY);
      });

      return candidates[0]?.el.closest('button, [role="button"]') || candidates[0]?.el || null;
    };

    const target = pickClosestSearchControl(localButtons) || pickClosestSearchControl(allButtons);
    if (!target) {
      return false;
    }

    target.click();
    return true;
  }).catch(() => false);

  if (!clickedSearch) {
    const clickedFallback = await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll('input')).find(el => {
      const placeholder = (el.getAttribute('placeholder') || '').toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      return placeholder.includes('search article number')
        || placeholder.includes('article number')
        || ariaLabel.includes('search article number');
    });

      if (!input) return false;

      const inputRect = input.getBoundingClientRect();
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], svg, i')).map(el => {
      const rect = el.getBoundingClientRect();
      return {
        el,
        rect,
        distanceX: rect.left - inputRect.right,
        distanceY: Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2)),
      };
    }).filter(item => (
      item.rect.width > 0
      && item.rect.height > 0
      && item.distanceX >= -8
      && item.distanceX < 80
      && item.distanceY < 28
    ));

      candidates.sort((a, b) => a.distanceX - b.distanceX);
      const target = candidates[0]?.el.closest('button, [role="button"]') || candidates[0]?.el;
      if (!target) return false;

      target.click();
      return true;
    }).catch(() => false);

    if (!clickedFallback) {
      await searchInput.press('Enter').catch(() => null);
    }
  }

  await page.waitForTimeout(1500);
  const row = page.locator('.rdt_TableRow, tr, [role="row"]').filter({ hasText: normalizedBarcode }).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });

  let receiptLink = row.locator('button, a, .btn').filter({ hasText: /Receipt|Other/i }).first();
  if (await receiptLink.count() === 0) {
    receiptLink = row.locator('button, a, .btn, [role="button"]').last();
  }

  if (await receiptLink.count() === 0) {
    throw new Error(`No Receipt button found for ${normalizedBarcode}`);
  }

  return receiptLink;
}

async function scrapeReceipts({ username, password, barcodeList = [] }) {
  console.log("DEBUG: RECEIVED BARCODE LIST FROM SERVER:", JSON.stringify(barcodeList));
  const hasTargetBarcodes = barcodeList && barcodeList.length > 0;
  if (hasTargetBarcodes) {
    console.log(`-------------------------------------------------------`);
    console.log(`FILTERING ACTIVE: Received ${barcodeList.length} barcodes from server.`);
    console.log(`First few articles: ${barcodeList.slice(0, 5).join(', ')}`);
    console.log(`-------------------------------------------------------`);
  } else {
    console.log("No barcode list provided. Downloading ALL receipts.");
  }
  // Open the India Post portal in the same clean guest-style browser profile for every run.
  const userDataDir = path.join(__dirname, 'chrome_guest_profile');
  const browserContext = await chromium.launchPersistentContext(userDataDir, { 
      headless: false,
      channel: 'chrome', 
      acceptDownloads: true,
      args: ['--guest', '--new-window']
  });
  
  const page = browserContext.pages()[0] || await browserContext.newPage();
  
  // CRITICAL: Block all native Print Previews from opening and freezing the robot!
  await browserContext.addInitScript(() => {
      window.print = function() { console.log('Print bypassed'); };
      try { Object.defineProperty(window, 'print', { value: () => {}, writable: false }); } catch(e){}
  });
  const timestamp = Date.now();
  const downloadDir = path.join(__dirname, `downloads_${timestamp}`);
  fs.mkdirSync(downloadDir, { recursive: true });

  try {
    await page.goto('https://app.indiapost.gov.in/customer-selfservice/login', { timeout: 90000 });
    
    console.log(`Attempting to auto-fill credentials for ${username}...`);
    try {
      // Use specific IDs for India Post login
      await page.waitForSelector('#customerid', { timeout: 15000 });
      
      // Clear before typing to avoid issues with browser remembers
      await page.focus('#customerid');
      await page.click('#customerid', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type('#customerid', username.toString(), { delay: 100 });
      
      await page.focus('#password');
      await page.click('#password', { clickCount: 3 });
      await page.keyboard.press('Backspace');
      await page.type('#password', password, { delay: 100 });
      
      console.log("Credentials entered. Waiting for user to solve CAPTCHA...");
    } catch(e) {
      console.log(`Auto-fill failed: ${e.message}. Please enter credentials manually.`);
    }

    console.log("Waiting for user to login and navigate to Home...");
    await page.waitForFunction(
      () => window.location.pathname.toLowerCase().includes('home') || window.location.pathname.toLowerCase().includes('dashboard') || document.body.innerText.includes('Welcome'),
      { timeout: 90000 }
    ).catch(e => console.log("Could not detect home transition automatically, assuming login is done."));

    console.log("Navigating to My Bookings...");
    try {
        // Try clicking the specific card link
        const myBookingsLink = page.locator('a[href*="my-bookings"]').first();
        if (await myBookingsLink.count() > 0) {
            await myBookingsLink.click({ timeout: 10000 });
        } else {
            // Fallback to text matching
            await page.click('text="My Bookings"', { timeout: 10000 });
        }
    } catch(e) {
        console.log("Click failed, attempting direct URL jump...");
        await page.goto('https://app.indiapost.gov.in/customer-selfservice/self-booking/my-bookings', { waitUntil: 'load' }).catch(() => null);
    }

    console.log("#######################################################");
    console.log("ACTION REQUIRED: Please set your Date & Booking filters.");
    console.log("Press Search/Generate. The robot will start when the table appears!");
    console.log("#######################################################");
    
    // Freeze the script until the user manually triggers the table generation
    // Give them up to 5 minutes to play with filters 
    await page.waitForFunction(
        () => Array.from(document.querySelectorAll('button, a, .btn')).some(el => el.innerText.trim() === 'Receipt'),
        { timeout: 300000 }
    ).catch(e => console.log("Timeout waiting for receipts table. Ensure you generated data."));
    
    await page.waitForTimeout(2000); 

    console.log("Table detected! Starting receipt download workflow...");

    let hasNextPage = true;
    let pageNumber = 1;
    let totalFoundItems = 0;
    let successfulDownloads = 0;
    let skippedByFilter = 0;
    let failureLogs = [];

    if (hasTargetBarcodes) {
      console.log("Barcode file uploaded. Searching each barcode in the Article Number search box...");

      for (let i = 0; i < barcodeList.length; i++) {
        const targetBarcode = cleanBarcode(barcodeList[i]);
        if (!targetBarcode) continue;

        totalFoundItems++;
        const label = `[Barcode ${i + 1}/${barcodeList.length}: ${targetBarcode}]`;

        try {
          const receiptLink = await searchReceiptByBarcode(page, targetBarcode);
          const result = await downloadReceiptFromLink({
            page,
            link: receiptLink,
            downloadDir,
            fallbackBarcode: targetBarcode,
            label
          });
          successfulDownloads++;
          console.log(`${label} Saved as ${result.fileName}`);
        } catch (error) {
          skippedByFilter++;
          failureLogs.push(`${label} ${error.message}`);
          console.log(`${label} Failed: ${error.message}`);
        }
      }
    } else {
      console.log("No barcode file uploaded. Downloading all visible receipts across pages...");

      while (hasNextPage) {
        console.log(`Processing Page ${pageNumber}...`);
        
        const receiptLinks = await page.locator('button, a, .btn').filter({ hasText: /Receipt|Other/i });
        const count = await receiptLinks.count();
        console.log(`Found ${count} download buttons on this page.`);

        for (let i = 0; i < count; i++) {
            const link = receiptLinks.nth(i);

            try {
              await downloadReceiptFromLink({
                page,
                link,
                downloadDir,
                fallbackBarcode: `item${i + 1}`,
                label: `[Page ${pageNumber}, Item ${i + 1}]`
              });
              successfulDownloads++;
            } catch (error) {
              failureLogs.push(`[Page ${pageNumber}, Item ${i + 1}] ${error.message}`);
            }
            totalFoundItems++;
        }
        
        // Find the specific pagination Next button (handles text, icons, and ARIA labels)
        const nextLinks = page.locator('button, a').filter({ 
            hasText: /Next/i 
        }).or(page.locator('button[aria-label*="Next" i], button[title*="Next" i], .MuiTablePagination-actions button:last-child'));
        
        let clickedNext = false;
        const nextCount = await nextLinks.count();
        
        if (nextCount > 0) {
            // Target the last matching button (usually the 'Next' one in pagination bars)
            const targetBtn = nextLinks.last();
            
            const isBtnDisabled = await targetBtn.isDisabled().catch(() => false);
            const isMuiDisabled = await targetBtn.evaluate(node => node.classList.contains('Mui-disabled')).catch(() => false);
            const isParentDisabled = await targetBtn.evaluate(node => {
                const li = node.closest('li');
                return li ? (li.classList.contains('disabled') || li.classList.contains('Mui-disabled')) : false;
            }).catch(() => false);
            
            if (!isBtnDisabled && !isMuiDisabled && !isParentDisabled) {
                console.log("Found Next button. Clicking to process the next page...");
                
                // Optional: Wait for the pagination text to change (e.g., "1-10 of 198" -> "11-20 of 198")
                const pagTextLocator = page.locator('.MuiTablePagination-displayedRows, .pagination-text, .rows-info').first();
                const oldText = await pagTextLocator.innerText().catch(() => '');
                
                await targetBtn.click({ force: true }).catch(() => null);
                
                // Wait for the table/data to refresh
                try {
                    await page.waitForFunction((prev) => {
                        const el = document.querySelector('.MuiTablePagination-displayedRows, .pagination-text, .rows-info');
                        return el && el.innerText.trim() !== prev;
                    }, oldText, { timeout: 8000 });
                    console.log("Data refresh detected.");
                } catch(e) {
                    await page.waitForTimeout(5000); // Fallback wait
                }
                
                pageNumber++;
                clickedNext = true;
            } else {
                console.log("Next button is disabled. Reached the final page.");
            }
        } else {
            console.log("No Next button found using standard selectors.");
        }
        
        if (!clickedNext) {
            hasNextPage = false; // Gracefully terminate the mega-loop
        }
      }
    }

    // Create the final report
    const reportPath = path.join(downloadDir, 'execution_report.txt');
    const reportSummary = [
        `INDIA POST AUTOMATION REPORT`,
        `===========================`,
        `Timestamp: ${new Date().toLocaleString()}`,
        `Barcode Filter Active: ${hasTargetBarcodes ? 'YES (' + barcodeList.length + ' targets)' : 'NO'}`,
        `${hasTargetBarcodes ? 'Total Barcodes Searched' : 'Total Items Scanned'}: ${totalFoundItems}`,
        `Successfully Matched & Downloaded: ${successfulDownloads}`,
        `${hasTargetBarcodes ? 'Not Found / Failed Searches' : 'Skipped (Not in your list)'}: ${skippedByFilter}`,
        `Failed Downloads: ${failureLogs.length}`,
        ``,
        `FAILURE DETAILS (If Any)`,
        `-----------------------`,
        failureLogs.length > 0 ? failureLogs.join('\n') : 'All matched PDFs generated successfully!'
    ].join('\n');
    
    fs.writeFileSync(reportPath, reportSummary);
    console.log(`Report generated at: ${reportPath}`);

    console.log("Zipping the generated PDFs...");
    const zip = new AdmZip();
    zip.addLocalFolder(downloadDir);
    const zipPath = path.join(__dirname, `bulk_receipts_${timestamp}.zip`);
    zip.writeZip(zipPath);

    return { zipPath, cleanupDirs: [downloadDir] };
  } catch (error) {
    console.error("Scraping error encountered: ", error);
    throw error;
  } finally {
    // Keep browser window alive briefly if needed
    await browserContext.close().catch(() => {});
  }
}

module.exports = { scrapeReceipts };
