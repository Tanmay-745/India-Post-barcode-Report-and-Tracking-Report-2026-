const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

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
  // Use a persistent guest/profile folder so you stay logged in or save cache!
  const userDataDir = path.join(__dirname, 'chrome_profile');
  const browserContext = await chromium.launchPersistentContext(userDataDir, { 
      headless: false,
      channel: 'chrome', 
      acceptDownloads: true 
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

    console.log("Table detected! Scanning for barcodes to bulk download...");

    let hasNextPage = true;
    let pageNumber = 1;
    let totalFoundItems = 0;
    let successfulDownloads = 0;
    let skippedByFilter = 0;
    let failureLogs = [];

    while (hasNextPage) {
        console.log(`Processing Page ${pageNumber}...`);
        
        const receiptLinks = await page.locator('button, a, .btn').filter({ hasText: /Receipt|Other/i });
        const count = await receiptLinks.count();
        console.log(`Found ${count} download buttons on this page.`);

        for (let i = 0; i < count; i++) {
            const link = receiptLinks.nth(i);
            
            // Extract barcode, and dynamic reciever name from the row
            const { barcode, receiverName } = await link.evaluate(node => {
                const row = node.closest('.rdt_TableRow') || node.closest('tr') || node.closest('[role="row"]') || node.closest('.row') || (node.parentElement ? node.parentElement.parentElement : null);
                
                if (!row) {
                    return { barcode: '', receiverName: '' };
                }

                // Extract Article Number (Barcode) - Data Table column index 2
                let article = '';
                const articleCell = row.querySelector('[data-column-id="2"]');
                if (articleCell) {
                    article = articleCell.innerText.trim();
                } else {
                    const match = row.innerText.match(/[A-Z]{2}[0-9]{9}[A-Z]{2}/i);
                    article = match ? match[0] : '';
                }
                
                // Extract Receiver Name - Data Table column index 6
                let foundReceiver = '';
                const receiverCell = row.querySelector('[data-column-id="6"]');
                if (receiverCell) {
                    foundReceiver = receiverCell.innerText.trim();
                } else {
                    const cells = row.querySelectorAll('td, .rdt_TableCell');
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

            const currentBarcode = (barcode || "").toUpperCase().trim();
            if (hasTargetBarcodes) {
                // IMPORTANT: Ensure currentBarcode is not empty before attempting a match
                const isMatched = currentBarcode && barcodeList.some(target => {
                    const t = String(target).toUpperCase().trim();
                    return t && (currentBarcode.includes(t) || t.includes(currentBarcode));
                });

                if (!isMatched) {
                    console.log(`[FILTER] Item #${i + 1} - Barcode (${currentBarcode || 'NOT FOUND'}) does not match your list. Skipping.`);
                    skippedByFilter++;
                    continue;
                } else {
                    console.log(`[FILTER] Item #${i + 1} (${currentBarcode}) - MATCH FOUND!`);
                }
            }

            const finalBarcode = currentBarcode || `item${i+1}`;
            const finalPrefix = (receiverName || 'Default').trim().replace(/[^a-z0-9]/gi, '_');
            
            // Name the PDF based on the found barcode
            const pdfFileName = `${finalPrefix}_${finalBarcode}_receipt.pdf`;
            
            let itemDownloaded = false;
            let itemRetries = 0;
            const maxRetries = 3;

            while (!itemDownloaded && itemRetries < maxRetries) {
                // Setup a listener to intercept the original PDF file from the network
                let pdfBuffer = null;
                const onResponse = async (response) => {
                    try {
                        const type = response.headers()['content-type'];
                        if ((type && type.includes('application/pdf')) || response.url().toLowerCase().endsWith('.pdf')) {
                            const buffer = await response.body();
                            pdfBuffer = buffer;
                        }
                    } catch(e) {}
                };
                page.context().on('response', onResponse);

                // Listen for the new tab opening
                const popupPromise = page.context().waitForEvent('page', { timeout: 30000 }).catch(() => {
                    if (itemRetries + 1 < maxRetries) {
                        console.log(`Item #${i + 1} - Popup timeout. Will retry...`);
                    } else {
                        console.log(`Item #${i + 1} - Final timeout (30s) waiting for popup.`);
                    }
                    return null;
                });

                console.log(`Item #${i + 1} - Clicking button (Attempt ${itemRetries + 1}/${maxRetries})...`);
                await link.scrollIntoViewIfNeeded().catch(() => null);
                await link.click({ timeout: 10000, force: true }).catch(err => {
                    console.log(`Item #${i + 1} - Click failed: ${err.message}`);
                });
                
                const popup = await popupPromise;
                if (popup) {
                    // Wait for the popup to physically finish loading the PDF
                    await popup.waitForLoadState('load', { timeout: 20000 }).catch(() => null);
                    try {
                        await popup.waitForTimeout(2000); 
                    } catch(e) {
                        // Popup might have closed after download started
                    }                    
                    // Cleanup listener
                    page.context().off('response', onResponse);
                    
                    const pdfPath = path.join(downloadDir, pdfFileName);
                    
                    let downloadSuccess = false;
                    if (pdfBuffer) {
                        fs.writeFileSync(pdfPath, pdfBuffer);
                        console.log(`Item #${i + 1} - Successfully downloaded original PDF: ${pdfFileName}`);
                        downloadSuccess = true;
                    } else {
                        console.log(`Item #${i + 1} - Missed network PDF, attempting CDP fallback...`);
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
                            console.log(`Item #${i + 1} - Successfully formatted receipt into PDF.`);
                            downloadSuccess = true;
                        } catch (err) {
                            console.log(`Item #${i + 1} - CDP Fallback failure: ${err.message}`);
                        }
                    }

                    if (downloadSuccess) {
                        successfulDownloads++;
                        itemDownloaded = true;
                    }
                    
                    await popup.close().catch(() => null);
                } else {
                    page.context().off('response', onResponse);
                }

                if (!itemDownloaded) {
                    itemRetries++;
                    if (itemRetries < maxRetries) {
                        await page.waitForTimeout(3000); // 3 second delay between retries
                    } else {
                        failureLogs.push(`[Page ${pageNumber}, Item ${i+1}] Barcode: ${finalBarcode} - Failed after ${maxRetries} attempts`);
                    }
                }
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

    // Create the final report
    const reportPath = path.join(downloadDir, 'execution_report.txt');
    const reportSummary = [
        `INDIA POST AUTOMATION REPORT`,
        `===========================`,
        `Timestamp: ${new Date().toLocaleString()}`,
        `Barcode Filter Active: ${hasTargetBarcodes ? 'YES (' + barcodeList.length + ' targets)' : 'NO'}`,
        `Total Items Scanned: ${totalFoundItems}`,
        `Successfully Matched & Downloaded: ${successfulDownloads}`,
        `Skipped (Not in your list): ${skippedByFilter}`,
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

    return zipPath;
  } catch (error) {
    console.error("Scraping error encountered: ", error);
    throw error;
  } finally {
    // Keep browser window alive briefly if needed
    await browserContext.close().catch(() => {});
  }
}

module.exports = { scrapeReceipts };
