const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');

async function scrapeArticles({ username, password, barcodeList = [] }) {
  const hasTargetBarcodes = barcodeList && barcodeList.length > 0;
  if (hasTargetBarcodes) {
    console.log(`-------------------------------------------------------`);
    console.log(`FILTERING ACTIVE: Received ${barcodeList.length} barcodes from server.`);
    console.log(`First few articles: ${barcodeList.slice(0, 5).join(', ')}`);
    console.log(`-------------------------------------------------------`);
  } else {
    console.log("No barcode list provided. Tracking ALL items.");
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
  

  const timestamp = Date.now();
  const jobDir = path.join(os.tmpdir(), 'india-post-automation', `articles_${timestamp}`);
  const downloadDir = path.join(jobDir, 'files');
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
      { timeout: 120000 }
    ).catch(() => console.log("Login detected or timeout."));

    console.log("Navigating to Article Tracking...");
    try {
        await page.goto('https://app.indiapost.gov.in/customer-selfservice/bulk-articles-tracking', { waitUntil: 'load', timeout: 30000 });
    } catch(e) {
        console.log("Direct navigation failed, attempting sidebar click...");
        try {
            await page.click('button.text-white'); // Sidebar toggle
            await page.click('text=TOOLS');
            await page.click('text=Track Consignment');
        } catch(err) {
            console.log("Navigation failed, please go to 'Bulk Track' manually.");
        }
    }

    console.log("Selecting 'Bulk Track via Excel File' tab...");
    await page.locator('button[role="tab"]').filter({ hasText: /Bulk Track/i }).first().click().catch(() => null);


    console.log("#######################################################");
    console.log("ACTION REQUIRED: Please upload your Excel file and solve the captcha.");
    console.log("Click 'Track Articles'. The robot will start when it sees the results table!");
    console.log("#######################################################");
    
    // Wait for the results table or "Print" buttons to appear.
    await page.waitForFunction(
        () => {
            const buttons = Array.from(document.querySelectorAll('button, a, .btn, [role="button"]'));
            return buttons.some(el => {
                const text = el.innerText.trim().toLowerCase();
                const title = (el.getAttribute('title') || '').toLowerCase();
                return text.includes('print') || title.includes('print');
            });
        },
        { timeout: 300000 }
    ).catch(e => console.log("Timeout waiting for results. Ensure you clicked 'Track Articles' and the table appeared."));
    
    await page.waitForTimeout(5000); // 5 seconds extra to ensure all 10 rows are populated

    console.log("Results detected! Scanning for article 'Print' buttons to bulk download...");

    let hasNextPage = true;
    let pageNumber = 1;
    let totalItemsTracked = 0;
    let successfulArticleDownloads = 0;
    let failureLogs = [];
    const processedArticles = new Set(); // Memory to prevent repeating the same articles

    while (hasNextPage) {
        console.log(`Processing Page ${pageNumber}...`);
        
        const printButtons = await page.locator('button, a, .btn, [role="button"]').filter({ 
            hasText: /Print/i 
        }).or(page.locator('[title*="Print" i]'));
        
        const count = await printButtons.count();
        console.log(`Found ${count} article results on this page.`);

        for (let i = 0; i < count; i++) {
            const btn = printButtons.nth(i);
            
            // Extract Article Number (Barcode) and Recipient Name from the row
            const { articleNumber, recipientName } = await btn.evaluate(node => {
                const row = node.closest('tr') || node.closest('div[role="row"]');
                if (!row) return { articleNumber: `article_${Date.now()}`, recipientName: '' };
                const match = row.innerText.match(/[A-Z]{2}\d{9}[A-Z]{2}/);
                
                // Try to find a recipient/name column
                let foundName = '';
                try {
                    const cells = row.querySelectorAll('td, [role="gridcell"]');
                    if (cells.length > 2) {
                        for (let j = 0; j < cells.length; j++) {
                            const text = cells[j].innerText.trim();
                            if (text.length > 3 && !text.match(/[A-Z]{2}\d{9}[A-Z]{2}/) && !text.match(/^\d+$/)) {
                                foundName = text;
                                break;
                            }
                        }
                    }
                } catch(e) {}

                return {
                    articleNumber: match ? match[0] : `article_${Date.now()}`,
                    recipientName: foundName.replace(/[^a-z0-9]/gi, '_').trim()
                };
            });

            const currentArticle = (articleNumber || "").toUpperCase().trim();
            const finalPrefix = (recipientName || 'Default').trim().replace(/[^a-z0-9]/gi, '_');

            // If we have a target list, skip items that are not in the list
            if (hasTargetBarcodes) {
                const isMatched = currentArticle && barcodeList.some(target => {
                    const t = String(target).toUpperCase().trim();
                    return t && (currentArticle.includes(t) || t.includes(currentArticle));
                });

                if (!isMatched) {
                    console.log(`[FILTER] Article (${currentArticle || 'NOT FOUND'}) - NO MATCH in list. Skipping.`);
                    continue;
                } else {
                    console.log(`[FILTER] Article (${currentArticle}) - MATCH FOUND!`);
                }
            }

            // [NEW] DUPLICATE PREVENTION: Check if we already handled this article in this session
            if (processedArticles.has(currentArticle)) {
                console.log(`[SKIP] Article ${currentArticle} was already processed on a previous page/scan.`);
                continue;
            }

            console.log(`Processing article: ${currentArticle} (Prefix: ${finalPrefix})`);

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

                // Listen for the new tab opening for the Print action
                const popupPromise = page.context().waitForEvent('page', { timeout: 30000 }).catch(() => {
                    if (itemRetries + 1 < maxRetries) {
                        console.log(`Article ${articleNumber} - Popup timeout. Will retry...`);
                    } else {
                        console.log(`Article ${articleNumber} - Final timeout (30s) waiting for print popup.`);
                    }
                    return null;
                });

                console.log(`Article ${articleNumber} - Clicking print button (Attempt ${itemRetries + 1}/${maxRetries})...`);
                await btn.scrollIntoViewIfNeeded().catch(() => null);
                await btn.click({ timeout: 10000, force: true }).catch(err => {
                    console.log(`Article ${articleNumber} - Click failed: ${err.message}`);
                });
                
                const popup = await popupPromise;
                if (popup) {
                    await popup.waitForLoadState('load', { timeout: 20000 }).catch(() => null);
                    await popup.waitForTimeout(2000); 
                    
                    // Cleanup listener
                    page.context().off('response', onResponse);
                    
                    const pdfFileName = `${finalPrefix}_${articleNumber}.pdf`;
                    const pdfPath = path.join(downloadDir, pdfFileName);
                    
                    let downloadSuccess = false;
                    if (pdfBuffer) {
                        fs.writeFileSync(pdfPath, pdfBuffer);
                        console.log(`Article ${articleNumber} - Successfully downloaded original PDF.`);
                        downloadSuccess = true;
                    } else {
                        console.log(`Article ${articleNumber} - Missed network PDF, attempting CDP fallback...`);
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
                            console.log(`Article ${articleNumber} - Successfully formatted into PDF.`);
                            downloadSuccess = true;
                        } catch (err) {
                            console.log(`Article ${articleNumber} - CDP Fallback failure: ${err.message}`);
                        }
                    }

                    if (downloadSuccess) {
                        successfulArticleDownloads++;
                        itemDownloaded = true;
                        processedArticles.add(currentArticle); // Add to memory after success
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
                        failureLogs.push(`[Page ${pageNumber}, Item ${i+1}] Article: ${articleNumber} - Failed after ${maxRetries} attempts`);
                    }
                }
            }
            totalItemsTracked++;
        }

        // Handle Pagination: Aggressive search for the ">" (Next) button
        console.log("--- PAGINATION DIAGNOSTIC ---");
        
        // 1. Identify current first article on the page to detect when it changes
        const firstArticleBefore = await page.evaluate(() => {
            const rows = document.querySelectorAll('tr, [role="row"]');
            for (const row of rows) {
                const match = row.innerText.match(/[A-Z]{2}\d{9}[A-Z]{2}/);
                if (match) return match[0];
            }
            return null;
        });
        console.log(`Current first article on page: ${firstArticleBefore || 'None'}`);

        // 2. Identify the pagination text container for secondary verification
        const pagTextLocator = page.locator('text=/\\d+-\\d+ of \\d+/').first();
        const hasPagText = await pagTextLocator.count() > 0;
        let oldPaginationText = "";

        if (hasPagText) {
            oldPaginationText = await pagTextLocator.innerText().catch(() => '');
            console.log(`Pagination text detected: "${oldPaginationText}"`);
        }

        // 3. PROXIMITY SEARCH: Find the button directly to the RIGHT of the "of" text
        let targetBtn = null;
        
        if (hasPagText) {
            console.log("Attempting proximity-based search (Right of text)...");
            // Find all buttons with icons, then pick the one with the smallest positive X-distance from the text
            const bestButtonInfo = await page.evaluate(() => {
                // Find all elements containing the text and pick the one with the smallest area (most specific)
                const textNodes = Array.from(document.querySelectorAll('*')).filter(el => {
                    const text = el.innerText || "";
                    return /\d+-\d+ of \d+/.test(text) && el.children.length < 5; // Heuristic for specific nodes
                });
                
                if (textNodes.length === 0) return null;
                
                // Sort by area (width * height) ascending to find the smallest container
                textNodes.sort((a, b) => {
                    const rectA = a.getBoundingClientRect();
                    const rectB = b.getBoundingClientRect();
                    return (rectA.width * rectA.height) - (rectB.width * rectB.height);
                });
                
                const targetTextNode = textNodes[0];
                const textRect = targetTextNode.getBoundingClientRect();
                
                // Find ALL potentially clickable elements
                const allElements = Array.from(document.querySelectorAll('button, [role="button"], a, i, svg, span, div'));
                const buttons = allElements.filter(b => {
                    const style = window.getComputedStyle(b);
                    const isClickable = style.cursor === 'pointer' || b.tagName === 'BUTTON' || b.tagName === 'A' || b.getAttribute('role') === 'button';
                    // Filter out very large elements or elements with no size
                    const rect = b.getBoundingClientRect();
                    return isClickable && rect.width > 0 && rect.width < 200 && rect.height > 0 && rect.height < 100;
                });
                
                // Find candidates to the right of the text or sibling elements
                const candidates = buttons.map(b => {
                    const rect = b.getBoundingClientRect();
                    return {
                        element: b,
                        distX: rect.left - textRect.right,
                        distY: Math.abs((rect.top + rect.height/2) - (textRect.top + textRect.height/2))
                    };
                }).filter(c => {
                    // Check if it's generally to the right and vertically aligned
                    return c.distX >= -10 && c.distX < 150 && c.distY < 40;
                });
                
                if (candidates.length === 0) return null;
                
                // The "Next" button is usually the second one (Previous, Next) or the last one
                // Sort by X position
                candidates.sort((a, b) => a.element.getBoundingClientRect().left - b.element.getBoundingClientRect().left);
                
                const bestMatch = candidates[candidates.length - 1]; // Take the rightmost one in the cluster
                
                const allIconButtons = Array.from(document.querySelectorAll('button, [role="button"], a, i, svg, span, div'));
                const index = allIconButtons.indexOf(bestMatch.element);
                return { index, html: bestMatch.element.outerHTML };
            });

            if (bestButtonInfo) {
                const allPotentials = page.locator('button, [role="button"], a, i, svg, span, div');
                targetBtn = allPotentials.nth(bestButtonInfo.index);
                console.log(`Success! Found proximity button. HTML snippet: ${bestButtonInfo.html.substring(0, 100)}...`);
            }
        }

        // Fallback strategies for different UI themes
        if (!targetBtn) {
            console.log("Next button not found via proximity, trying explicit selectors...");
            
            const nextSelectors = [
                '[aria-label*="Next" i]',
                '[title*="Next" i]',
                'button:has-text(">")',
                'button:has-text("›")',
                'a:has-text(">")',
                'a:has-text("›")',
                '[role="button"]:has-text(">")',
                'button:has-text("Next")',
                '.MuiTablePagination-actions button:last-child',
                '.pagination-next'
            ];

            for (const selector of nextSelectors) {
                const loc = page.locator(selector).last();
                if (await loc.count() > 0 && !(await loc.isDisabled())) {
                    targetBtn = loc;
                    console.log(`Found Next button via selector: ${selector}`);
                    break;
                }
            }

            if (!targetBtn) {
                // Last ditch effort: find any button with a right-chevron SVG path
                const iconNext = page.locator('button, [role="button"]').filter({ 
                    has: page.locator('svg path[d*="M10 6L8.59 7.41"], svg path[d*="M15.41 16.59"], svg path[d*="M8.59 16.59"], svg path[d*="M12 4l-1.41 1.41"]') 
                }).last();
                
                if (await iconNext.count() > 0 && !(await iconNext.isDisabled())) {
                    targetBtn = iconNext;
                    console.log("Found Next button via SVG path match.");
                }
            }
        }

        let clickedNext = false;
        if (targetBtn) {
            // [NEW] VISUAL DEBUGGING: Highlight the button in RED so you can see it!
            await targetBtn.evaluate(node => {
                node.style.border = '5px solid red';
                node.style.backgroundColor = 'yellow';
                node.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }).catch(() => null);
            
            await page.waitForTimeout(1000); // 1 second for the user to see the highlight

            const isBtnDisabled = await targetBtn.isDisabled().catch(() => false);
            const isMuiDisabled = await targetBtn.evaluate(node => node.classList.contains('Mui-disabled')).catch(() => false);
            const isAriaDisabled = (await targetBtn.getAttribute('aria-disabled')) === 'true';
            
            if (!isBtnDisabled && !isMuiDisabled && !isAriaDisabled) {
                console.log("Condition met. Clicking the highlighted button...");
                await targetBtn.click({ force: true, timeout: 5000 }).catch(err => console.log(`Click failed: ${err.message}`));
                
                // Robust Wait for page change
                try {
                    console.log("Waiting for data refresh...");
                    await page.waitForFunction(
                        (oldArticle, oldText) => {
                            const body = document.body.innerText;
                            const currentMatch = body.match(/[A-Z]{2}\d{9}[A-Z]{2}/);
                            const currentArticle = currentMatch ? currentMatch[0] : null;
                            const currentPagText = (document.body.innerText.match(/\d+-\d+ of \d+/) || [""])[0];
                            return (currentArticle && currentArticle !== oldArticle) || (currentPagText && currentPagText !== oldText);
                        },
                        firstArticleBefore,
                        oldPaginationText,
                        { timeout: 20000 }
                    );
                    await page.waitForTimeout(2000); // Extra stability wait
                    console.log("Success: Page transition confirmed.");
                } catch(e) {
                    console.log("Timeout waiting for change. Proceeding anyway.");
                }
                
                pageNumber++;
                clickedNext = true;
            } else {
                console.log("Highlighted button is DISABLED (Final page).");
            }
        } else {
            console.log("CRITICAL ERROR: No Next button found near pagination text.");
        }
        
        if (!clickedNext) {
            hasNextPage = false; 
        }
    }

    // Create the final report for Articles
    const reportPath = path.join(downloadDir, 'tracking_report.txt');
    const reportContent = [
        `INDIA POST ARTICLE TRACKING REPORT`,
        `==================================`,
        `Timestamp: ${new Date().toLocaleString()}`,
        `Total Articles Tracked: ${totalItemsTracked}`,
        `Successfully Generated PDFs: ${successfulArticleDownloads}`,
        `Failed/Missing: ${totalItemsTracked - successfulArticleDownloads}`,
        ``,
        `FAILURE DETAILS (If Any)`,
        `-----------------------`,
        failureLogs.length > 0 ? failureLogs.join('\n') : 'No failures recorded. All article PDFs generated successfully!'
    ].join('\n');
    
    fs.writeFileSync(reportPath, reportContent);
    console.log(`Report generated at: ${reportPath}`);

    console.log("Zipping the article PDFs...");
    const zip = new AdmZip();
    zip.addLocalFolder(downloadDir);
    const zipPath = path.join(jobDir, `bulk_articles_${timestamp}.zip`);
    zip.writeZip(zipPath);

    return { zipPath, cleanupDirs: [downloadDir, jobDir] };
  } catch (error) {
    console.error("Article scraping error: ", error);
    throw error;
  } finally {
    await browserContext.close().catch(() => {});
  }
}

module.exports = { scrapeArticles };
